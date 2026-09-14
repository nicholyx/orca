---
name: feature-delivery-loop
description: Orca 的功能交付闭环——开发、全量回归（含端到端）、CI 打包 artifact、维护者人工测试、确认后才打 release。当要在本仓库开发新功能、修缺陷后出包、有人说「继续走交付流程」「打个包给我人工测试」「测试都过了就发 release」时使用。
---

# 功能交付闭环（feature-delivery-loop）

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
