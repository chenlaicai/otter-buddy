---
id: F20261118blsrk
title: 检索端主动记忆优先级与标注（P1b：belief 提权 + [未核实]/[已核实] 标注 + supersededBy 透出）
doc_type: feature
summary: |
  「主动记忆层」P1 的第二刀（检索端）：让 belief 条目在检索重排时拿到最高优先级
  （beliefBoost=2.0），并按 belief 生命周期状态分层——verified 全加成、recorded ×0.6、
  disputed ×0.3、superseded ×0.1 深埋（可检索不可出）。
change_type: feature
intent:
  problem: "P1a 已让 belief 能写入且状态机完整，但检索端仍把 belief 当普通记忆排序——搭档喜好（preference）和已核实认识（state verified）会被最近大段对话记录淹没，主动记忆层「检索最高优先级」的硬约束（v4 §1）没有落地。同时 crawled 出的 belief 状态对 agent 不透明：不知道这条是 [已核实] 还是 [未核实]，引用时可能把已打回的推论当结论。"
  expected_effect: "检索重排时 belief 条目 ×beliefBoost（默认 2.0）高优先级，并按状态分层降权（verified 1.0 / recorded 0.6 / disputed 0.3 / superseded 0.1）；结果透出 beliefStatus 供 agent 标注 [未核实]/[已核实]/[存疑]；透出 supersededBy（P0 已合入，这里补进 search_memory 工具描述说明语义）。非 belief 条目因子恒 1.0，黄金走社零行为变更。"
  verify_by:
    type: behavior_check
    note: "单测覆盖 multiply/additive 两路径的 belief 提权与状态分层、畸形 metadata 回退 1.0、非 belief 不受影响；npm run check 全绿（含 golden-selftest 通过，非 belief 路径零行为变更不触碰走社地板）；检视獭核对声明 mechanism-addition 与 diff 一致。"
capability_test: "n/a: 本刀是检索端算法配置与结果透出，不新增工具/写出路径；行为门禁为新增 search-engine belief 优先级单测（37 项中 4 项新增）。"
created_at: 2026-11-18
created_in_conversation: 82f71e1a-a8b0-4e0f-916e-5e219624483c
causal_links:
  from: [F20261118belif]
tags: [memory, belief, active-memory, retrieval-priority, rerank]
modules:
  - src/usecases/memory/search-engine.ts
  - src/usecases/memory/search-memory.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - tests/usecases/memory/search-engine.test.ts
---

# 检索端主动记忆优先级与标注（F20261118blsrk）

> **定位**：P1「主动记忆层」的第二刀（检索端）。承接 P1a（F20261118belif，belief 数据模型 + 状态机 + 写入守卫）。
> 方案定稿见对话工作区 `otter-memory-design-v2.md`。
> 本刀不动写入路径、不加工具面（P1c），只让检索端把 belief 排到最高优先级并透出状态标注。

## 变更

1. `SearchEngineConfig` 新增 `beliefBoost`（默认 2.0），构造时回填。
2. 新增纯函数 `beliefStatusMultiplier(status)`：verified=1.0 / recorded=0.6 / disputed=0.3 / superseded=0.1（superseded 深埋：硬约束「禁止删除」意味着被取代条目仍可检索，但用 0.1 因子确保不会在 top 区出）。
3. `SearchEngine#beliefFactor`（私有）解析 entry.contentType === "belief" 的 metadata，返回提权因子与状态；非 belief / 解析失败返回 1.0。
4. `rerank()` 与 `rerankAdditive()` 最终分乘 beliefFactor；`ScoredHit` 透出 `beliefStatus`。
5. `RetrievalResultEntry` 透出 `beliefStatus`；`rerankAndReturn` 从 `ScoredHit` 传播。
6. `search_memory` 工具 description 补 beliefStatus / supersededBy 语义说明（P0 遗留观察项）。

## 权重口径

- 最终分 = 原最终分 × beliefBoost × beliefStatusMultiplier(status)。
- 非 belief 条目 beliefFactor = 1.0，规则不触及（黄金走社地板不变）。
- belief 提权**不依赖 layer=working**（内容类型判定），避免归档把整对话 working→historical 连坐后 belief 优先级集体蒸发（P1b 前瞻已知项）。
- **叠加语义（与 P0 边降权）**：若 belief 条目同时被 supersede 边指向（P0 `supersededPenalty=0.3`）且 metadata.status=superseded（本刀 ×0.1），两因子**叠乘**——实际 = beliefBoost × 0.1 × 0.3 = 0.06；只标 status 未建边 = 0.2。两档均正确（建边=图语义，标 status=状态语义），但标定时勿把 0.06 误读为「状态因子失效」。叠乘也会放大误建边的后果（recorded 被误建边 → 2.0×0.6×0.3=0.36 跌破普通条目），建边路径（P1c 工具面）需同步保证只对新旧 belief 对建边。