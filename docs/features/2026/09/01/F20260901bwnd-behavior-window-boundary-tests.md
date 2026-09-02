---
id: F20260901bwnd
title: behavior_defect 窗口边界测试覆盖增强（混合时间分布 + 多类型 + 排序验证 + 边界强度）
doc_type: feature
summary: |
  Issue #660（PR #658 审视建议发现 4 后续）：detect-signals.test.ts 的
  behavior_defect 用例覆盖增强——纯测试变更，零生产代码改动。四个维度：
  ①混合时间分布（窗口内+外交错排列，验证只计窗口内）；②多 errorType 交错
  独立计数 + 多信号类型同场互不干扰；③聚合排序契约验证（#658 合入版语义：
  同型事件按 createdAt 升序，乱序输入下 evidence 范围端点正确）；④7 天窗口
  恰含/恰排除边界增强（degenerate/circuit_break 两型 + 毫秒级排除）。

causal_links:
  from:
    - F20260901rhdet

status: development
change_type: feature
tags: [health, signals, tests, coverage]
modules:
  - tests/usecases/health/detect-signals.test.ts
capability_test: "n/a: 纯测试增强（A 类），无 LLM 参与行为"
created_at: 2026-09-01T16:10:00+08:00
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# F20260901bwnd: behavior_defect 窗口边界测试覆盖增强（issue #660）

## 背景与需求

PR #658 的 behavior_defect 窗口化升级（F20260901rhdet §②）已合入 main。PR #656 审视（检视獭-656 建议发现 4）指出测试工厂固定 `createdAt = dayAgo(1)`，窗口语义覆盖偏薄：现有用例只验证「全在窗口内」场景，窗口含/排除边界仅 1 个用例且只测 tool_failure 一型。issue #660 据此立项补强。

**纯测试增强**：生产代码 detect-signals.ts 零改动。

## 与 issue 文本的口径差异（重要留痕）

issue #660 第三项写作「窗口内次数**降序**排序（聚类优先）」，源自 PR #656（**未合入实现**）的「信号按窗口内次数降序，密度最高排最前」。经核实，**main 合入的 #658 实现语义不同**：

| | PR #656（未合入） | PR #658（已合入 main） |
|---|---|---|
| 排序对象 | 信号（errorType 级） | 同型事件（event 级） |
| 方向 | 按窗口内次数**降序**（聚类优先） | 按 createdAt **升序** |
| evidence | 「最近一次 YYYY-MM-DD」 | 「最早 ~ 最晚」日期范围 |

#658 与自身特性文档（F20260901rhdet §②「聚合按时间**升序**」）一致，**不是实现 bug**。本 PR 按 #658 合入版契约锁定行为（升序 + 范围端点验证）；「密度优先排序」属特性变更（改变信号排序语义），超出本测试增强 issue 范围，需另立 issue 决策。

## 方案设计

在 detect-signals.test.ts 新增 `describe("Issue #660：behavior_defect 窗口边界覆盖增强")`（7 用例），复用既有 `healingEvent` 工厂（其 `createdDaysAgo` 参数本就支持任意天数，无需新工厂）：

| # | 用例 | 覆盖维度 |
|---|---|---|
| 1 | 混合时间分布正例：12 天前×2 与窗口内×3 **交错**排列 → 只计窗口内 3 次触发，evidence 日期范围不含窗口外日期 | 混合时间分布 |
| 2 | 混合时间分布负例：交错输入窗口内仅 2 次（全量 4 次超阈）→ 不触发 | 混合时间分布 |
| 3 | 多 errorType 交错独立计数：三型各 1-2 次不触发 + 两型各 3 次独立触发两条信号、互不抬计数 | 多类型 |
| 4 | 多信号类型同场：bug_recurrence + chain_stall + behavior_defect 同时触发各自计数不受干扰 | 多类型 |
| 5 | 聚合按时间升序：**新→旧乱序输入** → evidence 范围为「窗口内最早~最晚」且端点顺序正确 | 排序契约 |
| 6 | 7 天窗口恰含：窗口起点同刻事件计入（`>=` 语义，degenerate 型） | 边界增强 |
| 7 | 7 天窗口恰排除：窗口起点 -1ms 不计入（circuit_break 型） | 边界增强 |

### 用例设计说明

- **交错的必要性**（用例 1-2）：既有窗口化用例的窗口外事件是成组排列的，未覆盖乱序输入下窗口过滤的正确性——#658 的过滤是先逐事件判断再聚合，交错输入验证过滤与输入顺序无关
- **乱序输入排序验证**（用例 5）：既有「聚合按时间排序」用例的输入恰好是旧→新时间顺序，不排序也能通过；本用例用新→旧输入，若排序失效 `first/last` 会取错端点（evidence 范围反转），断言 `indexOf(最早) < indexOf(最晚)` 真正锁定排序行为
- **边界毫秒级**（用例 6-7）：恰含用例构造 `windowStart` 同刻时间戳（与实现的 `new Date(now - 7*DAY_MS)` 同源计算，避免浮点误差）；恰排除用例构造 -1ms。两用例分别用 degenerate/circuit_break 型——issue 点名这两型，现有边界用例只有 tool_failure
- **不重复造**：既有「窗口外事件不抬计数」（成组排列）、「恰好 3 次边界」、「参数可调」用例保持不动，新用例只补排列组合与强度，无语义重叠

## 影响范围

- **改动文件**：仅 tests/usecases/health/detect-signals.test.ts（+7 用例，30 → 37）
- 生产代码、schema、依赖：零改动
- 与 #664（rhi-scan-worker.test.ts 时钟冻结）无文件交集

## 验证

### 最简实现检查（必答）

仓库已有 detect-signals.test.ts 的 describe/it 结构与 healingEvent 工厂——直接在其内追加 describe 复用全部既有设施，未新增文件/工厂/依赖。**已过最简检查**。

### 测试结果（自检，实现者自报）

- 单文件：`npx vitest run tests/usecases/health/detect-signals.test.ts` → 37 用例全绿（30 原有 + 7 新增，无既有用例改动）
- 全量：`npm test` → **205 文件 / 2560 测试全绿**（含 pretest lint）
- tsc --noEmit：0 错误
- eslint：npm test 内置 pretest 通过（无新增告警）

### 发现的问题（超出测试增强范围，需大獭裁决）

**issue #660 第三项「降序（聚类优先）」与 main 合入语义不符**（详见上文「口径差异」节）：#658 实现是升序聚合，无密度排序。若「聚类优先」是期望能力，需另立特性 issue（改 detectBehaviorDefect 的信号排序逻辑），不宜以测试 PR 夹带实现。本 PR 用例 5 已将升序契约锁定为测试不变量——未来若引入密度排序需同步更新该用例。

## 下一步

- 大獭编排对抗审视（步骤 10）
- 「聚类优先排序」是否立项：呈大獭/搭档裁决（建议另立 issue）
