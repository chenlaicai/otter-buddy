---
id: F20260811safe
title: process-safety-net
doc_type: feature

summary: |
  进程级安全网：为 Otter Buddy 服务器添加 uncaughtException/unhandledRejection/SIGTERM 全局处理器和 Hono app.onError 中间件，防止未处理异常导致进程裸死。

causal_links:
  from:
    - F20260728cbwt

status: development
change_type: fix
tags: [stability, error-handling]
modules:
  - src/main.ts
  - src/bootstrap/server.ts
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# F20260811safen: 进程级安全网

## 背景与需求

### 问题描述

2026-08-11 上午，生产环境 Otter Buddy 服务器（端口 3000）突然不可用。排查发现进程已死亡，无 graceful shutdown 日志。

### 根因分析

进程缺少全局错误安全网。`main.ts` 仅注册了 `SIGINT` handler，以下关键保护全部缺失：

1. **`process.on('uncaughtException')`** — 未捕获异常直接杀死进程
2. **`process.on('unhandledRejection')`** — 未处理 Promise rejection 直接杀死进程
3. **`SIGTERM` handler** — kill 信号无法优雅关闭
4. **Hono `app.onError()`** — HTTP handler 异常无兜底

应用层错误处理链（`classifyAndRoute` → `failTerminal`）设计完善，但它是纵深防御的中间层。任何穿透到进程级的未处理异常/rejection 都会触发 Node.js 默认行为：打印 stack trace + exit(1)。

### 数据实锤

日志证据（PID 85718，最后活动 11:43 AM）：
```
[circuit-breaker] CIRCUIT_BREAK: otter=f457aeea trigger=ignored_steer calls=20
LLM API error: Request aborted
```

circuit breaker 触发 → session.abort() → LLM API abort → 错误传播链中某环节（SDK 内部 callback/timer）抛出未被 catch 的异常 → Node.js 默认 exit(1)。日志中无任何 shutdown/graceful 记录，确认为硬死。

## 方案设计

### 技术方案

在 `main.ts` 添加 4 个进程级 handler，在 `server.ts` 添加 Hono `app.onError()` 中间件。

**设计原则**：
- `uncaughtException` handler 中仍然 exit(1) 而非忽略 — Node.js 官方建议，因进程状态可能已损坏
- 关键区别：先 log + dispose 再退出，而非裸死
- `unhandledRejection` 显式处理 — Node.js 未来版本默认行为就是 exit(1)

### 目标

- T1: 未处理异常/rejection 被捕获、记录日志、优雅关闭后退出
- T2: SIGTERM 信号触发优雅关闭
- T3: HTTP handler 异常返回 500 JSON 而非穿透

### 成功标准

- 进程级异常不再导致裸死（有日志、有 dispose）
- HTTP handler 异常返回结构化错误响应

## 验收标准

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | uncaughtException 被捕获 | 在 handler 中 throw 一个未捕获异常 | 日志记录异常，进程优雅退出（exit 1），数据库连接正常关闭 |
| AT-2 | unhandledRejection 被捕获 | 创建一个未处理的 Promise rejection | 日志记录 rejection，进程优雅退出（exit 1） |
| AT-3 | SIGTERM 触发优雅关闭 | `kill <pid>` 发送 SIGTERM | 日志记录关闭信号，进程正常退出（exit 0） |
| AT-4 | HTTP 异常返回 500 | 触发一个 HTTP handler 异常 | 返回 `{"error": "Internal server error"}` 500 响应 |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1 ~ AT-4 | n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为 |

## 实现细节

### 代码修改

**`src/main.ts`**：
- 添加 `gracefulShutdown` 函数，统一处理 SIGINT/SIGTERM
- 添加 `process.on('uncaughtException')` handler：log → dispose → exit(1)
- 添加 `process.on('unhandledRejection')` handler：log → dispose → exit(1)

**`src/bootstrap/server.ts`**：
- 在 `buildHttpApp` 中添加 `app.onError()` 中间件
- 捕获所有 HTTP handler 异常，返回 500 JSON 响应

### 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/main.ts | 修改 | 添加 4 个进程级 handler |
| src/bootstrap/server.ts | 修改 | 添加 Hono app.onError() 中间件 |

## 验收结果

### 测试结果

- `npx tsc --noEmit` 编译通过
- `npm test` 全部通过（88 文件，1053 用例）
- 进程级 handler 为 A 类代码逻辑，现有测试覆盖了正常路径；异常路径需生产环境验证

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1: uncaughtException/unhandledRejection 被捕获 | 证据不足 — 编译+测试通过，但未在运行时触发验证 | ❓ |
| T2: SIGTERM 触发优雅关闭 | 证据不足 — 编译+测试通过，但未在运行时触发验证 | ❓ |
| T3: HTTP 异常返回 500 | 证据不足 — 编译+测试通过，但未在运行时触发验证 | ❓ |

## 对抗审视记录

### 第一轮（PR #218，Claude 自审视）

**结论**：存在以下问题（决策者判断）

**非阻断发现**：
1. dispose() 抛异常时 uncaughtException handler 递归 → 已修复：try-catch dispose
2. 特性文档验收结果未填写 → 已补充（编译+测试通过，运行时验证待生产环境）
3. app.onError 返回 500 无 requestId → 已修复：从 context 读取 requestId 注入响应

## 设计决策

### D1: uncaughtException 仍然 exit(1) 而非忽略

**选择**：log + dispose + exit(1)

**理由**：Node.js 官方文档明确建议在 `uncaughtException` handler 中退出进程，因为未捕获异常意味着进程可能处于不一致状态。关键改进是"有日志、有 dispose"，而非"继续跑"。

**替代方案**：忽略异常继续运行 — 风险太高，可能导致数据损坏。
