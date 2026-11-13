---
id: F20261113recon
title: 跨对话受控对账归档路径 archive_artifact_for_reconciliation
doc_type: feature
summary: |
  落实 #1835：给每日健康检查一个受控跨对话归档入口——机械终态产物（pr/worktree/branch）
  可按资源 ID 全局定位归档并写审计三列，不放开普通 update_artifact_status 的归属闸。
change_type: fix
tags: [artifact, reconciliation, audit, health-check]
modules:
  - src/usecases/conversation/manage-key-info.ts
  - src/interface-adapters/agent-runtime/tools/artifact-tools.ts
  - src/frameworks/db/schema.ts
  - src/frameworks/db/migration.ts
  - prompts/scheduled/daily-health-check.md
capability_test: "n/a: 新工具为机械状态迁移（不依赖 LLM 语义判断），prompt 路由为确定性指令，无 golden 场景"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-11-13
intent:
  problem: "每日健康检查「产物清单对账段」需要把其他对话的机械终态产物（pr/worktree/branch）归档，但唯一写入口 update_artifact_status 硬编码 ctx.conversationId 且 requireOwnedResource 要求精确归属——跨对话写一律 404，无合法路径。#1835 扫描发现近 7 天活跃对话 894 个 active 产物滞留（34 PR / 25 worktree / 7 branch），机械可判的交付物对账断链。"
  expected_effect: "对账任务可用 archive_artifact_for_reconciliation 跨对话归档机械终态产物（写入审计三列），普通 update_artifact_status 对非所属对话仍 404（归属闸不松动）；fact/file/url/game 资源经对账路径被拒。"
  verify_by:
    type: behavior_check
---

# F20261113recon：跨对话受控对账归档路径

## 背景

#1835 案发现场：每日健康检查「产物清单对账段」的机械兜底需要把**其他对话**的
机械终态产物归档（pr MERGED/CLOSED、worktree 路径不存在、branch PR 已合入），但唯一
写入口 `update_artifact_status`（`artifact-tools.ts`）用 `ctx.conversationId` 定位 + 
`requireOwnedResource`（`manage-key-info.ts`）要求精确归属——跨对话写一律 404，无合法路径。
issue 扫描近 7 天活跃对话得到 894 个 active 产物滞留（34 PR / 25 worktree / 7 branch 为
机械可判交付物）。#654 级 healing 事件也记录 11-10 补齐权限边界后系统消费方未适配。

## 影响

机械可判的交付物无法在对账里收口归档，产物清单长期虚高；健康检查要么放弃对账、要么
用不可审计的方式绕过归属闸。

## 设计取舍

不放宽普通 `update_artifact_status` 的归属闸（跨对话仍 404），而是新增**受控对账归档
路径**，把跨对话写收口到一个明确场景：

1. **无需归属**——按资源 ID 全局定位（目标就是别的对话的产物）；
2. **只归档**——status → archived，不能 supersede、不能改其他字段；
3. **类型白名单**——仅 pr/worktree/branch（机械终态可判）；fact/file/url/game 一律拒绝；
4. **强制机器证据**——evidence ≥4 字符，写审计三列（archived_by_otter_id / archived_at /
   archive_evidence）；
5. **operator 注入**——工具按 ctx.otterId 注入，不信任入参。

## 修复

- **实体/映射/仓储**：`LinkedResource` 增 3 审计列；`updateResourceArchiveAudit` 独立审计
  写入（状态迁移成功后才写）。
- **usecase**：`ManageKeyInfo.archiveResourceForReconciliation`（无归属检查、只归档、
  白名单、证据校验、审计留痕）。
- **工具**：`archive_artifact_for_reconciliation`（参数 artifactId + evidence，operator
  由 ctx.otterId 注入），注册进 tool-factory。
- **schema/migration**：linked_resources 加 3 列（新库走 CREATE，存量库 PRAGMA 检测
  ALTER，幂等，同 ensureHealingEventsBoundIssueColumns 模式）。
- **客户端接线**：otter-tool-client 接口 + bootstrap/clients 包装。
- **prompt**：daily-health-check.md 产物清单对账段改路由——当前对话走
  `update_artifact_status`，其他对话走 `archive_artifact_for_reconciliation`。

## 不做的

- 不放开普通 `update_artifact_status` 的归属闸（跨对话仍 404）。
- 不让 fact/file/url/game 走对账路径（归档判定依赖人工，非机械可判）。

## 验证

- 集成测试 `tests/usecases/conversation/manage-key-info-reconciliation.integration.test.ts`
  4 条：跨对话归档成功留痕、fact 拒绝、证据缺失拒绝 + 重复归档冲突、工具入口 operator
  注入 + 普通路径仍 404（#1835 断言 1）。
- `npm run check` 全绿；`npx vitest run` 5966 passed（含存量库迁移冒烟双形态）。
- regression-verify 到期回查（2026-12-11）：近 7 天对账日志不再出现跨对话
  update_artifact_status 404；active 机械终态产物数下降。

## Rollback

git revert 本 PR 即回滚：新增列为可空加法，无破坏性变更；prompt 回退恢复旧路由；
usecase/工具为新入口，无存量调用方。
