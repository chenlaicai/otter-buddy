---
id: F20260819x222
title: 修复 search_memory 高负载下 embed() 无超时导致卡死
summary: 修复 search_memory 高负载卡死问题。为 embed() 添加 30s 超时（Promise.race + setTimeout），超时后触发已有的 FTS5-only 降级逻辑，从卡死 10 分钟变为 30s 内返回降级结果。
change_type: bugfix
status: locked
created_in_conversation: bbcfaa33-f036-4493-94de-3faf1c6df6cf
modules:
  - src/frameworks/embedding/embedding-service.ts
tags:
  - embedding
  - timeout
  - resilience
from:
  - F20260819x222
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# 修复 search_memory 高负载下 embed() 无超时导致卡死

## 背景

Issue #306：search_memory 工具调用在 embedding 子系统高负载下卡死。PER_EVENT_TIMEOUT 后 prompt() 不解除阻塞，turn 永久悬挂。

## 根因分析

两个缺陷组合导致：

1. `EmbeddingService.embed()` 无超时机制：通过 worker.postMessage() 发送请求，返回的 Promise 仅在 worker 回复时 settle。Worker 卡死（ONNX Runtime 阻塞）时，Promise 永远不 settle。
2. `PER_EVENT_TIMEOUT` 只中止 session，不取消工具执行：600s 超时触发 session.abort() 中止 LLM 生成，但 search_memory 的 execute() 仍在阻塞等 embed() 的 Promise。

## 修复方案

为 embed() 添加 30s 超时（Promise.race + setTimeout）。

已有的降级逻辑：search-memory.ts 的 searchVec() 已有 catch → return [] 降级到 FTS5-only，只要 embed() 有超时就能正常降级。

修复后效果：从"卡死 10 分钟"变为"30s 内返回 FTS5-only 降级结果"。

## 变更文件

- `src/frameworks/embedding/embedding-service.ts`：添加 30s 超时逻辑
- `tests/frameworks/embedding/embedding-service.test.ts`：添加测试验证超时行为

## 测试

- 验证 embed() 正常路径不受影响
- 验证 embed() 超时时正确抛出 timeout 错误
- 验证 searchVec() 降级到 FTS5-only

## 关联

- Issue: #306
- PR: https://github.com/chenlaicai/otter-buddy/pull/330
