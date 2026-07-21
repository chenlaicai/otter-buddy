---
id: F20260721de6j
title: observability-logging
doc_type: feature

# 记忆索引
summary: |
  构建生产级可观测性基础设施：结构化日志、HTTP 请求日志、错误日志、Agent 调用链路日志、
  业务操作审计日志。目标是让系统在出问题时能快速定位，而非只能看到"出错了"。

# 因果链路（正向依赖）
causal_links:
  from: []

# 元数据
status: draft
change_type: feature
tags: [observability, logging, tracing, governance]
modules: [frameworks/logger, interface-adapters/http, usecases]

# 时间
created_at: 2026-07-21
---

# F20260721de6j - 可观测性与日志基础设施

## 1. 需求背景

### 1.1 问题陈述

当前项目的日志能力仅处于开发调试阶段，存在以下关键缺陷：

**日志基础设施薄弱**
- `frameworks/logger.ts` 仅是 `console` 的薄封装，无结构化输出、无级别控制、无格式配置
- 全项目仅 13 处 logger 调用 + 3 处直接 console.warn，覆盖严重不足

**关键路径无日志**
- HTTP 请求层：无请求日志中间件，请求方法/路径/状态码/耗时完全无记录
- 错误处理：`handleError()` 吞掉错误只返回 JSON，不记录任何日志
- Agent 调用链路：duration 算了但没输出，开始/结束/token 用量无日志
- 业务操作：Session 创建/归档/交接、消息发送/完成/失败均无审计日志

**无法追溯问题**
- 生产出问题时，无法知道谁在调什么接口、响应多久、返回什么状态码
- Agent 调用失败时，无法知道失败原因、token 消耗、执行时长
- 业务状态变更时，无法回溯操作历史

### 1.2 用户意图锚

| UA | 用户原话 | 来源 | 关键修饰语 | 架构师解读 |
|----|---------|------|-----------|-----------|
| UA-1 | "trace或者governance是一个系统能够长久运行的重要运维必要能力！" | 消息 #1 | 重要、运维、必要 | 强调这不是可选功能，是系统长期运行的基础设施 |
| UA-2 | "各个关键位置都要有日志输出！" | 消息 #1 | 关键位置、都要 | 覆盖必须全面，不能有盲区 |
| UA-3 | "输出的日志内容要有价值！而不是流水账毫无意义！" | 消息 #1 | 有价值、不是流水账 | 日志必须包含上下文信息，能支持问题定位 |

### 1.3 设计目标

1. **升级日志基础设施**：从 console 薄封装升级为结构化日志，支持 JSON 输出、级别控制、字段标准化
2. **消除关键盲区**：在 HTTP 层、错误处理、Agent 链路、业务操作四个维度补齐日志
3. **确保日志价值**：每条日志必须包含足够上下文（who/what/when/where/result），能支持问题定位
4. **解决架构约束**：采用依赖反转，一次性完成所有代码的 logger 注入迁移

---

## 2. 用户意图锚（详细）

### 2.1 原始需求

**用户原话 #1**（消息 #1）：
> trace或者governance是一个系统能够长久运行的重要运维必要能力！因此，你先分析下当前项目实现了哪些？看还欠缺哪些！至少我期望说，各个关键位置都要有日志输出！并且输出的日志内容要有价值！而不是流水账毫无意义！

### 2.2 修饰语提取

**UA-1 修饰语**：
- 空间：无
- 时序：无
- 数量：无
- 条件：无
- 视觉属性：无
- **语义强调**：重要、运维、必要 → 这是系统长期运行的基础设施，不是可选功能

**UA-2 修饰语**：
- 空间：关键位置
- 时序：无
- 数量：都要（全覆盖）
- 条件：无
- 视觉属性：无
- **语义强调**：覆盖必须全面，不能有盲区

**UA-3 修饰语**：
- 空间：无
- 时序：无
- 数量：无
- 条件：无
- 视觉属性：无
- **语义强调**：有价值、不是流水账 → 日志必须包含上下文，能支持问题定位

### 2.3 架构师解读

**解读 #1**：用户强调可观测性是系统长期运行的基础设施。这意味着：
- 不能是临时方案或开发阶段的调试工具
- 必须是生产级的、可配置的、可维护的
- 需要覆盖系统的关键路径，不能有盲区

**解读 #2**：用户要求"关键位置都要有日志输出"。这意味着：
- HTTP 请求层（方法、路径、状态码、耗时）
- 错误处理（不能静默吞掉错误）
- Agent 调用链路（开始、结束、token 用量、成功/失败）
- 业务操作（Session 管理、消息处理、文档同步等）

**解读 #3**：用户要求"日志内容要有价值，不是流水账"。这意味着：
- 每条日志必须包含足够上下文（who/what/when/where/result）
- 不能只是"something happened"，必须是"who did what, when, where, and what was the result"
- 结构化日志比纯文本更有价值，因为可以机器解析和查询

