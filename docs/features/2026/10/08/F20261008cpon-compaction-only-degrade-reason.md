---
id: F20261008cpon
title: 全 compaction entry 极端形态交接降级 reason 兜底（compaction-only 枚举）
summary: session jsonl 全是 compaction entry、零普通消息时，交接降级机械档案的 reason 从笼统「空 session」改为专属 compaction-only 文案——排查时一眼区分「真空」与「全压缩」两种极端形态
change_type: fix
capability_test: "tests/interface-adapters/unified-handoff.test.ts（#1277 新增用例：全 compaction entries → reason=compaction-only，文案含「compaction 摘要 / 无普通消息」，与真空/读失败区分）"
intent:
  problem: "issue #1277（PR #1267 终审遗留）：session jsonl entries 全部是 compaction entry、零普通消息时，slicer 返回 undefined，collectJsonlSlice 笼统标 empty-session——机械档案与完成文案显示「前世 session 无任何消息」，与真实形态（有 entry 但全是压缩摘要）不符，排查时无法区分真空与全压缩。"
  expected_effect: "① HandoffDegradeReason 新增 compaction-only 枚举值（专属文案：「前世 session 只有 compaction 摘要、无普通消息（极端形态，无原料可合成）」）；② collectJsonlSlice 在 slice=undefined 时按 entries 是否含非 compaction 条目区分归因：全 compaction → compaction-only，防御性 undefined → jsonl-read-fail；③ 完成文案、机械档案、日志三处 reason 精确区分三种无原料形态。"
  verify_by:
    type: capability_test
    reason: "新增用例构造全 compaction entries（entries=[{type:'compaction',...}] + sliceSessionEntries stub 返回 undefined），断言完成文案含 compaction-only 专属文案且不含真空/读失败文案；真空（S1）与读失败（S2）既有用例保持绿（区分性回归锚）。全量 vitest 5015 用例 + tsc 全绿。"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
tags: [handoff, session-slicer, degrade-reason, compaction]
modules: [src/interface-adapters/agent-runtime/, src/frameworks/agent/]
from: ["F20260930hsfx"]
causal_links: ["F20260930hsfx"]
created_at: 2026-10-08
---

# 全 compaction entry 极端形态交接降级 reason 兜底

## 问题

issue #1277（PR #1267 终审遗留项，检视獭 delta 复核标记「建议级遗留」）。

F20260930hsfx 把 `sliceSessionEntries` 改为恒返回结构后，`collectJsonlSlice` 对 slice=undefined 笼统标 `'empty-session'`。但 slice=undefined 其实剩两种形态：

1. **真空 session**（0 条 entry）——真没原料，标 empty-session 正确
2. **全 compaction entry、零普通消息**（极端边缘形态）——有 entry 但全是压缩摘要，slicer 内部 collectMessages 跳过 compaction → 无普通消息可合成

形态 2 此前显示「前世 session 无任何消息（空 session）」——不精确（session 明明有 entry，只是全是 compaction）。排查时看文案会误以为真空，漏掉「全压缩」这个真实形态。

## 修复（3 行级）

修法决策树①（既有机制语义内修——枚举缺啥补啥）：

- `session-slicer.ts`：`HandoffDegradeReason` 新增 `'compaction-only'` 枚举值 + 专属文案「前世 session 只有 compaction 摘要、无普通消息（极端形态，无原料可合成）」
- `agent-invoker.ts collectJsonlSlice`：slice=undefined 时按 `entries.some(e => e.type !== 'compaction')` 区分——全 compaction → `compaction-only`；含非 compaction 但 slice 仍 undefined（防御性，理论不可达）→ `jsonl-read-fail`（切面异常语义）

机制识别检查点：新增枚举值属于既有 `HandoffDegradeReason` 枚举的成员扩充，不产生新状态生命周期/新配置字段/新决策分支（枚举值被消费的决策树——档案文案渲染、完成文案拼接——原样存在，只是多了一个精确取值）——narrow-fix 成立。

## 设计取舍

- **为什么新增枚举值而不是改 empty-session 文案**：empty-session 文案「前世 session 无任何消息」对真空形态是准确的——改它会误伤真空形态的正确归因。两种形态各自该有自己的文案。
- **为什么不叫 empty-session 拆两个值（empty-session-vacuum / empty-session-compaction）**：枚举值改名会断了 F20260930hsfx 的日志追溯链（历史日志里的 empty-session 都是真空形态，新值引入后含义不变）。新值独立命名最干净。
- **防御性 undefined 归 jsonl-read-fail 而非新枚举**：slicer 恒返回结构（hsfx 修复后），slice=undefined 且 entries 含非 compaction 是理论不可达形态——归 jsonl-read-fail（切面异常）语义最接近，不值得为不可达形态单设枚举。

## 影响范围

- 行为变化面：仅「全 compaction 极端形态」的档案/完成文案/日志 reason 文案变化，其他形态（真空/读失败/合成失败/超时/超窗/熔断/用户关）文案不变
- 消费方：`HANDOFF_DEGRADE_REASON_TEXT` 的两处消费（buildMechanicalArchive 说明节、agent-invoker 完成文案拼接）自动覆盖新值，无需改动
- 测试：新增 1 用例（#1277 全 compaction 归因），既有真空（S1）/读失败（S2）用例保持绿作区分性回归锚
