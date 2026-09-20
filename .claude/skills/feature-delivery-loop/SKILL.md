---
name: feature-delivery-loop
description: Orca 的功能交付闭环——开发、全量回归（含端到端）、CI 打包 artifact、维护者人工测试、确认后才打 release。当要在本仓库开发新功能、修缺陷后出包、有人说「继续走交付流程」「打个包给我人工测试」「测试都过了就发 release」时使用。
---

# 功能交付闭环（feature-delivery-loop）

> 规范的单一事实来源已沉淀进 Trellis（任何平台/会话自动注入）：
> `.trellis/spec/maintenance/github-workflow.md`（Issue/PR/commit 规范）与
> `.trellis/spec/maintenance/delivery-gate.md`（交付门禁与 release 条件）。
> 本 skill 保留触发条件与操作视角；两边如有出入，以 spec 为准。

本仓库（fork `nicholyx/orca`，上游 `stablyai/orca`）按真实开源项目的方式交付功能：
**Issue → 分批 PR → CI 全量回归 → CI 打包 artifact → 维护者人工测试 → 确认后 release**。
参考实现：HarmonyOS 移动端（`mobile-harmony/`，Epic Issue #1，PR #2–#8）。

**核心闭环**：`规划（Issue）→ 实现（分批 PR）→ 自动验证（CI 回归）→ 打包（artifact）→
人工测试（维护者）→ 发布（release，仅在人工确认后）`。

全自动阶段的产物**只进 artifact，不进 release**——release 是人工测试通过后的显式动作，
不是流水线的自动终点。

## 一、规划

1. 一个主题一个 Epic Issue：背景（引用真实痛点）、期望（验收标准 checkbox）、
   范围与非目标、实施方式（分层拆 PR 的顺序）。
2. fork 仓库默认关闭 Issues，先 `gh api -X PATCH repos/nicholyx/orca -f has_issues=true`。
3. 每个 PR 引用 `Part of #N`；关闭 Epic 的那个 PR 用 `Closes #N`。

## 二、实现：分批 PR

- **一个功能一个 PR，完成一个小功能就提交一下**。自底向上拆（如鸿蒙端：
  骨架 → core 基础层 → core 业务核心 → transport/platform → 应用层 → 验证管线 → CI），
  每步 main 保持自洽。
- 分支名 `feat/*`、`fix/*`、`docs/*`、`ci/*`、`test/*`；从最新 `origin/main` 切，
  不从上一个未合并的分支叠（每个 PR 独立、diff 干净）。
- 提交信息遵循 Conventional Commits，标题即 squash 后的提交信息；正文写**为什么**。
- PR 正文结构：为什么 → 做了什么 → 关键取舍（含被否掉的方案）→ 测试策略。
- PR/Issue 正文写进临时文件（`--body-file /tmp/xxx.md`），不用嵌套 heredoc——
  heredoc 嵌套会静默丢正文。

## 三、自动验证：测试全绿才出包

- **门禁 = 全量回归，不是新增测试**。鸿蒙端是
  `mobile-harmony/tools/interop/run-interop.sh`（2337 断言 + ArkTS/ArkUI 静态检查，
  本地跑 `ORACLE_NODE_MODULES=<oracle 目录> ./run-interop.sh`）。
- CI（`.github/workflows/mobile-harmony.yml`）两个 job 串联：`verify`（全量回归）
  → `build-hap`（`needs: verify`）。verify 红则不出包。
- 端到端测试是必选项：对端必须是**仓库自身的生产代码**（鸿蒙端用
  `DesktopMobileE2EEV2Session` 等），不是 mock 的影子实现。
- 本地跑过 ≠ CI 绿。改动触碰共享代码时，等 CI 跑完再合并。

## 四、打包：artifact，不是 release

- HAP 由 `build-hap` job 产出，artifact 名 `orca-harmony-debug-unsigned`
  （签名配置后仍沿用该 job，产物即可安装）。`workflow_dispatch` 可随时按需出包。
