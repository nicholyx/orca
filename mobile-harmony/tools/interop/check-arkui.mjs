/*
 * Structural checks for the ArkUI layer.
 *
 * The ArkTS compiler is not available in this environment, and `check-syntax`
 * cannot parse the `struct` DSL at all. That leaves a gap: a page that is never
 * registered, a `struct` with no `build()`, a `$string:` that does not exist, or
 * a `ForEach` with no key generator all compile-and-run differently than they
 * read, and most of them surface as a blank screen on a device.
 *
 * This script closes that gap with the checks that are decidable from the source
 * and the resource files. It is not a compiler: it cannot verify types, layout,
 * or that a builder is actually reachable at runtime.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const project = resolve(here, '..', '..')
const moduleRoot = join(project, 'entry/src/main')
const etsRoot = join(moduleRoot, 'ets')

let failures = 0
let checks = 0

function fail(label, detail) {
  failures++
  console.error(`FAIL  ${label}`)
  if (detail) console.error(`      ${detail}`)
}

function ok(label) {
  checks++
  void label
}

/** JSON with comments and trailing commas, as the json5 config files use. */
function parseJsonc(text) {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'])\/\/[^\n]*/g, '$1')
    .replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(stripped)
}

function collect(dir, filter, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) collect(full, filter, out)
    else if (filter(name)) out.push(full)
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. Pages are registered, and registered pages exist
// ---------------------------------------------------------------------------

const pagesProfile = join(moduleRoot, 'resources/base/profile/main_pages.json')
if (!existsSync(pagesProfile)) {
  fail('main_pages.json is missing', pagesProfile)
  process.exit(1)
}

const registeredPages = parseJsonc(readFileSync(pagesProfile, 'utf8')).src ?? []
const pageFiles = collect(join(etsRoot, 'pages'), (name) => name.endsWith('.ets'))

for (const page of registeredPages) {
  const file = join(etsRoot, `${page}.ets`)
  if (!existsSync(file)) {
    fail(`main_pages.json registers a page that does not exist`, `${page} → ${file}`)
  } else {
    ok(`page ${page}`)
  }
}

for (const file of pageFiles) {
  const rel = relative(etsRoot, file).replace(/\.ets$/, '')
  if (!registeredPages.includes(rel)) {
    fail(`a page is not registered in main_pages.json, so nothing can route to it`, rel)
  } else {
    ok(`registration ${rel}`)
  }
}

// ---------------------------------------------------------------------------
// 2. Every struct has a build(), and each page has exactly one @Entry
// ---------------------------------------------------------------------------

const uiFiles = collect(etsRoot, (name) => name.endsWith('.ets')).filter((file) => {
  const source = readFileSync(file, 'utf8')
  return /(^|\n)\s*(@Entry|@Component|@Reusable|struct\s)/.test(source)
})

for (const file of uiFiles) {
  const rel = relative(etsRoot, file)
  const source = readFileSync(file, 'utf8')

  // struct Name { ... } — find each declaration and its brace-balanced body.
  const structRe = /(?:@\w+(?:\([^)]*\))?\s*)*struct\s+([A-Za-z_$][\w$]*)/g
  let match
  const structs = []
  while ((match = structRe.exec(source)) !== null) {
    structs.push({ name: match[1], at: match.index })
  }

  if (structs.length === 0) {
    fail(`ArkUI file declares no struct`, rel)
    continue
  }

  for (const entry of structs) {
    const bodyStart = source.indexOf('{', entry.at)
    let depth = 0
    let end = bodyStart
    for (let index = bodyStart; index < source.length; index++) {
      if (source[index] === '{') depth++
      else if (source[index] === '}') {
        depth--
        if (depth === 0) {
          end = index
          break
        }
      }
    }
    const body = source.slice(bodyStart, end)
    if (!/(^|\n)\s*build\s*\(\s*\)\s*\{/.test(body)) {
      fail(`struct ${entry.name} has no build() method`, rel)
    } else {
      ok(`build() ${rel}#${entry.name}`)
    }
  }

  const entryCount = (source.match(/(^|\n)\s*@Entry\b/g) ?? []).length
  if (rel.startsWith('pages/') && entryCount !== 1) {
    fail(`a page must have exactly one @Entry (found ${entryCount})`, rel)
  }
  if (!rel.startsWith('pages/') && entryCount > 0) {
    fail(`@Entry outside pages/ will never be routed to`, rel)
  }
}

// ---------------------------------------------------------------------------
// 3. Resource references resolve
// ---------------------------------------------------------------------------