---

## 3. 设计方案

### 3.1 日志基础设施升级

#### 3.1.1 结构化日志库选型

**推荐方案**：使用 `pino` 作为结构化日志库

**技术理由**：
- 性能最优（比 winston 快 5-10 倍）
- 原生 JSON 输出，适合生产环境
- 支持日志级别配置
- 支持 child logger（添加上下文字段）
- 生态成熟，有 pino-pretty 用于开发环境

**风险说明**：
- 需要修改现有的 logger 接口
- 需要将 Logger 接口从 frameworks 层移动到 usecases 层
- 需要修改所有直接导入 logger 的地方为构造函数注入

**替代方案**：winston（功能更丰富但性能较差）

**确认请求**：是否同意使用 pino 作为结构化日志库？

#### 3.1.2 Logger 接口设计

```typescript
// src/usecases/ports/logger.ts — 接口定义在 usecases 层（高层模块）
export interface Logger {
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, error?: Error, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
}

export interface LogContext {
  [key: string]: unknown;
  // 标准字段
  requestId?: string;      // HTTP 请求 ID
  otterId?: string;        // Otter ID
  conversationId?: string; // 对话 ID
  sessionId?: string;      // Session ID
  userId?: string;         // 用户 ID
  module?: string;         // 模块名
  duration?: number;       // 耗时（ms）
  statusCode?: number;     // HTTP 状态码
}

// src/frameworks/logger.ts — 实现在 frameworks 层（低层模块）
import pino from 'pino';
import type { Logger, LogContext } from '@usecases/ports/logger';

export class PinoLogger implements Logger {
  private pino: pino.Logger;

  constructor(optionsOrLogger?: pino.LoggerOptions | pino.Logger) {
    if (optionsOrLogger && 'child' in optionsOrLogger) {
      // 传入的是 pino.Logger 实例
      this.pino = optionsOrLogger;
    } else {
      // 传入的是配置选项
      this.pino = pino(optionsOrLogger as pino.LoggerOptions);
    }
  }

  info(message: string, context?: LogContext): void {
    this.pino.info(context, message);
  }

  warn(message: string, context?: LogContext): void {
    this.pino.warn(context, message);
  }

  error(message: string, error?: Error, context?: LogContext): void {
    this.pino.error({ ...context, err: error }, message);
  }

  debug(message: string, context?: LogContext): void {
    this.pino.debug(context, message);
  }

  child(context: LogContext): Logger {
    return new PinoLogger(this.pino.child(context));
  }
}
```

#### 3.1.3 解决架构约束

**问题**：当前 Logger 接口和实现都在 frameworks 层，通过 D39 豁免允许 usecases 层直接导入。这违反了依赖反转原则（DIP）。

**现状分析**：
- Logger 已有 D39 豁免：usecases 层可以直接导入 `@frameworks/logger`
- 但 Config 的处理方式是正确的：Config 实现在 frameworks 层，通过 main.ts 构造函数注入到 usecases 层
- Logger 应该采用与 Config 一致的方式

**方案**：一次性完成依赖反转迁移

**具体做法**：
1. 在 `src/usecases/ports/logger.ts` 定义 Logger 接口
2. 在 `src/frameworks/logger.ts` 实现 Logger 接口（PinoLogger）
3. **移除 D39 豁免**：所有层都不能直接导入 `@frameworks/logger`
4. **所有代码改为依赖注入**：本次 PR 完成所有 15+ 个文件的迁移
5. **在 main.ts 统一注入**：Composition Root 负责实例化和注入 logger

**理由**：
- 保持架构一致性，所有代码都使用依赖注入
- 避免过渡期内存在两种 logger 使用方式
- 一次性完成，避免后续 PR 的迁移成本
- 符合 Clean Architecture 的标准做法

### 3.2 HTTP 请求日志中间件

#### 3.2.1 请求日志格式

```json
{
  "level": "info",
  "time": "2026-07-21T10:30:00.000Z",
  "message": "HTTP request completed",
  "requestId": "req_abc123",
  "method": "POST",
  "path": "/api/conversations/send",
  "statusCode": 200,
  "duration": 150,
  "userAgent": "Mozilla/5.0...",
  "ip": "127.0.0.1"
}
```

#### 3.2.2 Request ID 生成

- 在中间件中生成唯一 request ID（格式：`req_${nanoid}`）
- 通过 `X-Request-ID` header 返回给客户端
- 将 requestId 注入到 Hono context，供后续日志使用

#### 3.2.3 实现位置

在 `src/interface-adapters/http/router.ts` 中添加中间件：

```typescript
app.use('*', async (c, next) => {
  const requestId = `req_${nanoid()}`;
  const start = Date.now();

  // 注入 requestId 到 context
  c.set('requestId', requestId);
  c.header('X-Request-ID', requestId);

  await next();

  const duration = Date.now() - start;
  logger.info('HTTP request completed', {
    requestId,
    method: c.req.method,
    path: c.req.path,
    statusCode: c.res.status,
    duration,
  });
});
```

