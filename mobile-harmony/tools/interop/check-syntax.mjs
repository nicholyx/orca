/*
 * Static checks for the ArkTS sources.
 *
 * DevEco Studio is not installed in this repo's development environment, so the
 * real ArkTS compiler cannot run here. This script is the closest substitute and
 * covers the two classes of mistake that would otherwise only surface on a
 * device:
 *
 *  1. Syntax errors — every `.ets` file is parsed with esbuild's TypeScript
 *     loader (ArkTS is a TS subset), so a stray brace or bad type annotation
 *     fails here rather than in the IDE.
 *
 *  2. ArkTS subset violations — the dialect rejects several constructs that are
 *     legal TypeScript. Each is checked by pattern and reported with the line,
 *     so the fix is mechanical.
 *
 * This is a guard rail, not a compiler: it cannot see type errors that depend on
 * the ArkUI runtime's declarations. It exists to make the "obviously wrong"
 * classes impossible to ship.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const sourceRoot = join(root, 'entry/src/main/ets')
const oracleModules = process.env.ORACLE_NODE_MODULES
if (!oracleModules) {
  console.error('ORACLE_NODE_MODULES is not set — see build.mjs for how to install the oracles')
  process.exit(2)
}

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

function collectEts(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...collectEts(full))
    } else if (name.endsWith('.ets')) {
      out.push(full)
    }
  }
  return out
}

/**
 * Each rule is a regex over the source with comments stripped, plus a plain
 * explanation of the fix. Comments are removed first so prose *about* a banned
 * construct is not itself flagged.
 *
 * Rules are deliberately high-signal only. A pattern cannot tell whether an
 * object literal's type is inferrable, and ArkUI's own builder options
 * (`.padding({ ... })`) are typed by the framework — so "untyped object literal"
 * is expressed as the case that is always wrong: a declaration with no
 * annotation at all.
 */