- **未签名 HAP 装不上真机**（HarmonyOS NEXT 无侧载）。可安装包需要一次性配置：
  1. AppGallery Connect 建项目/应用（包名 `com.stably.orca.mobile.harmony`），
     申请**调试证书** `.cer` 与**调试 profile** `.p7b`；
  2. 生成 `.p12` 密钥库并记密码；
  3. 存 GitHub Secrets：`HARMONY_SIGNING_P12` / `HARMONY_SIGNING_CER` /
     `HARMONY_SIGNING_P7B`（base64）、`HARMONY_SIGNING_P12_PASSWORD`，
     可选 `HARMONY_SIGNING_KEY_ALIAS`（默认 `debugKey`）、
     `HARMONY_SIGNING_KEY_PASSWORD`（默认 = store 密码）；
  4. 重跑 workflow——签名步骤在 secrets 齐备时自动激活。
- 签名材料永不入库（`.signing/` 与证书文件已 gitignore）；secrets 缺任一项时
  回退未签名构建，不产出半签名包。

## 五、人工测试（维护者）

- 交付物：CI artifact + 运行摘要（含 verify 的断言汇总、安装说明）。
- 维护者人工验证的是自动测试覆盖不到的部分：真机 ArkUI 渲染/手势、ability 生命周期、
  真机 `@kit` 行为（Asset Store / preferences / ScanKit / webSocket close 行为）。
- 人工测试发现缺陷 → 走正常 `fix/*` PR → 全量回归 → 重出包，直到人工通过。

## 六、发布（仅在人工确认后）

维护者明确说「打包 release」才进入此阶段，之前一切产物停留在 artifact：

1. 归档 CHANGELOG（如引入）或按上游发布体系操作——**不动上游 `stablyai/orca`
   的 release 工作流**，fork 侧发布独立进行。
2. 签名 secrets 必须已配置（release 包必须是签名包）。
3. 建议路径：tag 触发的独立 release workflow（构建签名 HAP → `gh release create`
   附产物），仿照现有 `mobile-ios-release.yml` 的形态，作为独立 `ci/*` PR 实现。
4. 发布前用 `git ls-remote --tags origin <tag>` 确认 tag 不存在（防网络重试造成
   重复发布）。

## 七、上游同步（周期性，参考 #20）

fork 只维护鸿蒙端，但上游 `mobile/` 与 `src/` 的线协议是鸿蒙端镜像的对象。**漂移不会自己报错**——
两边静默发散，直到真机上表现为「连上了但什么都不显示」。

1. **先审计，再合并**。逐个核对鸿蒙端镜像的契约文件在上游新提交里的变化
   （E2EE v2 调度/分帧/会话/握手、配对 offer、终端分帧、RPC envelope、背压、重连、
   liveness、流取消形状、能力通告）。多数同步只有一两处真实差异。
2. **用 merge commit，绝不 squash**。squash 会切断上游祖先关系，之后每次同步都要重处理
   全部历史。`gh pr merge --merge`。验证：`git rev-list --count origin/main..upstream/main`
   必须为 **0**。
3. **合并与移植同一个 PR**。单独合并会留下 parity 断言失败的中断态，违反「每步 main 自洽」；
   上游同步在客户端跟进之前不算完成。
4. **让守卫断言驱动移植**：`verify-transport-interop` 的 parity 检查会精确报出差异
   （漏了哪几项、顺序如何）。先跑测试再改代码。
5. **移植前确认是否惰性**：新能力可能只是请求侧门禁（如 `agent.launch.v2` 只在
   `supportsAgentLaunch()` 读）或未订阅的流路径。惰性也要精确对齐——清单是逐字节契约，
   且能力宁可多广告（宿主看到缺失会降级，不是报错）。
6. **区分「我们的失败」与「继承的失败」**：fork 上 `track-community-pr` 需要上游 App 私钥、
   永远不可能通过；上游 main 自身也可能带着红的测试（比对文件是否与上游逐字节一致即可判定）。
   只修属于我们自己的那类（如 `static analysis`），并在 PR 里给出证据。
7. **同步 PR 的改动行门禁会报「伪影」**：`Enforce changed-code quality` 按 diff base 计算新增行，
   而**上游导入会让被合并文件的所有行都算作新增**，于是上游既有的 `as` 断言全被计成
   `N new finding(s) across M changed file(s)`（#23 是 19 / 2367）。上游自己不会把别的仓库
   合并进 main，所以永远遇不到——这是 **fork 特有的结构性伪影**。
   **不要改那些文件**：逐个改会让 fork 在完全不维护的文件上与上游分叉，今后每次同步都要
   重新解同一批冲突。正确做法是取证（`mobile-harmony/` 内 0 处；违规文件 `git rev-parse
   HEAD:<file>` 与 `upstream/main:<file>` 逐字节相同）并写进 PR 正文。