### 3.3 错误日志

#### 3.3.1 修改 handleError 函数

当前 `handleError()` 只返回 JSON 响应，不记录错误。保持现有签名不变，添加日志逻辑：

```typescript
// 保持现有签名不变：handleError(c: Context, err: unknown): Response
export function handleError(c: Context, err: unknown): Response {
  const appError = normalizeError(err);
  const requestId = c.get('requestId');

  // 记录错误日志
  logger.error('Request failed', appError, {
    requestId,
    errorCode: appError.code,
    statusCode: appError.statusCode,
    isOperational: appError.isOperational,
  });

  return createErrorResponse(appError);
}
```

#### 3.3.2 错误日志格式

```json
{
  "level": "error",
  "time": "2026-07-21T10:30:00.000Z",
  "message": "Request failed",
  "requestId": "req_abc123",
  "errorCode": "VALIDATION_ERROR",
  "statusCode": 400,
  "isOperational": true,
  "stack": "Error: ...\n    at ...",
  "context": {
    "field": "conversationId",
    "value": "invalid_id"
  }
}
```

### 3.4 Agent 调用链路日志

#### 3.4.1 调用开始日志

```typescript
// agent-invoker.ts
async invokeConversation(request: InvokeRequest): Promise<InvokeResponse> {
  const startTime = Date.now();
  const requestId = request.requestId;

  logger.info('Agent invocation started', {
    requestId,
    otterId: request.otterId,
    conversationId: request.conversationId,
    sessionId: request.sessionId,
    messageLength: request.message.length,
  });

  // ... 原有逻辑
}
```

#### 3.4.2 调用结束日志

```typescript
// 成功路径
logger.info('Agent invocation completed', {
  requestId,
  otterId: request.otterId,
  conversationId: request.conversationId,
  duration: Date.now() - startTime,
  tokenUsage: response.tokenUsage,
  status: 'success',
});

// 失败路径
logger.error('Agent invocation failed', error, {
  requestId,
  otterId: request.otterId,
  conversationId: request.conversationId,
  duration: Date.now() - startTime,
  status: 'failed',
  errorCode: error.code,
});
```

#### 3.4.3 熔断器事件日志

当前熔断器只有 warn 级别日志，需要结构化：

```typescript
logger.warn('Circuit breaker triggered', {
  otterId,
  conversationId,
  reason: 'consecutive_same_tool',
  toolName: 'search_memory',
  consecutiveCount: 5,
  threshold: 3,
});
```

### 3.5 业务操作审计日志

#### 3.5.1 Session 管理操作

```typescript
// manage-session.ts
logger.info('Session created', {
  otterId,
  sessionId: session.id,
  conversationId,
  action: 'create',
});

logger.info('Session archived', {
  otterId,
  sessionId,
  conversationId,
  reason: 'handoff',
  action: 'archive',
});
```

#### 3.5.2 消息处理操作

```typescript
// send-message.ts
logger.info('Message sent', {
  conversationId,
  messageId: message.id,
  messageLength: message.content.length,
  action: 'send',
});

logger.info('Message completed', {
  conversationId,
  messageId,
  duration,
  tokenUsage,
  action: 'complete',
});
```

#### 3.5.3 文档同步操作

```typescript
// sync-documents.ts
logger.info('Document sync started', {
  documentId,
  documentType: document.type,
  action: 'sync_start',
});

logger.info('Document sync completed', {
  documentId,
  duration,
  chunksCreated,
  action: 'sync_complete',
});
```

### 3.6 Worker Thread 日志处理

**问题**：`src/frameworks/embedding/embedding-service.ts` 中的 `EmbeddingServiceImpl` 通过 Worker Thread 运行 bge-m3 模型。

**方案**：Worker Thread 通过 postMessage 将日志发送回主线程记录

**具体做法**：
1. 定义 Worker 日志协议：Worker Thread 通过 postMessage 发送结构化日志消息
2. 主线程日志代理：主线程接收 Worker 日志并记录到主 logger
3. 上下文传递：在 EmbedRequest 中携带 requestId，Worker 在日志消息中返回
4. 正常运行日志：记录模型加载进度、推理耗时、队列长度等

**Worker 日志消息格式**：
```typescript
interface WorkerLogMessage {
  type: 'log';
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  context?: {
    requestId?: string;
    duration?: number;
    queueLength?: number;
    [key: string]: unknown;
  };
}
```

**理由**：
- Worker Thread 与主线程通过 postMessage 通信，无法直接共享 logger 实例
- 通过结构化日志消息可以保持 requestId 关联
- 覆盖正常运行日志，消除可观测性盲区

### 3.7 SSE 流式响应日志

**问题**：`src/interface-adapters/http/sse-streamer.ts` 是长时间运行的 SSE 连接。

