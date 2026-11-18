---
id: F20261118belif
title: 主动记忆层 belief 数据模型与写入守卫（P1a：出处四维校验 + 状态机 + 防环）
doc_type: feature
summary: |
  「主动记忆层」P1 的第一刀（地基）：新增 content_type `belief`（不建平行新库，memory_entries
  分区），以 metadata.kind 区分 preference（搭档喜好）/ state（agent 推断认识）；定义
  belief 生命周期状态机（recorded→verified→disputed→superseded，含回退与终态出边全拒）；
  落地四维出处校验（ID 存在 / preference 必须搭档原话 / 消息锚点本会话范围 / state 必须
  推断+依据）与防环（supersedes 目标 createdAt 必须早于源）。写入路径 RecordBelief 先过
  校验再走 StoreMemory 现有防线。本刀只做领域层与守卫，不接工具面（P1c）、不动检索
  （P1b）。查重：2026-11-18 实查无 belief/主动记忆同主题文档，新建。
change_type: feature
intent:
  problem: "P0 已让检索能感知 supersede 降权，但「主动记忆」本身还没有落点——没有 belief 分区、没有出处校验、没有状态机。若直接放 agent 自由写 belief，会重演无源记忆：编造出处、把獭自己的推断当搭档喜好、新旧认识互替环。地基缺失，P1b 检索优先级与 P1c 工具面都无处挂载。"
  expected_effect: "新增 belief 内容类型 + metadata 契约（kind/status/anchors/inferredFrom/supersedes）；四维出处校验挡无源之水（空/ID 不存在/preference 非搭档原话/state 无推断依据均拒收）；状态机非法迁移全拒；A↔B 互替环被 createdAt 拦截。本刀零 LLM 行为变更（不接工具、不动检索）。"
  verify_by:
    type: behavior_check
    note: "单测覆盖状态机矩阵（合法 7 + 非法 6）、四维+非空+限长校验各维拒收、防环三态（不存在/非 belief/时间不早于源）、RecordBelief 合法入库与非法拒收不写入；npm run check 全绿；检视獭核对声明 mechanism-addition 与 diff 一致。"
capability_test: "n/a: 本刀纯领域层（实体 + 校验 usecase + 写入 usecase），不新增 prompt/工具/检索行为，agent 尚不可触达；行为门禁为新增单测（belief-guard / record-belief）。"
created_at: 2026-11-18
created_in_conversation: 82f71e1a-a8b0-4e0f-916e-5e219624483c
causal_links:
  from: [F20261118stale]
tags: [memory, belief, active-memory, provenance, validation, state-machine]
modules:
  - src/entities/memory/belief.ts
  - src/entities/memory/memory-entry.ts
  - src/usecases/memory/belief-guard.ts
  - src/usecases/memory/record-belief.ts
  - tests/usecases/memory/belief-guard.test.ts
  - tests/usecases/memory/record-belief.test.ts
---

# 主动记忆层 belief 数据模型与写入守卫（F20261118belif）

> **定位**：P1「主动记忆层」的第一刀（地基）。承接 P0（F20261118stale，检索端 stale 降权已合入）。
> 方案 v4 定稿见对话工作区 `otter-memory-design-v2.md`（§3 主动记忆层设计、§5 硬约束）。
> 本刀只做领域层与写入守卫，**不接工具面（P1c）、不动检索（P1b）**，零 LLM 行为变更。

## 数据模型决策（v4 未定死的补白）

v4 只写「新增 content_type `belief`」，preference/state 二分的存储形态未定。本刀采用：

- **单一 content_type `belief`** + `metadata.kind ∈ {preference, state}`（一个状态机管两层）。
- preference：来源只能是搭档原话（四维校验第 2 条卡 senderType=user ∧ senderId=本对话搭档）。
- state：agent 推得的当前认识，必须标「推断」并给 inferredFrom 依据（四维校验第 4 条），永不当硬规则用。

## 状态机（§3.3）

```
recorded ──verified──▶ verified ──disputed──▶ disputed ──recorded──▶ recorded（重新入审）
   │  ▲                   │                      │
   │  └──────disputed──────┘                      │
   └──superseded──▶ ◼         └──superseded──▶ ◼
```

- 合法迁移 7 条：recorded→verified/disputed/superseded；verified→disputed/superseded；disputed→recorded/superseded。
- superseded 为终态（无出边，全拒）；`isLegalBeliefTransition` 纯函数供工具层与测试复用。
- 新条目只能以 recorded 出生（verified/disputed/superseded 只由状态迁移产生，写入路径拒收）。

## 四维出处校验（§3.2）+ 防环（§3.3）

| 维 | 校验 | 拒收条件 |
|---|---|---|
| 0 非空 | anchors 非空；content trim ≤ 500 字符 | 空 → anchor_existence；超长 → content_length |
| 1 ID 存在 | 每条 anchor 在 memory_entries 存在 | 不存在 → anchor_existence |
| 2 来源身份 | preference 锚点 senderType=user ∧ senderId=本对话搭档 | 非 user / 非本搭档 → anchor_identity |
| 3 引用范围 | **仅 state**：message 锚点 conversationId = 本会话（preference 跨对话成立，不受 scope 约束） | 跨会话 → anchor_scope |
| 4 推断依据 | state 必须给 inferredFrom 且条目存在 | 缺失/不存在 → inference_basis |
| 防环 | supersedes 目标存在、为 belief、createdAt 早于源 | 任一不满足 → cycle |

校验在 `BeliefGuard`（usecase，窄端口 `BeliefGuardPorts` 注入读依赖），代码校验不靠提示词（v4 §5.2）。

## 写入路径

`RecordBelief.execute`：先 `BeliefGuard.validate`（status 强制 recorded）→ 不过则 `DomainError(kind=validation)` 拒收；
过了走 `BeliefStore.execute`（生产实现为 `StoreMemory`，复用污染拦截 + 嵌入 + FTS 现有防线，v4 §5.4）。
新条目 `sourceTable="belief"`、`layer="working"`、`granularity="coarse"`、id=randomUUID。

## 验证

- `belief-guard.test.ts`：状态机矩阵（合法 7 + 非法 6）；四维校验各维拒收 + 合法通过；防环三态。
- `record-belief.test.ts`：合法 preference/state 入库形态（contentType/status/kind/anchors/inferredFrom）；非法 preference 拒收且不写入。
- 本刀不接工具，无 LLM 行为变更，capability_test n/a。

## 后续（本 PR 之外）

- P1b：检索端 belief 优先级 + `[未核实]`/`[已核实]` 标注 + verified 权重高于 recorded。
  **前瞻注意（k3）**：belief 写 `layer="working"`，会话归档时会被整对话 working→historical 连坐；P1b 做优先级时**别依赖 layer=working，按 contentType=belief 提优先级**。
- P1c：belief 工具面（记录/核实/打回/supersede），含 `getMessageSender` 真实实现与 bootstrap 装配。