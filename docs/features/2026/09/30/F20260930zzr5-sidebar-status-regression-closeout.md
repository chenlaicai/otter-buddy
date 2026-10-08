---
id: F20260930zzr5
title: 左栏对话状态回归收口：可见性立即刷新 + 状态一致性回归测试
type: BugFix
change_type: fix
status: implemented
created_at: 2026-09-30
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
causal_links:
  - F20260806actv
  - F20260930roiv
summary: issue #1249 左栏「处理中」滞留：根因层已由 #1244 修复，本特性收口显示层——可见性恢复立即刷新 + 数据/前端两层回归测试
intent:
  problem: "issue #1249：9/29 13:09 搭档目击对话实际等待用户（awaiting_user），左侧栏仍显示「处理中」。数据层根因（重启窗口期孤儿 running invoke）已由 F20260930roiv/#1244 修复；显示层次因：轮询 hook 切回标签页时不立即刷新，旧 badge 最长滞留 5s；且事故链路末端（孤儿清理后状态恢复）无回归测试。"
  expected_effect: "① use-conversation-list-polling 切回标签页时先 refresh() 再 startPolling()（fetching 防重入），状态翻转后 UI 即时反映；② 数据层新增事故链路回归用例（孤儿清理后 processing→awaiting_user 恢复）；③ 前端层新增 3 用例（服务端翻转轮询跟随 / 切回立即刷新 / 防重入）。"
  verify_by:
    type: capability_test
    reason: "sqlite-conversation-repository.test.ts 事故链路回归用例 + use-conversation-list-polling.test.ts 3 用例（接管 rebase 后复跑 29/29 + 3/3 绿，tsc exit 0）。"
---

# F20260930zzr5 左栏对话状态回归收口

## 背景

9/29 13:09 搭档目击：对话实际「等待用户」（awaiting_user），左侧栏仍显示「处理中」（issue #1249）。任务派发时怀疑 9/26-9/29 合入的状态相关 PR（#1144 sswd、#1161 ircc），要求核对 diff 定位回归点。

## 排查结论

### 嫌疑 PR 核对（均排除）

- **#1144 / F20260923sswd**（9/23 合入，侧边栏 SSE 看门狗）：diff 只含 `web/src/pages/conversation/index.tsx` + 同目录测试 + 特性文档——右栏链路，未触碰左栏状态派生、轮询、合并、渲染任何一个环节
- **#1161 / F20260924ircc**（9/24 合入，右栏状态回归根治）：diff 只含 `web/src/pages/conversation/index.tsx` + 测试 + 特性文档——同上，右栏链路，与左栏无交集
- 结论：issue 正文的「首要嫌疑」两个 PR 均未触碰左栏状态链路（`gh pr view 1144/1161 --json files` 核实）

### 真正的时间线（memory 8f726e72 + git 历史核实）

1. **9/29 13:18**（目击后 9 分钟）搭档目击的回归已排查完毕：3 个对话「处理中」卡死的根因是**重启窗口期孤儿 running invoke**——17:58:42 进程重启，启动 reconcile 只处理了当时的 running 记录，3 条 invoke 在 reconcile 完成后、新进程接管前的极短窗口内由旧进程异步写入，成了孤儿。派生 SQL（`sqlite-conversation-repository.ts:240`）判据「存在 running invoke → processing」，左栏永远「处理中」
2. **9/30 02:40** PR #1244（F20260930roiv）合入：延迟 10s reconcile + bootTs 守卫 + PatrolWorker 1h 周期兜底——**数据层根因已修复**
3. **本任务（9/30 上午）**：核对派生 SQL / 轮询 hook / merge 策略 / LeftPanel 渲染四环节，确认左栏链路无其他回归；补齐 issue 要求的回归测试

### 根因分型：两处叠加

1. **数据层**（根因，已修）：孤儿 running invoke → 派生 SQL 恒判 processing。修复 = F20260930roiv（#1244，已合入）
2. **显示层**（次因，本特性修）：轮询 hook 切回标签页时**不立即刷新**——`handleVisibility` 切回时只 `startPolling()`，首个数据要等下一个 5s tick。若孤儿已在隐藏期间被周期清理（或状态翻转），旧 badge 最长滞留 5s。issue 验证断言「awaiting_user 时显示『等待你』类状态」要求状态翻转后 UI 及时反映，这个窗口必须压缩