**方案**：记录 SSE 连接的生命周期日志

**具体做法**：
- 连接建立时记录 `info` 级别日志（requestId、conversationId）
- 连接关闭时记录 `info` 级别日志（关闭原因、持续时长）
- 异常断开记录 `warn` 级别日志
- 事件推送不记录（会产生大量无价值日志）

**理由**：
- SSE 连接的生命周期是关键可观测点
- 事件推送会产生大量日志，但价值不高
- 异常断开需要记录，便于排查连接泄漏问题

### 3.8 数据库操作日志

**问题**：`src/frameworks/db/database.ts` 中的 `initDatabase` 和 `closeDatabase` 是关键操作。

**方案**：记录数据库操作的生命周期日志

**具体做法**：
- `initDatabase` 成功时记录 `info` 级别日志（路径、WAL 模式、sqlite-vec 状态）
- `closeDatabase` 时记录 `debug` 级别日志
- 查询耗时超过阈值（如 100ms）记录 `warn` 级别日志

**理由**：
- 数据库连接是系统关键资源
- 连接泄漏和查询性能问题需要可观测
- 慢查询记录有助于性能优化

### 3.9 日志轮转方案

**问题**：pino 本身不提供日志轮转功能。

**方案**：使用 `pino-roll` 进行日志轮转

**具体做法**：
- 在配置中添加轮转参数（最大文件大小、保留天数）
- 使用 `pino-roll` 作为 pino 的 transport
- 默认配置：最大文件 100MB，保留 7 天

**配置示例**：
```yaml
logging:
  output: stdout  # stdout | file
  filePath: ./logs/app.log
  rotation:
    maxSize: 100m
    maxAge: 7d
    maxFiles: 5
```

**理由**：
- `pino-roll` 是 pino 生态的官方轮转方案
- 配置简单，无需环境检测
- 防止生产环境日志文件占满磁盘

### 3.10 日志配置

#### 3.10.1 配置文件格式

```yaml
# config.yaml
logging:
  level: info          # debug / info / warn / error
  format: json         # json / pretty
  output: auto         # auto | stdout | file
  filePath: ./logs/app.log
  enableRequestLogging: true
  enableAgentLogging: true
  enableAuditLogging: true
  rotation:
    maxSize: 100m      # 最大文件大小
    maxAge: 7d         # 保留天数
    maxFiles: 5        # 最大文件数
```

#### 3.10.2 环境变量覆盖

```bash
LOG_LEVEL=debug
LOG_FORMAT=pretty
LOG_OUTPUT=stdout
LOG_FILE_PATH=./logs/app.log
```

---

## 4. 核心业务行为

| ID | 触发条件 | 预期行为 | ← UA |
|----|---------|---------|------|
| B-1 | HTTP 请求到达时 | 生成唯一 requestId，记录请求开始 | ← UA-2 |
| B-2 | HTTP 请求完成时 | 记录请求方法、路径、状态码、耗时 | ← UA-2, UA-3 |
| B-3 | HTTP 请求失败时 | 记录错误详情、堆栈、上下文 | ← UA-2, UA-3 |
| B-4 | Agent 调用开始时 | 记录 otterId、conversationId、sessionId | ← UA-2, UA-3 |
| B-5 | Agent 调用结束时 | 记录 duration、tokenUsage、成功/失败状态 | ← UA-2, UA-3 |
| B-6 | 熔断器触发时 | 记录触发原因、工具名、计数、阈值 | ← UA-2, UA-3 |
| B-7 | Session 创建/归档/交接时 | 记录操作类型、相关 ID、原因 | ← UA-2, UA-3 |
| B-8 | 消息发送/完成/失败时 | 记录消息 ID、长度、duration、状态 | ← UA-2, UA-3 |
| B-9 | 文档同步开始/完成时 | 记录文档 ID、类型、duration、结果 | ← UA-2, UA-3 |
| B-10 | 日志输出时 | 必须是结构化 JSON，包含足够上下文 | ← UA-3 |
| B-11 | SSE 连接建立时 | 记录 requestId、conversationId | ← UA-2 |
| B-12 | SSE 连接关闭时 | 记录关闭原因、持续时长 | ← UA-2 |
| B-13 | SSE 连接异常断开时 | 记录 warn 级别日志 | ← UA-2 |
| B-14 | 数据库初始化成功时 | 记录路径、WAL 模式、sqlite-vec 状态 | ← UA-2 |
| B-15 | 数据库查询慢时 | 记录 warn 级别日志（耗时 > 100ms） | ← UA-2 |
| B-16 | Worker Thread 日志时 | 通过 postMessage 发送结构化日志消息到主线程记录 | ← UA-2 |
| B-17 | 配置加载失败时 | 记录 error 级别日志，包含配置路径和错误原因 | ← UA-2 |
| B-18 | 模型初始化失败时 | 记录 error 级别日志，包含模型类型和错误原因 | ← UA-2 |
| B-19 | Schema 初始化失败时 | 记录 error 级别日志，包含错误原因 | ← UA-2 |
| B-20 | 种子数据导入失败时 | 记录 error 级别日志，包含错误原因 | ← UA-2 |
| B-21 | 日志写入失败时 | 降级到 console 输出，不导致应用崩溃 | ← UA-2 |
| B-22 | 进程退出时 | 刷新日志缓冲区，确保最后一条日志能被持久化 | ← UA-2 |

