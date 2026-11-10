---
id: F20261110owner
title: 链接资源写路径补对话归属校验
change_type: fix
status: development
created_at: 2026-11-10
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
capability_test: "n/a: 纯后端归属与状态机修复，无 LLM 参与行为"
intent:
  problem: "PATCH flag 与 update_artifact_status 只按 resourceId 写，调用方 conversationId 未参与校验，存在跨对话修改"
  expected_effect: "两条写路径对未知或跨对话资源均拒绝 not_found，正确归属可写且非法状态仍 conflict；真实 HTTP/工具入口与 SQLite 行为一致"
  verify_by:
    type: behavior_check
causal_links:
  - F20261110archy
  - F20260720k3m7
summary: 将 conversationId 纳入 PATCH flag 和 update_artifact_status 的必填归属校验，复用统一资源归属闸，并以真实 HTTP、工具调用和 SQLite 证明跨对话写入被拒绝。
---

# 链接资源写路径补对话归属校验

## 问题

#1793 的独立审查发现 DELETE 之外还有同族写面：PATCH flag 只按 resourceId 修改；`update_artifact_status` 工具虽有 `ctx.conversationId`，却没有传入 usecase。两条路径都可能跨对话写，未知 ID 的 PATCH 还可能静默 200。

本 issue 由搭档 2026-11-10 14:21「继续处理下一个issue」接续开工。

## 修复契约

- `ManageKeyInfo` 新增统一 `requireOwnedResource(id, conversationId)`：未知或跨对话均 `DomainError(not_found)`，与 DELETE 的 404 口径一致。
- PATCH controller 把 URL `:id` 传入 `flagResource`；未知/跨对话 404，不再静默成功。
- `update_artifact_status` 工具把 `ctx.conversationId` 经 OtterToolClient 传入 `updateResourceStatus`；正确归属才进入状态机，非法状态仍 409。
- 归属参数为必填，不提供可选后门。repository 层 SQL 与表结构不变。
- 本 PR 不扩大到 supersede 或读取面；r3 已记录的死 `resource.archive` 端口不在本次清理。

## Acceptance Test

| 场景 | 权威证据 | 状态 |
|---|---|---|
| PATCH 未知 ID | 真实 HTTP 404，不再静默成功 | ✅ |
| PATCH 跨对话 | 真实 HTTP 404，SQLite user_flagged 不变 | ✅ |
| PATCH 正确归属 | HTTP 200，SQLite user_flagged=1 | ✅ |
| 工具跨对话 archived | 生产 client 装配下真实工具 execute 抛 not_found，SQLite status 不变 | ✅ |
| 工具正确归属 archived | 返回更新确认，SQLite status=archived | ✅ |
| 工具非法状态 | 二次 archived 抛 conflict，SQLite status 不变 | ✅ |
| 类型与既有行为 | 相关测试、tsc、ESLint、build、docs/intent/tests lint | ✅ |

## 验证记录

- 聚焦：5 文件 **47/47** 通过，含真实 HTTP、生产 `buildResourceClient` 装配、工具入口与 SQLite 归属/冲突回归。
- `npx tsc --noEmit`、`npm run build`、`npx eslint .` 通过。
- `lint:docs`、`lint:intent`、`lint:tests` 通过；intent 仅有存量 warning。
- 真 LLM 不适用。

## 独立审查

检视獭-1804 r1 **通过**，无严重问题。审查后用生产 client 装配替换手写桩，并补未知 ID 与 conflict 真实入口断言；上述最终复跑全绿。

## 残余风险与范围外跟进

- `supersedeResource` 在 usecase 层仍可对旧资源跨对话写；当前无 HTTP/工具入口，本 PR 不扩范围，已提 #1815 跟进。
- 工具归属值 `ctx.conversationId` 是创建期捕获值，其正确性依赖「一獭一对话、常驻 session 终身只服务一个对话」不变量；池命中不会刷新该值。若未来允许 session 跨对话复用，必须先重建/刷新工具上下文；该风险非本 diff 引入，也影响既有读取与发言路径。