const RULES = [
  {
    name: 'any type',
    pattern: /(:\s*any\b|<any>|\bas\s+any\b|\bany\[\])/,
    hint: 'ArkTS has no `any`. Use a concrete type, `Object`, or `Record<string, Object>`.'
  },
  {
    name: 'unknown type',
    pattern: /(:\s*unknown\b|\bas\s+unknown\b)/,
    hint: 'ArkTS has no `unknown`. Use `Object` and narrow with the JsonValue helpers.'
  },
  {
    name: 'var declaration',
    pattern: /(^|[^\w.])var\s+[A-Za-z_$]/,
    hint: 'Use `let` or `const`.'
  },
  {
    name: 'destructuring declaration',
    pattern: /(const|let)\s*[{[][^}\]]*[}\]]\s*=/,
    hint: 'ArkTS rejects destructuring. Assign fields one at a time.'
  },
  {
    name: 'function expression',
    pattern: /=\s*function\s*\(/,
    hint: 'Use an arrow function.'
  },
  {
    name: 'unannotated object literal',
    pattern: /(const|let)\s+[A-Za-z_$][\w$]*\s*=\s*\{\s*$/,
    hint: 'ArkTS cannot infer a bare object literal. Declare an interface and annotate the variable.'
  },
  {
    name: 'eval',
    pattern: /(^|[^\w.])eval\s*\(/,
    hint: 'ArkTS forbids `eval`.'
  },
  {
    name: 'delete operator',
    pattern: /(^|[^\w.])delete\s+[A-Za-z_$]/,
    hint: 'ArkTS forbids the `delete` operator. Model absence explicitly.'
  }
]

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

/**
 * ArkUI's `struct` / decorator DSL is not TypeScript, so esbuild cannot parse a
 * UI file. Those are checked for balanced delimiters instead — enough to catch a
 * truncated or mis-nested block, which is the realistic editing mistake.
 */
function declaresUi(source) {
  return /(^|\n)\s*(@Entry|@Component|@Reusable|struct\s+[A-Za-z_$])/.test(source)
}

function checkBalanced(rel, source) {
  const stripped = stripComments(source).replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, '""')
  const pairs = { '{': '}', '(': ')', '[': ']' }
  const closers = { '}': '{', ')': '(', ']': '[' }
  const stack = []
  for (const char of stripped) {
    if (pairs[char]) {
      stack.push(char)
    } else if (closers[char]) {
      if (stack.pop() !== closers[char]) return `${rel}: unbalanced "${char}"`
    }
  }
  if (stack.length !== 0) return `${rel}: ${stack.length} unclosed "${stack[stack.length - 1]}"`
  return null
}

const files = collectEts(sourceRoot).sort()
let syntaxFailures = 0
let ruleFailures = 0
let uiFiles = 0

/** All import specifiers in a file, with the ones that are relative. */
function importSpecifiers(source) {
  const out = []
  const re = /(?:from\s+|import\s*)['"]([^'"]+)['"]/g
  let match
  while ((match = re.exec(source)) !== null) out.push(match[1])
  return out
}

function resolves(spec, fromFile) {
  const base = resolve(dirname(fromFile), spec)
  return ['', '.ets', '.ts', '/index.ets', '/index.ts'].some((ext) => existsSync(base + ext))
}

for (const file of files) {
  const rel = relative(root, file)
  // Path used for the layer rules: relative to the ets root, so `core/…`
  // actually matches rather than the project-level path.
  const relEts = relative(sourceRoot, file)
  const source = readFileSync(file, 'utf8')

  // --- import resolution ---------------------------------------------------
  // A relative import that does not resolve is a guaranteed build failure, and
  // nothing else here would catch it: the ArkTS compiler is not available, and
  // a harness only follows the imports it happens to need.
  for (const spec of importSpecifiers(source)) {
    if (spec.startsWith('.')) {
      if (!resolves(spec, file)) {
        syntaxFailures++
        console.error(`IMPORT  ${rel}`)
        console.error(`        cannot resolve '${spec}'`)
      }
      continue
    }
    // --- architecture rule -------------------------------------------------
    // core/ must stay platform-free: it is what lets the protocol stack run on
    // the host for verification. Enforced mechanically so it cannot rot.
    if (relEts.startsWith('core/') && /^@(kit|ohos)[./]/.test(spec)) {
      ruleFailures++
      console.error(`LAYER   ${rel}`)
      console.error(`        core/ must not import the platform: '${spec}'`)
      console.error(`        → move the adapter into platform/ and inject it behind an interface`)
    }
    if (relEts.startsWith('core/') && /(^|\/)\.\.\/platform\//.test(spec)) {
      ruleFailures++
      console.error(`LAYER   ${rel}`)
      console.error(`        core/ must not import platform/: '${spec}'`)
    }
  }

  if (declaresUi(source)) {
    uiFiles++
    const problem = checkBalanced(rel, source)
    if (problem !== null) {
      syntaxFailures++
      console.error(`SYNTAX  ${problem}`)
    }
  } else {
    try {
      esbuild.transformSync(source, { loader: 'ts', target: 'es2017' })
    } catch (error) {
      syntaxFailures++
      console.error(`SYNTAX  ${rel}`)
      console.error(`        ${String(error.message ?? error).split('\n').join('\n        ')}`)
    }
  }

  // Rule scanning is line-based so every hit gets a usable line number.
  const lines = stripComments(source).split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim().length === 0) continue
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        ruleFailures++
        console.error(`RULE    ${rel}:${index + 1}  ${rule.name}`)
        console.error(`        ${line.trim()}`)
        console.error(`        → ${rule.hint}`)
      }
    }
  }
}

console.log(`\n${'─'.repeat(64)}`)
console.log(`scanned ${files.length} .ets files (${uiFiles} ArkUI, ${files.length - uiFiles} plain)`)
if (syntaxFailures === 0 && ruleFailures === 0) {
  console.log('PASS  imports resolve, no syntax errors, no ArkTS subset or layer violations')
  process.exit(0)
}
console.error(`FAIL  ${syntaxFailures} import/syntax problem(s), ${ruleFailures} rule violation(s)`)
process.exit(1)