---

## 5. 设计约束摘要

### 5.1 架构约束

- **Clean Architecture 分层**：Logger 接口定义在 usecases 层，实现在 frameworks 层，通过依赖注入传递
- **ESLint 规则**：现有 `no-console` 规则必须保留，logger 是唯一的日志出口；移除 D39 豁免
- **向后兼容**：所有现有 logger 调用改为构造函数注入，保持 Logger 接口兼容（info/warn/error/debug）
- **日志系统容错**：日志写入失败不能导致应用崩溃，降级到 console 输出
- **进程崩溃持久化**：进程退出时刷新日志缓冲区，确保最后一条日志能被持久化

### 5.2 性能约束

- **日志性能**：日志写入不能阻塞主线程，pino 的异步写入必须启用
- **内存占用**：日志缓冲区大小必须可配置，防止内存泄漏
- **磁盘空间**：日志文件必须支持轮转（log rotation），防止磁盘占满

### 5.3 安全约束

- **敏感信息**：日志中不能包含密码、token、密钥等敏感信息
- **访问控制**：日志文件权限必须限制，只有授权用户可读

### 5.4 日志系统容错

**问题**：日志系统本身可能出现故障（磁盘空间不足、权限问题、序列化失败等）。

**方案**：日志写入失败时降级到 console 输出

**具体做法**：
1. **日志写入失败不能导致应用崩溃**
2. **日志写入失败时，降级到 console 输出**（保持当前行为）
3. **记录日志系统自身的错误**（meta-logging），但避免无限递归
4. **在性能验收标准中添加**："日志系统故障时应用仍能正常运行"

**理由**：
- 日志系统不应成为系统的单点故障
- 降级到 console 输出可以保持基本的日志能力
- 避免因日志系统故障导致应用崩溃

### 5.5 进程崩溃时日志持久化

**问题**：进程非优雅退出时，缓冲区中的日志可能丢失。

**方案**：在进程退出处理中刷新日志缓冲区

**具体做法**：
1. **在进程退出处理中添加 `logger.flush()` 调用**（pino 支持同步刷新缓冲区）
2. **对于致命错误**（uncaughtException、unhandledRejection），使用 pino 的同步写入模式记录最后一条日志
3. **在 main.ts 的 `process.on("SIGINT")` 处理中添加 `logger.flush()` 调用**

**理由**：
- 进程崩溃时的日志是最有价值的调试信息
- pino 默认使用异步写入，缓冲区中的日志可能丢失
- 刷新缓冲区可以确保最后一条日志能被持久化

### 5.6 日志上下文传播机制

**问题**：requestId 如何在整个调用链路中传播？

**方案**：通过 Hono context -> Controller -> UseCase -> Framework 逐层传递

**具体做法**：
1. **在 HTTP 中间件中生成 requestId**，注入到 Hono context
2. **Controller 从 context 获取 requestId**，传递给 UseCase
3. **UseCase 通过构造函数注入的 logger 记录日志**，logger 自动携带 requestId
4. **在 Worker Thread 中，通过 EmbedRequest 携带 requestId**

**替代方案**：使用 Node.js 的 `AsyncLocalStorage` 实现隐式上下文传播（更优雅但需要 Node.js 12.17+）

**理由**：
- requestId 是日志关联的关键字段
- 通过逐层传递可以确保 requestId 在整个调用链路中传播
- 使用 child logger 可以自动携带 requestId

---

## 6. 关键决策记录

### 决策 #1：结构化日志库选型

**决策点**：选择 pino 还是 winston 作为结构化日志库？

**正方论点（pino）**：
- 性能最优（比 winston 快 5-10 倍）
- 原生 JSON 输出，适合生产环境
- 生态成熟，有 pino-pretty 用于开发环境

**反方论点（winston）**：
- 功能更丰富（支持多种 transport）
- 社区更大，文档更全
- 已有项目使用 winston，团队更熟悉

**最终决策**：选择 pino

**决策依据**：
- 性能是日志库的核心指标，pino 性能优势明显
- JSON 输出是生产环境的标准格式，pino 原生支持
- pino-pretty 解决了开发环境的可读性问题

**参与者**：架构师-1

### 决策 #2：解决 Logger 的架构约束问题

**决策点**：如何让所有层都能使用 logger？

