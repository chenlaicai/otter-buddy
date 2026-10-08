---
id: F20261008cpon
title: 全 compaction entry 极端形态交接降级 reason 兜底（compaction-only 枚举）
summary: session jsonl 全是 compaction entry、零普通消息时，交接降级机械档案的 reason 从无 reason 兜底通用文案改为专属 compaction-only 文案——排查时一眼区分「真空」「全压缩」「读失败」三种无原料形态
change_type: fix
capability_test: "tests/interface-adapters/unified-handoff.test.ts（#1277 用例：全 compaction entries + slicer 非空 slice 空原料 → reason=compaction-only，文案含「compaction 摘要 / 无普通消息」，与真空/读失败区分；反向验证：归因改回 undefined 该用例红）"
intent:
  problem: "issue #1277（PR #1267 终审遗留）：session jsonl entries 全部是 compaction entry、零普通消息时，slicer 返回非空 slice 但 messagesToSummarize 为空（messageFromEntry 跳过 compaction），hasMaterial=false 走机械档案，但 degradeReason=undefined——档案说明节与完成文案均落无 reason 通用兜底（「LLM 叙事合成未执行或降级」），排查时无法区分「真空」「全压缩」「合成未跑」三种形态。"
  expected_effect: "① HandoffDegradeReason 新增 compaction-only 枚举值（专属文案：「前世 session 只有 compaction 摘要、无普通消息（极端形态，无原料可合成）」）；② collectJsonlSlice 上抛 compactionOnly 标记（isCompactionOnlyEntries helper），!hasMaterial 分支据它标定 compaction-only；③ 完成文案、机械档案、日志三处 reason 精确区分四种无原料/降级形态。"
  verify_by:
    type: capability_test
    reason: "新增用例构造全 compaction entries（entries=[{type:'compaction',...}] + sliceSessionEntries stub 返回非空 slice 但 messagesToSummarize=[]——与真实 slicer 行为一致），断言完成文案含 compaction-only 专属文案且不含真空/读失败文案；反向验证（归因改回 undefined → 用例红）证实非恒真锚；真空（S1）与读失败（S2）既有用例保持绿（区分性回归锚）。全量 vitest 5015 用例 + tsc 全绿。"
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

真实代码路径（初版修法被检视证伪后核实）：`sliceSessionEntries` 恒返回结构，**只有真空 session（0 条 entry）返回 undefined**（session-slicer.ts:108）。全 compaction entries 走完整函数体——speakIndexes 为空 → messagesToSummarize 为空（compaction 被 messageFromEntry 跳过，session-slicer.ts:217）→ 返回**非 undefined 的空原料 slice**。

后果链：slice 非空 → collectJsonlSlice 返回 degradeReason=undefined → hasMaterial=false 走 `!hasMaterial` 分支 → degradeReason 保持 undefined → 档案说明节与完成文案均落**无 reason 通用兜底**（「LLM 叙事合成未执行或降级，本档案为机械转储形态」）——排查时无法区分「真空」「全压缩」「合成未跑」。

> 初版修法（commit b8a3ceb4）曾假设「全 compaction → slicer 返回 undefined」并在该不可达分支归因，被检视獭-1359 严重 1 证伪（真实路径 slice 恒非空），本版按检视建议改在 `!hasMaterial` 分支内归因。

## 修复（narrow-fix）

修法决策树①（既有机制语义内修——枚举缺啥补啥）：

- `session-slicer.ts`：`HandoffDegradeReason` 新增 `'compaction-only'` 枚举值 + 专属文案「前世 session 只有 compaction 摘要、无普通消息（极端形态，无原料可合成）」；新增导出 helper `isCompactionOnlyEntries`（`entries.length > 0 && entries.every(e => e.type === 'compaction')`——与 messageFromEntry 的 compaction 判定同口径，消除魔法字符串重复）
- `agent-invoker.ts collectJsonlSlice`：上抛结构新增 `compactionOnly` 标记（判定后随 slice 一起上抛）；防御性 slice=undefined（理论不可达）归 jsonl-read-fail 不变
- `agent-invoker.ts !hasMaterial 分支`：`degradeReason = sliceDegradeReason ?? (compactionOnly ? 'compaction-only' : undefined)`——真空/读失败沿用 collectJsonlSlice 上抛值，全 compaction 形态按标记补标

机制识别检查点：新增枚举值 + 上抛结构新增布尔标记属于既有 `HandoffDegradeReason` 枚举与 collectJsonlSlice 返回结构的成员扩充，不产生新状态生命周期/新配置字段/新决策分支——narrow-fix 成立。

## 设计取舍

- **为什么在 !hasMaterial 分支归因而非 slicer 内部标 reason**：slicer 的返回结构（JsonlSlice）不含 reason 字段，为它加字段会扩大改动面（所有 slice 消费点都要感知）。compaction-only 判定数据（entries）在 collectJsonlSlice 层就有，上抛布尔标记 + 消费处分支补标是最小改动。
- **为什么新增枚举值而不是改 empty-session 文案**：empty-session 文案「前世 session 无任何消息」对真空形态准确——改它会误伤真空归因。两种形态各自该有自己的文案。
- **helper 放 session-slicer 而非 invoker 本地**：`e.type === 'compaction'` 判定在 session-slicer.ts:217（messageFromEntry）已有一处，helper 与 slicer 同源保证口径一致，未来 compaction 判定演进（如新增子类型）只需改一处。

## 影响范围

- 行为变化面：仅「全 compaction 极端形态」的档案说明节/完成文案/日志 reason 从无 reason 兜底变为专属文案，其他形态（真空/读失败/合成失败/超时/超窗/熔断/用户关）文案不变
- 消费方：`HANDOFF_DEGRADE_REASON_TEXT` 的两处消费（buildMechanicalArchive 说明节、agent-invoker 完成文案拼接）自动覆盖新值，无需改动
- 测试：新增 1 用例（#1277 全 compaction 归因，stub 复刻真实 slicer 非空 slice 空原料行为），反向验证（归因改回 undefined → 红）证实非恒真锚；真空（S1）/读失败（S2）既有用例保持绿作区分性回归锚
