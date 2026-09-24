---
id: F20260924ircc
title: 右栏状态回归根治（分离防双拉门控与断连重连补偿语义）
doc_type: feature

summary: |
  右侧栏海獭状态卡「运行中」（实际已休息、手动刷新才恢复）在 F20260923sswd
  合入后复发且影响面扩大（issue #1160）。根因：F20260923sswd 为治初始加载双拉，
  在 syncInvokeStatesFromServer 加的防双拉门控（invokeStatesLoadedRef）错误覆盖了
  F20260922rprf 的断连重连补偿路径——初始拉取成功后，任何断连重连的补偿拉取被
  永久短路，断连窗口丢失的 invoke.end 无愈合路径。修复（narrow-fix）：新增
  syncInvokeStatesOnReconnect（无门控）专供重连补偿；needsSyncAfterReconnect 初值
  true→false（首连不补偿，初始恢复归内联拉取+重试链，同时根治初始双拉）；
  invokeStatesLoadedRef 门控仅保留给初始重试链。

type: BugFix
domain: web
status: implemented
created: 2026-09-24
created_in_conversation: 5603032d-569c-42c1-b318-1e3b4629ab1f
related_issues: [1160]
related_pr: []
causal_links:
  - F20260923sswd
  - F20260922rprf
---

# 右栏状态回归根治：分离防双拉门控与断连重连补偿语义

## 背景与问题

右侧栏海獭状态卡「运行中」（实际已休息、手动刷新才恢复）在 F20260923sswd（#1144）
合入后**复发且影响面扩大**。issue #1160。

## 根因

F20260923sswd 为治初始加载双拉，在 `syncInvokeStatesFromServer` 函数体首行加了全局门控
`invokeStatesLoadedRef`（`web/src/pages/conversation/index.tsx:240`）。但该函数同时承担
F20260922rprf 的**断连重连补偿**职责（onprogress 补偿调用点，index.tsx:844）。

一旦初始内联拉取成功（标记置 true），此后**任何**断连重连的补偿拉取都被该门控
`return` 短路——断连窗口内丢失的 `invoke.end` 无任何愈合路径，右栏永久卡「运行中」。

**为何感觉更严重**：F20260922rprf 时代正常断连（onerror/onload）可靠补偿自愈，仅
静默半截不治；F20260923sswd 的看门狗让静默死亡也能重连了，但门控把补偿杀了——
**连正常断连都不再自愈**，唯一愈合路径只剩手动刷新。两次修复互相踩。

## 修复方案（Modification-Class: narrow-fix）

分离被混在一个函数里的两个门控语义，不新增配置/状态/定时器/信号/存储：

1. **新增 `syncInvokeStatesOnReconnect`**（无门控）：专供断连重连补偿路径调用。
   重连补偿本就受 `needsSyncAfterReconnect` 一次性语义守护（每次重连仅首次
   onprogress 触发一次），无需也不应受初始恢复门控约束。
2. **`needsSyncAfterReconnect` 初值 `true → false`**：首连 onprogress 不再触发补偿
   （初始恢复归 `loadConversationDetail` 内联拉取 + 600ms/2500ms 重试链全权负责），
   同时**根治初始双拉竞态**——这正是当初要加防双拉门控想解决的问题。
3. **`invokeStatesLoadedRef` 门控仅保留给初始重试链**：`syncInvokeStatesFromServer`
   恢复原职（初始重试短路），不再承担补偿职责。

## 影响范围

- `web/src/pages/conversation/index.tsx`：上述三处
- `web/src/pages/conversation/index.spa-nav.test.tsx`：+1 回归用例

## 验证

- 失败测试先行：新增用例「初始拉取成功后，断连重连的补偿拉取仍发生（不被防双拉
  门控短路）」——修复前必失败（`expected 1 to be 2`，补偿被短路），修复后通过。
  用 FakeXHR 桩模拟 XHR 生命周期（首连 onprogress 不补偿 → onerror 断连 →
  scheduleReconnect 重连 → 重连首帧触发补偿拉取）。
- web 537/537 测试全绿（58 文件，原 536 + 新增 1）；`npx tsc --noEmit` exit 0。

## 设计取舍

无新增机制——纯逻辑修正（narrow-fix）。两个职责混用同一函数是本次回归的根源，
修复后职责单一：初始恢复走带门控的 `syncInvokeStatesFromServer`，断连补偿走
无门控的 `syncInvokeStatesOnReconnect`，互不干扰。