**正方论点（一次性迁移）**：
- 保持架构一致性，所有代码都使用依赖注入
- 避免过渡期内存在两种 logger 使用方式
- 一次性完成，避免后续 PR 的迁移成本

**反方论点（渐进式迁移）**：
- 降低单次 PR 的风险
- 允许分批提交和验证，保持 CI 绿色
- 现有代码无需修改，减少回归风险

**最终决策**：采用一次性迁移

**决策依据**：
- 用户明确要求一次性完成，不要残留后续逐步迁移
- 保持架构一致性
- 避免过渡期内存在两种 logger 使用方式

**参与者**：架构师-1、架构师-2、用户

**风险缓解措施**：
1. **一次性完成所有文件变更**：本次 PR 完成所有 15+ 个文件的迁移
2. **通过完整测试套件验证**：运行所有单元测试和集成测试，确保行为不变
3. **保留旧 logger 接口**：在迁移期间保持旧接口兼容，迁移完成后移除

### 决策 #3：PinoLogger.child() 实现方式

**决策点**：如何实现 PinoLogger.child() 方法？

**正方论点（构造函数重载）**：
- 构造函数支持 `pino.LoggerOptions | pino.Logger` 两种参数
- child() 方法可以直接传入 pino.Logger 实例
- 代码简洁，易于理解

**反方论点（工厂方法）**：
- 使用静态工厂方法创建 PinoLogger
- 构造函数只接受 pino.LoggerOptions
- 更符合单一职责原则

**最终决策**：采用构造函数重载

**决策依据**：
- 构造函数重载更简洁
- pino 本身也支持类似的重载模式
- 减少代码复杂度

**参与者**：架构师-1、架构师-2（通过对抗性审视发现类型错误）

### 决策 #4：handleError 签名保持向后兼容

**决策点**：如何修改 handleError 函数添加日志？

**正方论点（保持现有签名）**：
- 保持现有签名 `handleError(c: Context, err: unknown): Response`
- 在函数内部添加日志逻辑
- 所有现有调用点无需修改

**反方论点（修改签名）**：
- 修改为 `handleError(error: unknown, requestId?: string): Response`
- 参数顺序更合理（error 在前）
- 需要修改所有调用点

**最终决策**：保持现有签名

**决策依据**：
- 向后兼容，减少修改点
- 现有调用点无需修改
- 降低回归风险

**参与者**：架构师-1、架构师-2（通过对抗性审视发现签名变更风险）

### 决策 #5：Worker Thread 日志处理方案

**决策点**：Worker Thread 中的日志如何处理？

**正方论点（postMessage 结构化日志协议）**：
- Worker Thread 通过 postMessage 发送结构化日志消息到主线程
- 主线程接收 Worker 日志并记录到主 logger
- 覆盖正常运行日志，消除可观测性盲区
- 通过 EmbedRequest 携带 requestId，保持上下文关联

**反方论点（仅通过 error 事件上报）**：
- 只上报错误，不记录正常运行日志
- 实现简单
- 但会丢失 Worker Thread 的正常运行日志

**最终决策**：采用 postMessage 结构化日志协议

**决策依据**：
- Worker Thread 与主线程通过 postMessage 通信，无法直接共享 logger 实例
- 通过结构化日志消息可以保持 requestId 关联
- 覆盖正常运行日志，消除可观测性盲区
- 记录模型加载进度、推理耗时、队列长度等关键信息

**参与者**：架构师-1、架构师-2（通过对抗性审视发现方案不一致）

### 决策 #6：SSE 日志方案

**决策点**：SSE 流式响应如何记录日志？

**正方论点（仅记录生命周期）**：
- 连接建立时记录 `info` 级别日志
- 连接关闭时记录 `info` 级别日志
- 异常断开记录 `warn` 级别日志
- 事件推送不记录（会产生大量无价值日志）

**反方论点（记录所有事件）**：
- 记录每个 SSE 事件推送
- 可以追踪完整的事件流
- 但会产生大量日志，价值不高

**最终决策**：采用仅记录生命周期

**决策依据**：
- SSE 连接的生命周期是关键可观测点
- 事件推送会产生大量日志，但价值不高
- 异常断开需要记录，便于排查连接泄漏问题

**参与者**：架构师-1、架构师-2（通过对抗性审视发现遗漏场景）

### 决策 #7：数据库日志方案

**决策点**：数据库操作如何记录日志？

**正方论点（记录关键操作）**：
- `initDatabase` 成功时记录 `info` 级别日志
- `closeDatabase` 时记录 `debug` 级别日志
- 查询耗时超过阈值（如 100ms）记录 `warn` 级别日志

**反方论点（记录所有查询）**：
- 记录所有数据库查询
- 可以追踪完整的查询历史
- 但会产生大量日志，影响性能

**最终决策**：采用记录关键操作

**决策依据**：
- 数据库连接是系统关键资源
- 连接泄漏和查询性能问题需要可观测
- 慢查询记录有助于性能优化
- 记录所有查询会影响性能

