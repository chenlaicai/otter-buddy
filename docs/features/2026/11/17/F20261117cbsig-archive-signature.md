---
id: F20261117cbsig
title: 循环熔断签名表补全：archive_artifact_for_reconciliation 与五个带实体工具入表（#1895）
change_type: fix
status: implemented
created: 2026-11-17
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - src/frameworks/agent/tool-call-circuit-breaker.ts
  - tests/frameworks/agent/tool-call-circuit-breaker.test.ts
summary: "#1895：每日产物对账段连续调用 archive_artifact_for_reconciliation 8 次（每次 artifactId 与 evidence 均不同），被循环熔断判定「Consecutive identical call」steer 并截断，对账段无法执行。根因：该工具（#1835/#1881 引入）漏进签名分发链，grep 零命中→退回工具名兜底→8 次异参同签名误判连发。同族 #1399/#1802 已补齐其余工具。方案：签名表驱动化——archive_artifact_for_reconciliation + resolve_signal/triage_signal/get_context/add_terminology/create_scheduled_task 六个带实体工具入表（实体各自取 artifactId/signalId/key/term/name），异实体批量连发不再误判。零新机制。"
tags: [health, circuit-breaker, signature, reconciliation]
intent:
  problem: "签名分发链漏掉多个带实体参数的工具（archive_artifact_for_reconciliation 及其同族 resolve_signal/triage_signal/get_context/add_terminology/create_scheduled_task），退回工具名兜底；异实体批量连发被误判 Consecutive identical call 并 steer，产物对账、信号裁决、术语入库等合法批量流被阻断"
  expected_effect: "六个带实体工具的异实体批量连发产生不同签名，不再触发连续同构拦截；同一实体反复操作仍同签名、保留重复提醒语义；产物对账/信号裁决/术语入库等批量流可连续执行"
  verify_by:
    type: static_only
capability_test: "连续归档不同 artifactId 8 次全部 allow（修复前第 N 次 steer）；同一 artifactId 反复归档第 6 次 steer（重复语义保留）；同族五工具各自异实体批量连发 allow——tests/frameworks/agent/tool-call-circuit-breaker.test.ts 新增用例机械可测"
---

# 循环熔断签名表补全：archive_artifact_for_reconciliation 与五个带实体工具入表（#1895）

## 问题（现场）

2026-11-15 每日健康检查产物对账段，连续调用 `archive_artifact_for_reconciliation` 8 次（每次 artifactId 与 evidence 均不同），被循环熔断判定「Consecutive identical call」steer 并物理截断，整个产物对账段无法执行（healing event `1062d021-95dc-44be-afcf-8e881b1d6862`，loop_tool_block）。

## 根因

`tool-call-circuit-breaker.ts` 签名分发链 `dispatchToolSignature → otterToolSignature → managementToolSignature → residualToolSignature` 均无 `archive_artifact_for_reconciliation` 分支，`grep archive_artifact` 零命中 → 退回工具名兜底 → 8 次异参调用同签名 → 误判连发。

同族先例 #1399（残余口子收口）与 #1802（workspace_delete 签名粒度）已为 read/write/edit/workspace_*/link_memory/create_linked_resource/set_context/search_* 补齐签名，但本工具（#1835/#1881 引入）漏进签名表。

## 方案

`managementToolSignature` / `residualToolSignature` 补六个带实体工具分支（实体=各自实体标识键，异实体即不同签名）：

| 工具 | 实体键 | 签名 |
|---|---|---|
| archive_artifact_for_reconciliation | artifactId | `archive_artifact_for_reconciliation: <id>` |
| resolve_signal | signalId | `resolve_signal: <id>` |
| triage_signal | signalId（单条）；动作+过滤特征（批量） | 单条 `triage_signal: <id>`；批量 `triage_signal: <action> [issue:/type:/sev:]` |
| get_context | key | `get_context: <key>`（与 set/delete 对称） |
| add_terminology | term | `add_terminology: <term>` |
| create_scheduled_task | name | `create_scheduled_task: <name>` |

- evidence（archive）、status/resolution（resolve）、definition（terminology）等附加参数不入签名——与 #1399「实体相同即同签名，附加参数不区分」哲学一致。
- 同一实体反复操作同签名，重复提醒语义保留（幂等重登记值得提醒）。
- 缺参退回工具名，连续缺参 steer 是合理纠错信号（entityToolSignature 契约）。

## R8.5 准入三问

1. **决策者变了么**：没有。签名表补齐是既有分发链的收口，不新增裁决权。
2. **靠自觉还是靠守卫**：**机械可测**——签名函数是纯函数，新增用例（六工具异实体批量 allow / 同实体第 6 次 steer / 附加参数不入签名）锁死行为。
3. **深潜成本降了吗**：降——每日对账、信号裁决、术语入库等批量流不再被熔断物理截断。

## 验证

- [x] tests/frameworks/agent/tool-call-circuit-breaker.test.ts 新增 8 用例（#1895 现场 3 + 同族五工具 5），全部通过
- [x] 无行为级回归风险：仅新增签名分支，不触碰检测/steer 核心逻辑

## 影响

- 每日产物对账段可连续批量归档（#1895 现场恢复）；信号裁决/术语入库/定时任务创建的异实体批量流同受益
- 与既有条款关系：本单是 #1399/#1802 签名表收口的工具面补全（archive 工具 + 五个带实体工具），不新增机制