8. **移植时先问「现有断言会不会无论我怎么写都通过」**。#23 发现 parity 断言的 `onOverflow`
   回调不接受参数，只比较「触发几次」——**即使把 cap 标签全写反它也绿**。加了新行为却
   没补断言，等于没守卫。补完再做一次双向验证（改错 → 必须失败）。

## 硬规则（踩坑沉淀，任何时候优先）

- **fork 默认不注册 workflows**：新 workflow 只有 push 进默认分支后才会出现并运行；
  分支上永远不触发。合并 CI PR 本身的 push 事件即首次实测。
- **鸿蒙工具链有下载墙**（需开发者登录）：build-hap 跑在公开容器镜像
  `ghcr.io/dalongzhuazi/harmonyos-ci:api26`（command-line-tools 26.0.0.461 +
  HarmonyOS API 26 SDK，与工程 `modelVersion 26.0.0` 配套）。zip 类镜像
  （如 6.1.0.816）的 hvigor 只支持到 modelVersion 6.1.0，编不了 26 的工程。
  容器默认 shell 是 `sh`，job 必须设 `defaults: run: shell: bash`，否则
  `set -o pipefail` 第一步就死。
- **测试全绿才出包**（CI `needs` 链强制）；**全自动产物不进 release**；
  **release 必须人工确认后才打**。
- 端到端对端用生产代码；oracle 依赖装隔离 prefix，不碰仓库 `node_modules`。
- 凭证、签名材料、内网地址不进代码、不进 Issue/PR、不进日志。
- workflow 改完先过 `actionlint`；`run:` 多行脚本开头 `set -euo pipefail`；
  markdown 反引号别放在单引号 echo 里（SC2016），用 quoted heredoc 写摘要。
- 中文内容写完后全仓扫 U+FFFD（见 action-sync-images maintain-loop 同名规则）。

### lint 有两道门禁，本地都能复现（参考 #21）

装一份隔离 oxlint 即可得到秒级反馈（`npm install --prefix /tmp/oxlint-tool oxlint@<版本>`）：

1. **全仓 lint**：`oxlint` 用根 `.oxlintrc.json`。`max-lines` 对 `**/*.ts` 是 **300 行**
   （跳过空行与注释），`*.mjs` 是 600，`*.test.*` 是 800。超限只能**抽内聚单元**——
   AGENTS.md 同时禁止内联 `max-lines` 禁用与逐文件放宽。
2. **改动行 casting 门禁**：`node config/scripts/check-changed-code-quality.mjs` 用独立配置
   `config/oxlint-code-quality-casting.json`（`assertionStyle: never`），**只查改动行**。
   根配置允许 `as`，所以全仓 lint 绿了这道门禁仍可能红。**注意：拆分/移动代码会让旧断言的
   行变成「改动行」，从而被拦下**——这是好事，但要提前预期。

处理 `as` 断言的优先顺序：
- **能用仓库自己的收窄 helper 就消除它**：`mobile-harmony/entry/.../core/json/JsonValue.ets`
  的 `parseJsonRecord` / `asRecord` / `asString` / `asNumber` / `asStringArray`；
  仅需改类型时优先 `const x: T = value`（`JSON.parse` 返回 `any`，注解即可，无需断言）。
- 确实不可避时加行级豁免，且**必须与断言同一行**：
  `// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: <可验证的理由>`。
  `-next-line` 只覆盖紧接着的一行——跨行调用要把断言收在一行内，
  否则像 #21 那样 82/83 行的 `as never` 漏网。
- 反例警告：给「不别名」这类**身份断言**套复制型 accessor（如 `asStringArray`）会让断言恒真，
  这种地方必须保留引用并写明理由。

拆分/移动代码时的两个高频自伤（都由套件在运行时抓到，check-syntax 不做类型检查）：
抽出的函数**忘了 `export`**（lint 会报「已声明未使用」，运行时是 `(void 0) is not a function`）；
用了 helper **忘了加 import**（`X is not defined`）。改完先跑
`mobile-harmony/tools/interop/run-interop.sh`，再谈提交。
