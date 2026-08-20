---
id: F20260820bcst
title: broadcaster-channel-isolation
doc_type: feature

summary: |
  Broadcaster 事件通道改造：broadcast 方法逐通道 catch 隔离。
  单通道失败不再阻塞后续通道，错误记日志后继续。

causal_links:
  from:
    - F20260817a3rt

status: development
change_type: refactor
tags: [im, broadcaster, error-handling, isolation]
modules:
  - src/usecases/im/
capability_test: "n/a: 纯代码逻辑重构（A 类），行为等价"
---

# F20260820bcst: broadcaster 事件通道改造——broadcast 方法逐通道 catch 隔离

## 背景

R20260817arnt（批次 3 设计文档）中 Part F 的目标是：
- onEvent 声明 `void | Promise<void>` **不 await** + 逐通道 catch 隔离
- 解决广播器通道抛错会中断后续通道的问题

## 实现内容

### 改动点

1. **broadcast 方法**：在消息通道循环中添加 try/catch 隔离
   - 单通道失败不再阻塞后续通道
   - 错误记日志后继续执行
   
2. **OutboundMessageChannel 接口注释**：更新为"逐通道 catch 隔离"

### 不变点

- `broadcastEvent` 方法已经实现了 try/catch 隔离（存量代码）
- `onEvent` 声明为 `void`（已是同步，无需 await）
- 行为等价：只添加错误隔离，不改变正常流程

## 改动范围

| 文件 | 操作 |
|------|------|
| src/usecases/im/message-broadcaster.ts | broadcast 方法添加 try/catch + 更新接口注释 |

## 验收结果

- TypeScript 编译通过（tsc --noEmit）
- 现有测试通过（tests/usecases/im/ 63 个用例）
- 行为等价（零运行时变更，纯错误隔离）

## 对抗审视记录

待审视。

## 变更记录

| 日期 | 变更 |
|------|------|
| 2026-08-20 | 初始版本 |
