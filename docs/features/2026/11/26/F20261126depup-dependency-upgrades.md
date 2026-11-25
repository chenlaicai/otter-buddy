---
id: F20261126depup
title: 统一升级依赖版本（2026-11-26 批次）
doc_type: feature

summary: |
  统一处理 6 个 Dependabot PR（#2029–#2034），实做 5 个包的补丁/次版本升级。
  @earendil-works/chord 1.6.0 因 pi-* 1.5.0 版本锁及多运行时副本风险暂缓。

causal_links:
  from:
    - F20261124depup

change_type: feature-update
tags: [deps, dependencies, upgrade, dependabot]
modules:
  - package.json
  - package-lock.json
capability_test: "n/a: 纯依赖升级，无 LLM 参与行为"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
created_at: 2026-11-26

intent:
  problem: "Dependabot 6 个依赖 PR 零散堆积，需要收敛为可验证的统一升级"
  expected_effect: "低耦合依赖统一升级并通过全量验证；chord 的 pi-* 版本耦合显式留痕，等待专项升级"
  verify_by:
    type: behavior_check
---

# F20261126depup: 统一升级依赖版本（2026-11-26 批次）

## 背景与需求

Dependabot 开了 6 条依赖升级 PR。按 PR #419 确立的既定流程，本任务只响应 Dependabot 信号，不做全量 `npm update`；关闭 bot PR 后在独立 worktree 内收敛升级。

| PR | 包 | from → to | 处置 |
|---|---|---|---|
| #2029 | eslint | 10.14.0 → 10.15.0 | 升级 |
| #2030 | vitest | 5.1.0 → 5.1.1 | 升级 |
| #2031 | croner | 11.0.0 → 11.0.1 | 升级 |
| #2032 | hono | 4.13.18 → 4.13.19 | 升级 |
| #2033 | @earendil-works/chord | 1.5.0 → 1.6.0 | 暂缓 |
| #2034 | @hono/node-server | 2.1.7 → 2.1.11 | 升级 |

## 升级清单（实做 5 包）

| 包 | package.json from → to | 类型 |
|---|---|---|
| @hono/node-server | ^2.1.7 → ^2.1.11 | patch |
| hono | ^4.13.18 → ^4.13.19 | patch |
| croner | ^11.0.0 → ^11.0.1 | patch |
| vitest | ^5.1.0 → ^5.1.1 | patch |
| eslint | ^10.14.0 → ^10.15.0 | minor |

变更仅含 `package.json`、`package-lock.json` 与本文档，无源码改动。lockfile 同时刷新上述包直接要求的传递依赖（如 eslint 的 config-array/minimatch、vitest 的配套包）；未做计划外全量升级。

## 暂缓：@earendil-works/chord 1.6.0

- `package.json` 将直接依赖 `@earendil-works/chord` 固定为 1.5.0，同时通过 `overrides` 将 `pi-coding-agent` 的 chord 及 4 个同伴包固定为 1.5.0；`pi-durable` 也仍为 1.5.0。
- Dependabot #2033 的原始 diff 会把根级 chord 升到 1.6.0，同时在 `pi-durable` 下保留 chord 1.5.0，并让 `pi-coding-agent` 继续受 1.5.0 override 约束，形成多套 chord 运行时副本。
- 本仓 session、connector、execution 路径直接共享 `chord/context` 的 `BACKGROUND_CONTEXT` / `Context`。跨版本副本的上下文一致性需要与 pi-* 系列一起专项验证；不能仅以编译和单包测试通过代替该验证。
- 因此本批保持 chord 1.5.0，不修改 overrides。Dependabot 后续会重新提供升级信号，届时按 pi-* 配套升级处理。

## 验证

- `npm ci`：PASS，干净安装 562 packages，patch-package / hooks 准备完成。
- `npm run build`：PASS；SDK patch 检查、TypeScript、tsc-alias、connector closure 与连接器打包全部通过。
- `npm test`：PASS（pretest 自动执行 `npm run lint`）；**542 个测试文件 / 6935 条测试全部通过**，耗时 114.34s。
- `npm ls @hono/node-server hono croner vitest eslint @earendil-works/chord --depth=0`：实装版本分别为 2.1.11 / 4.13.19 / 11.0.1 / 5.1.1 / 10.15.0 / 1.5.0，符合本批范围。

## Dependabot PR 处置

#2029–#2034 已全部关闭，关闭评论统一注明「将合并到统一的依赖升级 PR」；对应 6 条 Dependabot 分支均已删除。#2033 对应包暂缓，后续由 Dependabot 重新提信号。

## 风险与回滚

- 风险：eslint 次版本及其 minimatch 主版本传递升级可能影响 lint 行为；已由全量 lint 与 6935 条测试覆盖。
- 残余风险：chord 1.6.0 未纳入本批，相关安全/功能修复需等待 pi-* 专项升级。
- 回滚：还原本 PR 的 `package.json` 与 `package-lock.json` 后执行 `npm ci`；无源码、数据或外部状态迁移。
