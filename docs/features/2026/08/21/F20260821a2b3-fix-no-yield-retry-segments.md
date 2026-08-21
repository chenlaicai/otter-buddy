---
id: F20260821a2b3
title: 修复 no_yield 重试时 speak 内容丢失的问题
summary: 修复 handleYieldRetry 调用 prepareForRetry 时，resetForStreaming 无条件删除所有 segments，导致第一次 speak 内容丢失的问题。通过添加 preserveSegments 参数，在 no_yield 重试时保留 speak 内容。
change_type: bugfix
status: active
created_at: 2026-08-21
related_to: []
---

# 修复 no_yield 重试时 speak 内容丢失的问题

## 背景与需求

### 问题描述

在 `html展示优化` 对话中，用户观察到大獭只显示了最后一条 speak 内容，而之前的 speak 内容丢失了。

### 根因分析

通过日志分析和数据库查询，发现根因：

1. LLM 调用 speak → 成功，segment 写入 DB
2. LLM 生成文本"等你回复~"然后停止生成，没有调用 yield
3. Agent loop 以 `no_yield` 退出
4. Orchestrator 调用 `handleYieldRetry` → `failMessage` + `prepareForRetry`
5. **`prepareForRetry` 调用 `resetForStreaming`，删除了所有 segments！**
6. 新的 invoke 开始（retry）
7. LLM 先尝试 yield → 失败（segments 已被删除）
8. LLM 再次 speak → 成功（新 segment 写入）
9. LLM 调用 yield → 成功

**关键代码路径**：
```
orchestrator.ts: handleYieldRetry
  → callbacks.failMessage (插入 fail segment)
  → callbacks.prepareForRetry
    → send-message.ts: prepareForRetry
      → repo.resetForStreaming
        → DELETE FROM message_segments WHERE message_id = ?  ← 第一次 speak 的 segment 被删除！
```

### 问题本质

`resetForStreaming` 无条件删除所有 segments，但 `no_yield` 重试场景下，speak 内容是有效的，不应该被删除。这是一个 bug。

## 设计方案

### 修复思路

在 `prepareForRetry` 中添加 `preserveSegments` 参数，当为 `true` 时不删除 segments。

### 修改文件

1. **sqlite-conversation-repository.ts**：`resetForStreaming` 添加 `preserveSegments` 参数
2. **send-message.ts**：`prepareForRetry` 添加 `preserveSegments` 参数
3. **orchestrator.ts**：`handleYieldRetry` 传入 `preserveSegments: true`
4. **types.ts**：更新接口定义
5. **conversation-repository.ts**：更新接口定义
6. **agent-invoker.ts**：更新方法签名

### 测试覆盖

补充测试覆盖 `preserveSegments=true` 行为：
- 创建消息 → append segments → fail → prepareForRetry(messageId, true) → 验证 segments 保留

## 验收标准

- [x] 所有测试通过
- [x] 修复后第一次 speak 的内容会被保留
- [x] 补充测试覆盖 preserveSegments=true 行为
- [x] CI 通过

## 影响范围

- 影响模块：conversation（消息重试逻辑）
- 影响文件：6 个文件
- 破坏性变更：无（向后兼容）

## 取舍

### 取

- 添加 `preserveSegments` 参数，保留 `no_yield` 重试时的 speak 内容
- 更新 JSDoc 注释，说明参数行为

### 舍

- 无

## 验证

1. 单元测试：所有 1332 个测试通过
2. 集成测试：修复后第一次 speak 的内容会被保留
3. CI 验证：通过

## 参考

- 问题来源：对话《html展示优化》
- PR 链接：https://github.com/chenlaicai/otter-buddy/pull/358
