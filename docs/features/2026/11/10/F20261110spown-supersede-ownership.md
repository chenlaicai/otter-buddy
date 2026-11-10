---
id: F20261110spown
title: supersede 旧资源补对话归属校验
change_type: fix
status: development
created_at: 2026-11-10
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
capability_test: "n/a: 纯后端 usecase 归属与状态机修复，无 LLM 参与行为"
intent:
  problem: "supersedeResource 只按 existingId 修改旧资源，未校验旧资源是否属于 newInput.conversationId，未来开放入口会造成跨对话写"
  expected_effect: "未知或跨对话旧资源均 not_found 且 SQLite 不变；正确归属仍原子替代旧资源，既有 conflict 状态机不变"
  verify_by:
    type: behavior_check
causal_links:
  - F20261110owner
  - F20260829gvid
summary: supersedeResource 复用统一 requireOwnedResource 归属闸，以真实 SQLite 覆盖未知、跨对话、正确替代与冲突路径，不开放新的 HTTP 或工具入口。
---

# supersede 旧资源补对话归属校验

## 问题

#1804 独立审查 S5 实证：`supersedeResource(existingId, newInput)` 只用 ID 读取旧资源，可将另一对话的旧资源置为 superseded。当前 `resource.supersede` 无 HTTP/工具入口，因此本 issue 修 usecase 层潜在写越权，不新增入口。

## 修复契约

- 输入形态校验保持原顺序；随后以 `existingId + newInput.conversationId` 调用统一 `requireOwnedResource`。
- 未知或跨对话统一 `DomainError(not_found)`，不得改旧资源、创建新资源或写记忆索引。
- 正确归属后沿用既有 `canTransitionArtifactStatus`、groupId 继承和原子替代逻辑；已 superseded 的旧资源再次替代仍 conflict。
- repository SQL、HTTP/工具接口与数据表不变。

## Acceptance Test

| 场景 | 权威证据 | 状态 |
|---|---|---|
| 未知旧资源 | 真实 usecase + SQLite 抛 not_found，行数与旧状态不变 | ✅ |
| 跨对话旧资源 | newInput.conversationId 不匹配时 not_found，旧资源仍 active，无新行/索引 | ✅ |
| 正确归属替代 | 新资源 active，旧资源 superseded 且 supersededBy 指向新资源 | ✅ |
| 非法状态 | 二次 supersede 抛 conflict，行数不变 | ✅ |
| 既有行为与静态闸 | 聚焦测试、tsc、ESLint、build、docs/intent/tests lint | ✅ |

## 验证记录

- 聚焦及相邻归属回归 5 文件 **38/38** 通过，含真实 usecase + SQLite 的未知、跨对话、正确替代与 conflict 回归。
- `npx tsc --noEmit`、`npm run build`、`npx eslint .` 通过。
- `lint:docs`、`lint:intent`、`lint:tests` 通过；intent 仅有存量 warning。
- 真 LLM 不适用。

## 独立审查

检视獭-1815 r1 **通过**，无阻断项或严重项。其独立 SQLite 探针验证失败路径完整行快照与索引不变，正确归属、groupId 继承和 conflict 均正常；审查后已补真实 `conv-other` 夹具、完整旧行快照与 conflict 后索引次数断言，最终 38/38 复跑通过。
