---
id: F20261117cbsig
title: 循环熔断签名表补 archive_artifact_for_reconciliation：异参批量归档不再误判连发（#1895）
change_type: fix
status: implemented
created: 2026-11-17
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - src/frameworks/agent/tool-call-circuit-breaker.ts
  - tests/frameworks/agent/tool-call-circuit-breaker.test.ts
summary: "#1895：每日产物对账段连续调用 archive_artifact_for_reconciliation 8 次（每次 artifactId 与 evidence 均不同），被循环熔断判定「Consecutive identical call」steer 并截断，对账段无法执行。根因：该工具（#1835/#1881 引入）漏进签名分发链，grep 零命中→退回工具名兜底→8 次异参同签名误判连发。同族 #1399/#1802 已补齐 read/write/edit/workspace_*/link_memory/create_linked_resource/set_context/search_*，本工具是残余口子。方案：managementToolSignature 补分支，实体=artifactId（evidence 是审计文本非实体标识）。零新机制。"
tags: [health, circuit-breaker, signature, reconciliation]
intent:
  problem: "archive_artifact_for_reconciliation 不在循环熔断签名分发链中，退回工具名兑底；同日异参批量归档 8 次同签名，被误判 Consecutive identical call 并 steer，每日产物对账段整体阻断，~120 条终态产物无法批量清扫"
  expected_effect: "不同 artifactId 的归档调用产生不同签名，不再触发连续同构拦截；同一产物反复归档仍同签名、保留重复提醒语义；每日对账段可连续批量归档"
  verify_by:
    type: static_only
capability_test: "连续归档不同 artifactId 8 次全部 allow（修复前第 N 次 steer）；同一 artifactId 反复归档第 6 次 steer（重复语义保留）——tests/frameworks/agent/tool-call-circuit-breaker.test.ts 新增 3 用例机械可测"
---

# 循环熔断签名表补 archive_artifact_for_reconciliation：异参批量归档不再误判连发（#1895）

## 问题（现场）

2026-11-15 每日健康检查产物对账段，连续调用 `archive_artifact_for_reconciliation` 8 次（每次 artifactId 与 evidence 均不同），被循环熔断判定「Consecutive identical call」steer 并物理截断，整个产物对账段无法执行（healing event `1062d021-95dc-44be-afcf-8e881b1d6862`，loop_tool_block）。

## 根因

`tool-call-circuit-breaker.ts` 签名分发链 `dispatchToolSignature → otterToolSignature → managementToolSignature → residualToolSignature` 均无 `archive_artifact_for_reconciliation` 分支，`grep archive_artifact` 零命中 → 退回工具名兜底 → 8 次异参调用同签名 → 误判连发。

同族先例 #1399（残余口子收口）与 #1802（workspace_delete 签名粒度）已为 read/write/edit/workspace_*/link_memory/create_linked_resource/set_context/search_* 补齐签名，但本工具（#1835/#1881 引入）漏进签名表。

## 方案

`managementToolSignature` 补分支：

```
case "archive_artifact_for_reconciliation":
  return entityToolSignature(toolName, "artifactId", a.artifactId);
```

- 实体 = artifactId（evidence 是审计文本，非实体标识，不入签名）——不同产物归档是合法批量流。
- 同一产物反复归档同签名，重复提醒语义保留（幂等重登记值得提醒，与 update_artifact_status 同哲学）。

## R8.5 准入三问

1. **决策者变了么**：没有。签名表补齐是既有分发链的收口，不新增裁决权。
2. **靠自觉还是靠守卫**：**机械可测**——签名函数是纯函数，新增 3 用例（8 连不同产物 allow / 同产物第 6 次 steer / evidence 不入签名）锁死行为。
3. **深潜成本降了吗**：降——每日对账段从「每批 1-2 条手工穿插」恢复为连续批量归档，不再被熔断物理截断。

## 验证

- [x] tests/frameworks/agent/tool-call-circuit-breaker.test.ts 新增 3 用例，65/65 通过
- [x] 无行为级回归风险：仅新增一个签名分支，不触碰检测/steer 核心逻辑

## 影响

- 每日产物对账段可连续批量归档（#1895 现场恢复）
- 与既有条款关系：本单是 #1399/#1802 签名表收口的最后一处已知残余口子（工具面），不新增机制