## 方案

### 改动 A：可见性恢复立即刷新

`use-conversation-list-polling.ts`：`handleVisibility` 切回时先 `refresh()` 再 `startPolling()`。刷新逻辑抽为独立 `refresh()` 函数，加 `fetching` 防重入标志（慢请求挂起期间 tick/visible 不叠加拉取）。

### 设计取舍（改动 A 的机制判定四问——检视獭-1269 严重1 要求补记）

改动 A 含机制增量（`fetching` 防重入标志 + `refresh()` 抽函数 + visible 立即刷新分支），按 `mechanism-addition` 口径补四问：

1. **谁需要它**：左栏用户——切回标签页时需立即看到最新对话状态（不等 5s tick），否则旧 badge 滞留期间用户误以为仍在处理中、错过响应窗口（issue #1249 目击形态）
2. **失败后果**：无 fetching 防重入 → 慢请求挂起期间 tick 与 visible 刷新叠加并发拉取，响应乱序到达时旧数据可能覆盖新数据（merge 粘滞变体）；无 visible 立即刷新 → 事故形态原样存在
3. **后续机制**：fetching 标志引入新状态，潜在泄漏路径=请求永不 settle（then/catch 双分支均复位，检视核实无泄漏；`finally` 化是更稳形态，当前 catch 复位已够）
4. **退役条件**：当 SSE/WebSocket 推送替代轮询时，整个 polling 机制（含本防重入）一并退役——当前轮询是既有架构，本特性不引入新范式

### 改动 B：两层回归测试（issue #1249 验证断言）

1. **数据层** `tests/frameworks/db/conversation/sqlite-conversation-repository.test.ts`：新增「事故链路回归」用例——孤儿 running invoke 存在时派生 processing（事故态断言）→ `failRunningInvokes`（bootTs 守卫）清理 → 同一对话派生恢复 awaiting_user（恢复断言）。锁死「清理后状态一致性」这一事故链路末端
2. **前端层** `web/src/hooks/use-conversation-list-polling.test.ts`（新文件）：3 用例——①服务端状态翻转 processing→awaiting_user 后轮询 tick 推动列表翻转（含 merge 后不被本地旧值粘住）②切回标签页立即刷新不等 5s tick ③fetching 防重入

## 改动

| 文件 | 改动 |
|------|------|
| `web/src/hooks/use-conversation-list-polling.ts` | refresh 抽函数 + fetching 防重入 + visible 立即刷新 |
| `web/src/hooks/use-conversation-list-polling.test.ts` | 新增：左栏状态回归 3 用例（#1249） |
| `web/src/lib/merge-conversations.ts` | 无改动（核查结论：服务端权威全量展开，无粘滞问题，见排查记录） |
| `tests/frameworks/db/conversation/sqlite-conversation-repository.test.ts` | 新增：事故链路回归用例（孤儿清理后 processing→awaiting_user 恢复） |
| `docs/features/2026/09/30/F20260930zzr5-sidebar-status-regression-closeout.md` | 本文档 |

## 验证

- `pnpm exec tsc --noEmit` 通过（根 + web）
- 根 vitest 全量 312 文件 4467 测试全绿（含新增 1 用例）
- web vitest 全量 60 文件 612 测试全绿（含新增 3 用例）
- 受影响面测试定向复跑：LeftPanel 43、merge-conversations、scrim-flicker-6 元测试、index.spa-nav 10 全绿

## 测试断言与 issue 验证断言的映射

issue #1249 验证断言：「对话处于 awaiting_user 状态时，左侧栏显示『等待你』类状态而非『处理中』，有回归测试」

- 数据层用例直接断言「清理后派生 awaiting_user」——SQL 判据正确性回归
- 前端层用例断言「服务端翻转后列表数据跟随翻转」+「可见性恢复立即刷新」——显示及时性回归
- 「等待你」文案本身 = LeftPanel.tsx:541 既有渲染（`c.activityStatus === 'awaiting_user'` → 「等待中」），无改动，由派生数据正确性保证

## 与并行任务边界

- 开发獭-1251（#1251 中断链路）：message-controller/agent-dispatch——无交集
- 开发獭-1247（#1247 create_otter 拦截）：——无交集
- 本特性文件面：web/hooks、tests/frameworks/db、docs——无撞车