**参与者**：架构师-1、架构师-2（通过对抗性审视发现遗漏场景）

### 决策 #8：日志轮转方案

**决策点**：如何实现日志轮转？

**正方论点（使用 pino-roll）**：
- `pino-roll` 是 pino 生态的官方轮转方案
- 配置简单，无需系统级运维
- 防止生产环境日志文件占满磁盘

**反方论点（使用系统级 logrotate）**：
- `logrotate` 是 Linux 系统标准工具
- 功能更强大，支持更多配置
- 需要运维配置，增加部署复杂度

**最终决策**：采用 pino-roll

**决策依据**：
- `pino-roll` 是 pino 生态的官方轮转方案
- 配置简单，无需系统级运维
- 与 pino 集成更好
- 默认配置：最大文件 100MB，保留 7 天

**参与者**：架构师-1、架构师-2（通过对抗性审视发现日志轮转方案缺失）



### 决策 #11：Logger 接口定义位置

**决策点**：Logger 接口应该定义在哪一层？

**正方论点（定义在 usecases 层）**：
- 符合依赖反转原则（DIP）：高层模块定义接口，低层模块实现
- 与 Config 的处理方式保持一致
- 所有层都能访问 usecases 层的接口

**反方论点（定义在 frameworks 层）**：
- Logger 是基础设施组件，应该在 frameworks 层
- 通过 D39 豁免允许其他层直接导入
- 实现更简单

**最终决策**：定义在 usecases 层

**决策依据**：
- 符合依赖反转原则（DIP）
- 与 Config 的处理方式保持一致
- 依赖方向正确：usecases 定义接口，frameworks 实现

**参与者**：架构师-1、用户（通过质疑触发深入分析）

### 决策 #12：日志格式标准化

**决策点**：日志应该使用什么格式？

**正方论点（结构化 JSON）**：
- 机器可解析，便于日志分析和查询
- 支持日志聚合和可视化工具
- 字段标准化，便于跨系统关联

**反方论点（纯文本）**：
- 人类可读，便于开发调试
- 实现简单
- 不需要额外的解析器

**最终决策**：采用结构化 JSON

**决策依据**：
- 用户要求"日志内容要有价值，不是流水账"
- 结构化日志比纯文本更有价值，因为可以机器解析和查询
- 支持日志聚合和可视化工具
- pino 原生支持 JSON 输出

**参与者**：架构师-1

### 决策 #13：日志配置管理方式

**决策点**：日志配置应该如何管理？

**正方论点（配置文件 + 环境变量）**：
- 配置文件定义默认值
- 环境变量覆盖敏感配置（如日志级别）
- 支持不同环境的配置

**反方论点（仅配置文件）**：
- 配置简单
- 不需要环境变量
- 所有配置都在一个地方

**最终决策**：采用配置文件 + 环境变量

**决策依据**：
- 日志级别等敏感配置需要通过环境变量覆盖
- 支持不同环境的配置（开发、测试、生产）
- 配置文件定义默认值，环境变量覆盖特定配置

**参与者**：架构师-1

---

## 7. 变更影响面分析

### 7.1 后端变更

**文件变更**（一次性完成）：
- `src/usecases/ports/logger.ts` → 新建，定义 Logger 接口
- `src/frameworks/logger.ts` → 重写为 PinoLogger 实现
- `src/main.ts` → 实例化 PinoLogger，注入到所有需要的地方，添加进程退出处理
- `src/interface-adapters/http/router.ts` → 添加请求日志中间件
- `src/interface-adapters/http/http-error.ts` → 添加错误日志
- `src/interface-adapters/agent-runtime/agent-invoker.ts` → 添加 Agent 调用日志，改为构造函数注入 logger
- `src/usecases/otter/manage-session.ts` → 添加 Session 操作日志，改为构造函数注入 logger
- `src/usecases/conversation/send-message.ts` → 添加消息处理日志，改为构造函数注入 logger
- `src/usecases/document/sync-documents.ts` → 添加文档同步日志，改为构造函数注入 logger
- `src/frameworks/agent/tool-call-circuit-breaker.ts` → 结构化熔断器日志，改为构造函数注入 logger
- `src/frameworks/db/database.ts` → 改为构造函数注入 logger
- `src/frameworks/embedding/embedding-service.ts` → 改为构造函数注入 logger，添加 Worker Thread 日志协议
- `src/frameworks/agent/pi-session-factory.ts` → 改为构造函数注入 logger
- `src/usecases/memory/store-memory.ts` → 改为构造函数注入 logger
- `src/usecases/memory/search-memory.ts` → 改为构造函数注入 logger
- `src/frameworks/config/index.ts` → 添加配置加载日志
- `src/frameworks/llm/models-factory.ts` → 添加模型初始化日志
- `src/frameworks/db/schema.ts` → 添加 Schema 初始化日志
- `src/frameworks/db/memory/seed-terminology.ts` → 添加种子数据导入日志

