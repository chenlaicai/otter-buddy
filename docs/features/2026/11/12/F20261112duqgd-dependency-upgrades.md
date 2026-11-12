---
id: F20261112duqgd
title: 统一升级依赖版本（2026-11-12 批次）
doc_type: feature

summary: |
  统一升级依赖版本，关闭 Dependabot 自动创建的 PR（#1768–#1774 共 7 个）。
  croner 10→11 主版本升级按纪律拆为独立 PR #1776（F20261105cronr），本 PR 仅含 6 包常规升级。

causal_links:
  from:
    - F20261101depup

change_type: feature-update
tags: [deps, dependencies, upgrade, dependabot]
modules:
  - package-lock.json
capability_test: "n/a: 纯依赖升级，无 LLM 参与行为"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
created_at: 2026-11-12

intent:
  problem: "Dependabot 7 个依赖 PR 零散堆积无人收敛，人工逐个审阅成本高且易漏安全补丁"
  expected_effect: "单批统一升级 PR 替代零散 PR：一次 CI 验证、一次回滚单元，Dependabot 待办清零"
  verify_by:
    type: behavior_check
---

# F20261112duqgd: 统一升级依赖版本（2026-11-12 批次）

## 背景与需求

Dependabot 开了 7 条依赖升级 PR（#1768–#1774）。按既定流程（PR #419 决策：只处理
Dependabot 信号），关闭全部 bot PR，在 worktree 内做统一升级，创建统一升级 PR 呈搭档终审。

## 批次拆分

- **PR 1（常规批）**：typescript-eslint / hono / eslint / @huggingface/transformers /
  @types/node / tsc-alias——patch/minor 升级，lockfile 小改动
- **PR 2（croner 主版本批）**：croner 10.0.1 → 11.0.0——主版本纪律：单独 PR + 警告标记

## 升级清单

### PR 1：常规批（6 包）
| 包 | from → to | 来源 PR | 类型 |
|---|---|---|---|
| typescript-eslint | 8.72.0 → 8.72.1 | #1768 | patch |
| hono | 4.13.13 → 4.13.16 | #1770 | patch |
| eslint | 10.13.0 → 10.14.0 | #1771 | minor |
| @huggingface/transformers | 4.3.0 → 4.3.2 | #1772 | patch |
| @types/node | 26.6.5 → 26.6.6 | #1773 | patch |
| tsc-alias | 1.9.9 → 1.9.10 | #1774 | patch |

注：@types/node Dependabot 从 26.6.5 起升，但 package.json 声明 `^26.6.4` 且上批
lockfile 已在 26.6.5——实际 lockfile 变更 26.6.5 → 26.6.6。

传递变更：semver 7.8.5 → 7.8.6（@typescript-eslint/typescript-estree 内嵌，随
typescript-eslint patch 正常浮动）。lockfile 净 87 行版本号变更、零新增条目——
无计划外升级（上批 pi-codemode 事故形态未重演）。

### PR 2：croner 主版本批
| 包 | from → to | 来源 PR | 类型 |
|---|---|---|---|
| croner | 10.0.1 → 11.0.0 | #1769 | **major** |

#### v11 破坏性变更评估（对照项目实际用法）

项目仅 `src/frameworks/scheduler/cron-parser.ts` 一处使用，API 面：
`new Cron(pattern, { timezone })`、`job.nextRun(ref?)`、`job.previousRuns(n, ref?)`。

v11 破坏性变更四条（官方 release notes）逐一对照：
| 破坏性变更 | 项目影响 |
|---|---|
| DST 语义对齐 Vixie cron（interval 任务在 fall-back 重复时段双跑；gap 内固定任务提前） | 低——DST 改动会影响解析返回值（nextRun/previousRuns 是调度器 expected/nextTrigger 的生产依据），但主时区 Asia/Shanghai 无 DST 无感；非 DST 时区的解析行为对齐 Vixie 属正向修复 |
| `startAt` 变为包含边界 | 无——未使用 startAt |
| `dayOffset` 语义修正 | 无——未使用 dayOffset |
| `previousRun()` 返回开始时间而非结束时间 | 无——项目用 `previousRuns()`（复数），且只用纯解析无执行 |

v11 附带修复与本项目相关：`previousRuns()` 对月份通配模式/闰日模式抛异常的修复——
对账逻辑（#814 getPrevTime）更稳。DST 修正对解析 API 在 DST 时区的 nextRun 结果
可能微调（interval 任务不再返回重复时段），属正确性修复方向。

测试覆盖：`tests/frameworks/scheduler/cron-parser.test.ts` 15 用例（timezone、
slot 归属、referenceTime、无效表达式），croner 11 下全绿（本 PR 验证记录）。

## 验证（两批同 worktree 基线分别执行）

### PR 1（常规批）
- `node scripts/check-sdk-patch.mjs`：✅ baseToolsOverride forwarding verified @1.1.0
  （注：worktree 首次 install 后 postinstall 未自动跑补丁，手动 `npx patch-package`
  后守卫绿——与上批 F20261101depup 现象一致，非本批引入）
- `npm run build`：✅ exit 0
- `npm run lint`：✅ exit 0
- `npm test`：5663/5668 通过，5 失败**与升级无关**（对照实验：同 5 个失败在未升级
  主仓复现；main 分支 CI 最近全绿）——
  - `generate-guard-replay.test.ts` 4 失败：脚本 UTC 日界（PR #1368 §3.3）vs 测试
    本地时区播种，Asia/Shanghai 凌晨 0-8 点窗口错位必挂（时间敏感缺陷，存量问题）
  - `rhi-scan-worker.test.ts` 1 失败（input_tokens 断言）：主仓复现 + main CI 绿，
    排除升级嫌疑（环境/时间敏感存量问题）

### PR 2（croner 批）
- 同上全套（build/lint/test）
- cron-parser 专项：15 用例全绿

## Dependabot PR 处置
#1768–#1774 已全部关闭（关闭评论注明并入统一 PR）；Dependabot 分支已清理
（GitHub 端 matching-refs 确认零残留）。

## 存量问题登记（非本批引入，提请搭档知晓）
1. `generate-guard-replay.test.ts` 时区缺陷：测试播种用 `localDate(-1)`（本地时区），
   脚本窗口用 UTC 日界——凌晨 0-8 点（Asia/Shanghai）跑必挂。修复方向：测试播种
   改 UTC 日界同源口径。建议另开 issue 而非本 PR 顺手修（本 PR 是 lockfile 小改动）。
2. `rhi-scan-worker.test.ts` input_tokens 断言本地挂 CI 绿——机制未深挖（非本批
   范围），如 CI 复现再排查。
