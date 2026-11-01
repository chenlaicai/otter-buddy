---
id: F20261101depup
title: 统一升级依赖版本（2026-11-01 批次）
doc_type: feature

summary: |
  统一升级依赖版本，关闭 Dependabot 自动创建的 PR（#1675–#1680 共 6 个），按照研发流程创建统一的依赖升级 PR。
  pi-coding-agent 升级因 SDK 补丁守卫（F20261028egitx）不兼容 1.4.0 而暂缓，同伴包以 overrides 锁定 1.1.0。

causal_links:
  from:
    - F20261022deps

change_type: feature-update
tags: [deps, dependencies, upgrade, dependabot]
modules:
  - package-lock.json
capability_test: "n/a: 纯依赖升级，无 LLM 参与行为"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# F20261101depup: 统一升级依赖版本（2026-11-01 批次）

## 背景与需求

### 问题描述
Dependabot 开了 6 条依赖升级 PR（#1675–#1680）。按既定流程（PR #419 决策：只处理 Dependabot 信号），
关闭全部 bot PR，在 worktree 内做统一升级，创建单条统一升级 PR 呈搭档终审。

### 升级清单（实做 5 包）
| 包 | from → to | 来源 PR | 说明 |
|---|---|---|---|
| @earendil-works/pi-ai | 1.3.0 → 1.4.0 | #1680 | minor |
| rolldown | 1.2.14 → 1.2.15 | #1679 | **保留 #1606 精确 pin 语义**（`1.2.15` 无 caret） |
| unist-util-visit | 5.1.0 → 5.2.0 | #1678 | minor |
| typescript-eslint | 8.71.2 → 8.72.0 | #1676 | patch |
| tsc-alias | 1.9.8 → 1.9.9 | #1675 | patch |
| ~~@earendil-works/pi-coding-agent~~ | ~~1.1.0 → 1.4.0~~ | #1677 | **暂缓**，见下 |

### pi-coding-agent 暂缓原因（#1677 单独处置）
- `scripts/check-sdk-patch.mjs`（F20261028egitx fail-closed 守卫）硬编码期望 `pi-coding-agent@1.1.0`
  的 `baseToolsOverride` 补丁；升级 1.4.0 后守卫必红，且守卫报错明示「升级 SDK 时必须复核补丁与真实装配测试」。
- `patches/@earendil-works+pi-coding-agent+1.1.0.patch` 需对 1.4.0 重新复核/重生成 + 装配测试，
  属守卫类改动（R8 高杠杆路径），超出本批次 lockfile 小改动范畴。
- 实证：1.4.0 下补丁虽可应用，但 npm install 的 postinstall 阶段并未自动应用（grep 符号=0），
  需人工 `npx patch-package` 且守卫仍红（版本不匹配）。

### pi-codemode 破坏事件与 overrides 锁定
升级 pi-ai 1.4.0 时，npm 重算依赖树把 pi-coding-agent 1.1.0 的 5 个同伴包
（chord / pi-agent-core / **pi-codemode** / pi-mcp / pi-tui）经 caret `^1.1.0` 顺手刷到 1.4.0——
**不在 Dependabot 信号清单内的计划外升级**。后果：pi-codemode 1.4.0 删除了
`MCP_TYPESCRIPT_PREAMBLE` 导出，pi-coding-agent 1.1.0 引用之，8 个测试文件报
`SyntaxError: does not provide an export named 'MCP_TYPESCRIPT_PREAMBLE'`（实测 70 文件失败、9 测试失败）。

处置：package.json `overrides` 将 5 个同伴包锁回 `1.1.0`（npm 以嵌套 node_modules 布局安置，
解析等价）。此锁与 pi-coding-agent 1.1.0 的 pin 配套，待 #1677 专项升级时一并退役。

## 验证（全绿）
- `node scripts/check-sdk-patch.mjs`：✅ baseToolsOverride forwarding verified @1.1.0
- `npm run build`：✅ exit 0
- `npm run lint`：✅ exit 0
- `npm test`：✅ **422 文件 / 5590 测试全部通过**（overrides 锁定前：70 文件失败 / 9 测试失败）

## #1606 rolldown pin 退役提请
- 上游 `@rolldown/binding-freebsd-x64@1.2.15` 已发布（npm registry 实测，10-22 残缺问题已修复），
  lockfile 含全部 15 条 binding 条目（freebsd 在列），Linux CI `npm ci` 不会再报锁不同步。
- 本批已将 pin 升至 1.2.15（保留精确 pin 语义）；**是否放宽为 caret 或移除 pin，提请搭档在合入时定夺**。
- rolldown registry 最新为 1.2.16，按 PR #419 决策不追非 Dependabot 信号，本批不升。

## Dependabot PR 处置
#1675–#1680 已全部关闭（关闭评论注明并入统一 PR）；分支由 Dependabot 自动删除（GitHub 端已确认无残留）。