**配置变更**：
- `config.yaml` → 添加 logging 配置段
- `package.json` → 添加 pino、pino-pretty、pino-roll 依赖

**ESLint 变更**：
- `eslint.config.js` → 移除 D39 豁免（logger 不再直接导入）

### 7.2 前端变更

**无直接变更**：前端不涉及日志基础设施，但会受益于：
- `X-Request-ID` header 可用于前端错误追踪
- 更好的后端日志有助于调试前端问题

### 7.3 提示词/SOP 变更

**无变更**：不涉及提示词或 SOP 修改

---

## 8. 非目标（明确不做的事）

1. **分布式追踪**：本次不实现 OpenTelemetry 集成，仅实现日志基础设施
2. **指标收集**：本次不实现 Prometheus 指标，仅实现日志
3. **健康检查端点**：本次不实现 /health 端点，仅实现日志
4. **错误追踪服务**：本次不集成 Sentry 等服务，仅实现本地日志
5. **日志可视化**：本次不实现日志查询 UI，仅实现日志输出

---

## 9. 风险与缓解

### 9.1 性能风险

**风险**：日志写入可能影响系统性能

**缓解措施**：
- 使用 pino 的异步写入模式
- 配置合理的日志缓冲区大小
- 监控日志写入延迟
- 使用 pino-roll 进行日志轮转，防止磁盘占满

### 9.2 架构风险

**风险**：修改所有直接导入 logger 的地方为构造函数注入，工作量较大

**缓解措施**：
- 保持 Logger 接口兼容，现有调用方式不变（info/warn/error/debug）
- 逐步迁移，先实现新功能，再优化现有日志
- 提供迁移指南和工具

### 9.3 迁移风险

**风险**：一次性修改 19 个文件，工作量较大，可能引入回归

**缓解措施**：
- 保持 Logger 接口兼容，现有调用方式不变（info/warn/error/debug）
- 在 main.ts 统一注入，减少修改点
- **一次性完成所有文件变更**：本次 PR 完成所有 19 个文件的迁移
- **通过完整测试套件验证**：运行所有单元测试和集成测试，确保行为不变
- **保留旧 logger 接口**：在迁移期间保持旧接口兼容，迁移完成后移除

---

## 10. 验收标准

### 10.1 功能验收

- [ ] 日志输出为结构化 JSON 格式
- [ ] HTTP 请求日志包含 method、path、statusCode、duration
- [ ] 错误日志包含完整堆栈和上下文
- [ ] Agent 调用日志包含 otterId、conversationId、duration、tokenUsage
- [ ] 业务操作日志包含操作类型、相关 ID、结果
- [ ] Worker Thread 日志通过 postMessage 发送结构化日志消息
- [ ] 日志系统故障时应用仍能正常运行
- [ ] 进程退出时日志缓冲区被刷新

### 10.2 性能验收

- [ ] 日志写入延迟 < 10ms（p99）
- [ ] 日志内存占用 < 100MB
- [ ] 日志文件支持轮转
- [ ] 日志系统故障时应用仍能正常运行

### 10.3 可维护性验收

- [ ] 日志级别可通过配置控制
- [ ] 日志格式可通过配置切换（json/pretty）
- [ ] 日志输出目标可通过配置切换（stdout/file）

### 10.4 测试用例

**单元测试**：
- PinoLogger 实现测试（info/warn/error/debug/child）
- 日志系统容错测试（写入失败降级到 console）

**集成测试**：
- HTTP 请求日志测试（请求方法、路径、状态码、耗时）
- Agent 调用日志测试（开始、结束、duration、tokenUsage）
- 业务操作日志测试（Session 管理、消息处理、文档同步）
- Worker Thread 日志测试（正常运行日志、错误日志）
- SSE 连接日志测试（建立、关闭、异常断开）
- 数据库操作日志测试（初始化、关闭、慢查询）
- 启动阶段日志测试（配置加载、模型初始化、Schema 初始化、种子数据导入）

**端到端测试**：
- 完整请求链路日志测试（从 HTTP 请求到 Agent 调用到业务操作）
- 错误处理链路日志测试（从错误发生到错误日志记录）
- 进程崩溃时日志持久化测试（最后一条日志能被持久化）

---

## 11. 待澄清事项

1. **日志保留策略**：默认 7 天，是否需要调整？
2. **日志传输**：是否需要将日志传输到集中式日志系统（如 ELK）？
3. **日志告警**：是否需要基于日志的告警机制？

---

## 12. 参考资料

- [pino 官方文档](https://getpino.io/)
- [pino-roll 文档](https://github.com/pinojs/pino-roll)
- [12-Factor App: Logs](https://12factor.net/logs)
- [Structured Logging Best Practices](https://www.dataset.com/blog/the-10-commandments-of-logging/)
