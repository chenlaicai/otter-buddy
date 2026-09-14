---
id: F20260904ldgr
title: 派发台账记账健壮性：note 追加语义（#795）+ 出处降级账面留痕与截尾上限 16（#798）
summary: "#794 检视遗留两笔 invoke 记账 tech-debt 打包修复。①#795：recordFinish 的 note 从覆盖改追加，retry 失败等原因不再抹平前情链——9/4 事故唯一幸存取证证据就是 note 链；②#798 发现2：invoke fulfilled 但行级出处查库失败时在槽位追加「出处降级」备注（新 repo 方法 appendNote），yield 丢失从纯日志升级为账面可查；③#798 发现1：chainSourceMessageIds 截尾上限 8→16（fan-in 用例支撑，截尾 warn 兜底保留）。"
change_type: fix
capability_test: "tests/frameworks/db/dispatch-attempt-repo.test.ts（追加语义+appendNote 2 用例）+ tests/usecases/conversation/self-chain-regression.test.ts（降级留痕+截尾 17/16 源 3 用例）+ signal-router-ledger.test.ts 断言升级（R5c 时序可读）"
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
tags: [signal-protocol, dispatch-ledger, audit-trail, invoke-ledger, tech-debt]
modules: [src/frameworks/db/conversation/sqlite-dispatch-attempt-repo.ts, src/usecases/conversation/dispatch-chain-engine.ts]
from: [F20260904schf]
---

## 背景

#794（P0+P1）与 #804（P2）检视中，mimo 各报出 invoke 记账链路的边缘场景，当时评估「改动代价大于收益」挂账 #795/#798。搭档拍板清掉，打包为一个专题（同在派发台账域，一次审视）。

## 三项修复

### #795：recordFinish note 追加语义

recordStart 已有 §8.2 前情压缩（OR REPLACE 前把旧行状态压进 note），但 recordFinish 带 note 时是 `CASE WHEN ? IS NOT NULL THEN ? ELSE note END`——**整体替换**。retry 失败时新 reason 覆盖掉积累的前情链。9/4 事故唯一幸存的取证证据就是 note 链，覆盖语义下下次同类事故可能完全隐形。

修复：`note = CASE WHEN ? IS NOT NULL THEN COALESCE(note || '; ', '') || ? ELSE note END`——新内容拼在前情之后，多次 finish 的历史完整保留且时序可读。影响面：recordFinish 三个调用方（engine completed/failed + router failed catch）全部受益。

### #798 发现 2：出处降级账面留痕

invoke fulfilled 但 `fetchProducedMessage` 查库失败时：行级出处为空 → 不路由（硬约束 1 降级语义，保持不变），此前只有 warn 日志，账面无痕。修复：

- `fetchProducedMessage` 返回 `[data, degraded]` 二元组
- `processHopResults` 收集降级槽位（新私有方法 `collectDegradedSlot`，拆出控复杂度）
- `executeOneHop` finally 中对降级槽位调 repo 新方法 `appendNote(ledgerMsgId, target, note)`——**只改 note 不改 status**（completed 语义没错，pending 反连接不变量不可破坏）

**实现中踩过的坑（记录给后来者）**：appendNote 的槽位键第一版误用产出消息 ID——首 hop 记账在 (triggerMessageId, target) 名下，用 (producedMessageId, target) 会 appendNote 无靶（测试红）；修正为与 recordAttemptSettle 同源取记账键（首 hop = triggerMessageId；hop 2+ = chainSource[target]）。

### #798 发现 1：截尾上限 8→16

chainSourceMessageIds 的 slice(-8) 在单 hop 9+ 獭 yield 同一目标时丢最早记账源 → 假 pending。#794 已加截尾 warn。本 PR 提升到 16，用例支撑：

- 并行 fan-in 上限 = 单轮 @提及多选实际规模（mention-parser 无硬上限但实际 <16）
- 并行 invoke 池深度（Promise.allSettled 全并发）与 scheduler 群发点名数
- 三场景取最大，16 倍于生产观测到的最大 fan-in；防膨胀语义保留（更早源已被 hop 记账自然消亡）

不选「分代存储」：需要 schema 变更，超出边缘场景的收益。

## 为什么不是更多

- attempt 不新增 status 值：会破坏 pending 反连接不变量（#798 约束，mimo 原判）
- 降级时不重试查库：查库失败是基础设施异常，链路侧重试会放大故障面；warn + 账面留痕已够排查
- OR REPLACE 行结构不变（不拆 attempt_instance）：#795 的建议方向之二，schema 变更+全链路回归代价与纯审计收益不匹配；追加式 note 已恢复取证通道

## 验证

- 全量 241 文件 / 3015 用例绿；tsc 0；eslint 0 errors（max-lines 豁免：本文件 DI 参数/多入口决定行数，压缩注释已尽，message-controller.ts 同款先例）
- 新增 5 用例：repo 追加语义+appendNote（真库）2 + 链引擎降级留痕 1 + 截尾 17 源触发/16 源不触发 2；R5c 断言升级（追加语义下前情链与新 reason 共存且时序可读）
- 最简实现检查：已过（三处皆最小改动：一条 SQL 语义修正 + 一个 7 行 repo 方法 + 一个常量提升）
- 不涉及 prompt/skill/协议层，golden gate 不适用

## 关联

- Closes #795 / Closes #798
- 前序: F20260904schf（#794，两 issue 的发现源头）
- max-lines 豁免理由同样适用 sqlite-dispatch-attempt-repo.ts（未超限，无需豁免）