function buildResourceIndex() {
  const index = { string: new Set(), media: new Set(), color: new Set(), profile: new Set() }
  const roots = [
    join(moduleRoot, 'resources'),
    join(project, 'AppScope/resources')
  ]
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const locale of readdirSync(root)) {
      const elementDir = join(root, locale, 'element')
      for (const name of ['string.json', 'color.json']) {
        const file = join(elementDir, name)
        if (!existsSync(file)) continue
        const parsed = parseJsonc(readFileSync(file, 'utf8'))
        const bucket = name.startsWith('string') ? 'string' : 'color'
        for (const item of parsed[bucket] ?? []) index[bucket].add(item.name)
      }
      const mediaDir = join(root, locale, 'media')
      if (existsSync(mediaDir)) {
        for (const name of readdirSync(mediaDir)) index.media.add(name.replace(/\.[^.]+$/, ''))
      }
      const profileDir = join(root, locale, 'profile')
      if (existsSync(profileDir)) {
        for (const name of readdirSync(profileDir)) index.profile.add(name.replace(/\.json$/, ''))
      }
    }
  }
  return index
}

const resources = buildResourceIndex()

const configFiles = [
  join(project, 'AppScope/app.json5'),
  join(moduleRoot, 'module.json5'),
  join(moduleRoot, 'resources/base/profile/backup_config.json')
].filter((file) => existsSync(file))

for (const file of configFiles) {
  const source = readFileSync(file, 'utf8')
  const refRe = /\$(string|media|color|profile):([A-Za-z0-9_.]+)/g
  let match
  while ((match = refRe.exec(source)) !== null) {
    const [, kind, name] = match
    if (!resources[kind].has(name)) {
      fail(
        `a config references a ${kind} resource that does not exist`,
        `${relative(project, file)} → $${kind}:${name}`
      )
    } else {
      ok(`resource ${kind}:${name}`)
    }
  }
  // srcEntry must point at a real file.
  const entryRe = /"srcEntry"\s*:\s*"([^"]+)"/g
  while ((match = entryRe.exec(source)) !== null) {
    const target = join(moduleRoot, match[1].replace(/^\.\//, ''))
    if (!existsSync(target)) {
      fail(`module.json5 srcEntry does not exist`, `${match[1]} → ${target}`)
    } else {
      ok(`srcEntry ${match[1]}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 4. UI references imported from views/ actually exist
// ---------------------------------------------------------------------------

for (const file of uiFiles) {
  const rel = relative(etsRoot, file)
  const source = readFileSync(file, 'utf8')
  const importRe = /import\s*\{([^}]+)\}\s*from\s*'([^']*views\/[^']+)'/g
  let match
  while ((match = importRe.exec(source)) !== null) {
    const names = match[1]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
    const spec = match[2]
    const target = resolve(dirname(file), `${spec}.ets`)
    if (!existsSync(target)) {
      fail(`a view import does not resolve`, `${rel} → ${spec}`)
      continue
    }
    const targetSource = readFileSync(target, 'utf8')
    for (const name of names) {
      if (!new RegExp(`export\\s+struct\\s+${name}\\b`).test(targetSource)) {
        fail(`an imported view is not exported by its module`, `${rel} imports ${name} from ${spec}`)
      } else {
        ok(`view ${name}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 5. ForEach needs a key generator, and Navigation needs a destination builder
// ---------------------------------------------------------------------------

/** Counts top-level comma-separated arguments of a call, starting at its paren. */
function countArguments(source, openParen) {
  let depth = 0
  let count = 1
  for (let index = openParen; index < source.length; index++) {
    const char = source[index]
    if (char === '(' || char === '[' || char === '{') depth++
    else if (char === ')' || char === ']' || char === '}') {
      depth--
      if (depth === 0) return source.slice(openParen + 1, index).trim() === '' ? 0 : count
    } else if (char === ',' && depth === 1) count++
  }
  return count
}

for (const file of uiFiles) {
  const rel = relative(etsRoot, file)
  const source = readFileSync(file, 'utf8')

  const forEachRe = /ForEach\s*\(/g
  let match
  while ((match = forEachRe.exec(source)) !== null) {
    const open = source.indexOf('(', match.index)
    const args = countArguments(source, open)
    if (args < 3) {
      fail(
        `ForEach without a key generator (found ${args} arguments)`,
        `${rel}:${source.slice(0, match.index).split('\n').length} — without it ArkUI matches rows by index and reuses the wrong ones`
      )
    } else {
      ok(`ForEach ${rel}`)
    }
  }

  if (/NavDestination\s*\(/.test(source) && !/Navigation\s*\(/.test(source)) {
    fail(`NavDestination used outside a Navigation`, rel)
  }

  // @State must be mutable; ArkTS rejects a readonly state field.
  const readonlyState = /@State\s+(?:readonly\s+|\w+\s+readonly\s+)/
  if (readonlyState.test(source)) {
    fail(`@State field declared readonly`, rel)
  }
}

// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(64)}`)
console.log(`checked ${uiFiles.length} ArkUI files, ${registeredPages.length} registered page(s)`)
if (failures === 0) {
  console.log(`PASS  ${checks} structural checks — pages, structs, resources and ForEach keys are consistent`)
  process.exit(0)
}
console.error(`FAIL  ${failures} structural problem(s)`)
process.exit(1)
