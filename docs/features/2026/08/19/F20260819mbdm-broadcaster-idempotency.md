---
id: F20260819mbdm
title: MessageBroadcaster 幂等性：基于 messageId 的去重机制
summary: 为 MessageBroadcaster.broadcast 添加进程内 LRU 去重机制，防止飞书 webhook at-least-once 投递语义下重复广播消息。
change_type: bugfix
status: locked
created_in_conversation: bbcfaa33-f036-4493-94de-3faf1c6df6cf
modules:
  - src/usecases/im/message-broadcaster.ts
tags:
  - im
  - idempotency
  - dedup
from:
  - F20260819mbdm
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# MessageBroadcaster 幂等性

## 背景

PR #233 第五轮对抗审视发现：`MessageBroadcaster.broadcast` 缺少幂等性保证。飞书 webhook 是 at-least-once 投递语义，网络抖动/SDK 内部重试/webhook 重复调用时，broadcast 会被重复触发，导致飞书侧收到两条相同的 post md 消息。

## 修复方案

在 `broadcast()` 方法中增加进程内 LRU 去重机制：
- 使用 `Set<string>` 记录最近广播过的 messageId
- 同一 messageId 重复调用时直接跳过，记录 info 日志
- LRU 满时（1000 条）清空最旧的一半条目，避免内存无限增长

## 变更文件

- `src/usecases/im/message-broadcaster.ts`：新增去重逻辑
- `tests/usecases/im/message-broadcaster.test.ts`：新增 2 个幂等性测试

## 测试

- 同一 messageId 重复 broadcast 只投递一次
- 不同 messageId 正常投递
- 8 个测试全部通过

## 关联

- Issue: #241
- PR: https://github.com/chenlaicai/otter-buddy/pull/313
