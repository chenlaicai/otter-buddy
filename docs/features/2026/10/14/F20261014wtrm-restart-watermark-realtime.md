---
id: F20261014wtrm
title: 重启獭生水位实时化 + 交接估算死代码出清
summary: |
  修复《主目录污染》对话暴露的獭僵尸死循环：水位交接判定用的 lastCtxTokens 只在
  invoke 成功收尾写回一次，失败/截断的 invoke 恰好不留水位证据，导致交接永不触发、
  满 buffer 獭被反复触发反复 400。修法：emitInvokeTick 每个 message_end 拿到
  usage.totalTokens 即实时写回 lastCtxTokens（水位随流式每轮更新）。
  同时出清 F20260825hndf 注入后零调用的交接估算死代码（buildHandoffPackage 整链，
  字符÷4 启发式在中文会话低估 8 倍，是历史重启超预算事故的机制根源）。
change_type: fix
capability_test: "n/a: 运行时机制修复（水位写回时机 + 死代码删除），无 prompt/skill 软代码改动；行为验证走单测红→绿"
created_in_conversation: 9993f9b1-bea7-41b6-9313-bc33ba23f77e
created_at: "2026-10-14"
doc_type: feature
tags: [handoff, watermark, restart, dead-code, tech-debt]
modules:
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/frameworks/agent/state-inventory.ts
  - src/bootstrap/platforms.ts
intent:
  problem: "水位交接判定用的 lastCtxTokens 只在 invoke 成功收尾写回，overflow/截断的 invoke 恰好不留水位证据，导致满 buffer 獭交接永不触发、反复被触发反复 400（僵尸死循环）；同时 buildHandoffPackage 交接估算死代码（字符÷4 启发式，中文低估 8 倍）注入后零调用，残留误导"
  expected_effect: "水位随流式每轮实时写回（emitInvokeTick 每个 message_end 同步 setLastCtxTokens），满 buffer 獭在下一 invoke 开口前即触发交接；buildHandoffPackage 死代码整链删除，重启/压缩保留段统一为 collectJsonlSlice 一套实现"
  verify_by:
    type: behavior_check
---

# F20261014wtrm 重启獭生水位实时化 + 交接估算死代码出清

## 背景与动机

《主目录污染》对话（conversation f3567df1，2026-10-14 02:51~03:01）一只 kimi-256k 大獭
陷入僵尸死循环：上下文涨到 258k 撞 262144 窗口，每次被触发第一发 LLM 调用即 400，
开口即截断、没机会调 yield、更没机会自重启，只能靠搭档手动 restart_otter 解围。

## 根因（全部实证）

### 破口①：水位写回盲区（本次核心修复）

水位交接判定读 `handoffState.getLastCtxTokens`（agent-invoker.ts:1311），
而该值的唯一写回点在 invoke 成功收尾路径（:452 `setLastCtxTokens`）。
overflow/截断的 invoke 走失败终态，**不写回**——前世 18 小时零写回，
后续 invoke 开头检查拿到 undefined，恒 false，交接永不触发。

矛盾点：流式过程中 `emitInvokeTick`（:802）每个 `message_end` 都拿到了
`usage.totalTokens`（服务端真实计数），发了 SSE 给右栏、落了 invoke 表，
**唯独没写进交接判定用的 lastCtxTokens**。数据一直在流，只是没喂给判定器。

### 破口②：交接估算死代码（出清）

`buildHandoffPackage`（handoff-package-builder.ts）经 platforms.ts:239 装配注入
agent-invoker，但全代码库 `buildHandoffPkg` **零调用点**——F20260825hndf 优雅交接
注入后，被 F20260929kws1 的 `collectJsonlSlice`（按条数切片，"最近 4 条 speak"方案）
取代，旧链没删干净。其内部 `fetchRecentEntries`/`estimateRecencyTokens` 用
`字符÷4` 启发式估 token——实测中文 0.5 字符/token（1 字=2 token）vs 英文 7.49，
中文会话低估约 8 倍，是 9/25 重启超预算事故（F20260925）的机制根源。

## 修法

### ① 水位实时化（narrow-fix）

`emitInvokeTick` 算出 `ctxWindowUsed` 后，同步 `this.handoffState.setLastCtxTokens(otterId, ctxWindowUsed)`。
自此水位随流式每轮实时更新，invoke 开头的水位检查（:329 `shouldTriggerWatermarkHandoff`）
永远拿最新值——满 buffer 獭在下一 invoke 开口**之前**就触发交接，死循环在源头断掉。

### ② 死代码出清（deletion，精确手术）

`buildHandoffPackage` 函数零调用（全仓 `buildHandoffPkg(` 无调用点），但同文件导出的
`HandoffEntryReader`/`StateInventoryDeps` 类型被 agent-invoker 活路径（状态盘点
`buildStateInventoryDeps`/`handoffEntryReader`）引用——**删整文件会断活路径**。
精确删除边界：
- 删 `buildHandoffPackage` 函数 + `fetchRecentEntries`/`entryToFragment`（÷4 估算驱动截断）
- 删 `recency-window.ts` 的 `estimateRecencyTokens`（÷4 估算，中文低估 8 倍根源）
- 保留 `HandoffEntryReader`/`StateInventoryDeps` 类型（活），agent-invoker 改从 state-inventory 引类型
- 删 `platforms.ts:239` 装配点、`agent-invoker.ts:200` `buildHandoffPkg` 注入声明
- 删 `tests/frameworks/agent/handoff-package-synthesis.test.ts`（纯测死函数）
- `recency-window.ts` 若删除后无活引用则整文件删

## 设计取舍

机制识别检查点判定（动手前）：破口②命中「退役条件」——`buildHandoffPackage` 是
已被取代（collectJsonlSlice）且零调用的死机制，修法走 deletion 而非修补。
破口①不新增机制，只把已有的水位写回时机从"收尾"提前到"每轮流式"，narrow-fix。

## 影响范围

- 运行时行为：獭水位随流式实时更新，交接判定更及时（修复僵尸死循环）
- 删除代码：buildHandoffPackage 及其测试（零调用，无行为变化）
- 兼容：无破坏性变更；水位语义不变（仍是服务端 usage.totalTokens）

## 验证

- 单测：水位在 message_end 后实时可见（红→绿）
- 死代码删除后全仓 `buildHandoffPackage`/`estimateRecencyTokens` 引用清零
- 最简实现检查：①只加一行写回，②纯删除——已过最简检查
