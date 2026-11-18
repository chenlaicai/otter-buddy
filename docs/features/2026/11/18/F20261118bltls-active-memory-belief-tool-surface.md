---
id: F20261118bltls
title: 主动记忆层工具面（P1c：record/verify/reject/supersede + 状态迁移 + 生产装配）
doc_type: feature
summary: |
  「主动记忆层」P1 的第三刀（工具面）：belief 从「可写入但无人能写」到「现场可记」。
  新增 record_belief 工具（现场记录，四维出处校验 + supersedes 提议即时降权）；
  状态迁移能力到位——TransitionBelief（verify/reject/supersede 共用原地迁移）+ SupersedeBelief
  （supersede 建边 + 旧迁终态 + TOCTOU 检测-跳过）都在 usecase 层实现，但迁移工具
  （belief_verify/reject/supersede）本刀不注册给 agent，留 P2 受限写者獭白名单单独注入。
  getMessageSender 生产实现 + bootstrap 装配补齐 P1a 未接线部分。
change_type: feature
intent:
  problem: "P1a 交付了 belief 数据模型 + 四维出处校验 + 状态机 + 写入 usecase，但全部停在地基——没有工具面（agent 调不到 record_belief）、没有状态迁移 usecase（verify/reject/supersede 无处落地）、getMessageSender 无生产实现、bootstrap 未装配。信念层是死的：能建模型却无处写入与迁移。"
  expected_effect: "agent 拿到 record_belief 现场记录（机器四维校验挡编造出处）；belief_verify/reject/supersede 做状态迁移（合法性走 isLegalBeliefTransition 矩阵）；supersede 同步建边 + 旧迁终态，TOCTOU 双写防护兜底。非 belief 路径零行为变更（不动检索），golden-selftest 地板不变。"
  verify_by:
    type: behavior_check
    note: "单测覆盖 transition-belief（合法/幂等/终态无出边/非 belief 拒/不存在拒/metadata 畸形拒）+ supersede-belief（markExpired 不建边/markReplaced 建边 from=新 to=旧/TOCTOU 检测跳过/新条目非 belief 拒）；smoke:boot 全栈装配通过（belief 四 usecase wire-up 不炸）；npm run check 全绿；lint:tool-manifest 确认 record_belief 注册、迁移工具名不在 manifest；检视獭核对声明 mechanism-addition 与 diff 一致。"
capability_test: "n/a: 本刀是工具面 + usecase + 装配，写入路径复用 record-belief/transition-belief；行为门禁为新增单测（10 项）+ smoke:boot 装配通过 + lint:tool-manifest（4 工具名注册校验）。"
created_at: 2026-11-18
created_in_conversation: 82f71e1a-a8b0-4e0f-916e-5e219624483c
causal_links:
  from: [F20261118belif, F20261118blsrk]
tags: [memory, belief, active-memory, tool-surface, state-transition, supersede]
modules:
  - src/usecases/memory/transition-belief.ts
  - src/usecases/memory/supersede-belief.ts
  - src/bootstrap/usecases.ts
  - src/bootstrap/clients.ts
  - src/bootstrap/types.ts
  - src/usecases/ports/otter-tool-client.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - config/tool-manifest.json
  - tests/usecases/memory/transition-belief.test.ts
  - tests/usecases/memory/supersede-belief.test.ts
---

# 主动记忆层工具面（F20261118bltls）

> **定位**：P1「主动记忆层」的第三刀（工具面）。承接 P1a（F20261118belif，数据模型 + 守卫 + 写入）与 P1b（F20261118blsrk，检索端优先级）。
> 方案定稿见对话工作区 `otter-memory-design-v2.md`。

## 变更

1. **TransitionBelief**（新 usecase）：belief metadata.status 原地迁移（同 id UPDATE，不新建不删），合法性走 `isLegalBeliefTransition` 矩阵；幂等（目标状态已就位不写库）；非 belief / 不存在 / metadata 畸形均拒。
2. **SupersedeBelief**（新 usecase）：`markExpired`（只迁 superseded，夜间獭标记过期，不建边）；`markReplaced`（新取代旧：旧迁 superseded + 建 supersedes 边 from=new,to=old）。TOCTOU 防护：旧已有入边 supersedes 则**检测-跳过**（缩小窗口，非绝对加锁——写入按会话串行，残留窗口极窄）。
3. **getMessageSender 生产实现**（bootstrap/usecases.ts）：memory entry（sourceTable=entries/messages）→ entries 表 senderType/senderId，两代 sourceTable 都识别。
4. **bootstrap 装配**：BeliefGuard（getEntryById=memoryReader、getMessageSender=上述 adapter）+ RecordBelief（StoreMemory 复用污染拦截/嵌入/FTS）+ TransitionBelief + SupersedeBelief，挂进 UseCases。
5. **工具面**：record_belief 注册进 tool-factory + tool-manifest memory block。**belief_verify/reject/supersede 本刀不注册**（createTools 默认集只含 record_belief）——「verified 必须由独立獭核实」的信任模型不能被任何 agent 自我核实掏空：三个迁移工具以待 P2 受限写者獭白名单单独注册（工具函数已删，P2 重建）。

## 关键语义

- supersedes 边方向沿用 P0 契约：from=取代者（新）、to=被取代（旧）——检索端 `getSupersededBy` 据此降权。
- 工具层 partnerUserId 走 ToolContext.partnerUserId（缺省 "user" = Web 口径），注入链已通到 InvokeOptions.partnerUserId；**IM 平台的装配层填充（agent-invoker 经 PartnerResolver 解析 owner id）为 P2 已知未接线项**——接线前 IM 平台的 preference 记录会被 anchor_identity 拒收（state 不受影响），非静默串味。
- record_belief 带 supersedes 部分失败时，工具错误文案披露「新条目可能已写入、可 link_memory 补边」，挡盲重试活体重复。
- P1c 不引入夜间审视定时任务（P2）、不引入受限写者獭白名单类型（P2）——三个迁移工具本刀不注册，避免任何 agent 自我核实掏空「verified 必须独立核实」的信任模型。