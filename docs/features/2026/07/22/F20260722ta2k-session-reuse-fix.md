---
id: F20260722ta2k
title: session-reuse-fix
doc_type: feature

# 记忆索引
summary: |
  修复 PiSessionFactory 每次 invoke 都创建新 session 的问题，实现真正的 session 复用机制。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260716zq9q
    - F20260716sq6e

# 元数据
status: draft
change_type: fix
tags: [session, pi-sdk, reuse, performance]
modules: [src/frameworks/agent/, src/frameworks/db/]

# 时间
created_at: 2026-07-22
---


# F20260722ta2k Session 复用机制修复

## 术语定义

| 术语 | 定义 |
|------|------|
| **session** | Pi SDK 的会话抽象，包含对话历史、工具配置等 |
| **AgentSession** | `createAgentSession()` 返回的 session 对象实例 |
| **SessionManager** | Pi SDK 的会话管理器，负责 session 的持久化和恢复 |
| **sessionFile** | SessionManager 持久化的 JSONL 文件路径（SQL 字段：`session_file`） |
| **piSessionId** | session 的唯一标识符 |
| **OtterType** | Otter 类型，`'big'` 或 `'small'` |

## 背景

### 问题发现

用户发现系统每次 invoke 都新建一个 session，而不是复用已有的 session。

### 问题描述

当前 `PiSessionFactory.invoke()` 方法每次调用都会：
1. 创建新的 `SessionManager` 对象
2. 调用 `createAgentSession()` 创建新的 AgentSession 对象
3. 使用完毕后调用 `session.dispose()` 销毁 AgentSession 对象

### 根本原因

`SessionManager.create()` 每次都会创建新的 session（新的 sessionId），而 `SessionManager.open(sessionFile)` 才是恢复已有 session 的正确方式。

### 影响

1. Session 无法复用，丢失上下文连续性
2. KV cache 失效
3. 资源浪费
4. Session 文件堆积
5. Handoff 机制失效

## 决策过程

### 验证 SDK 行为

**测试 1：同一个 SessionManager 对象**

```typescript
const sm1 = SessionManager.create(process.cwd(), sessionDir);
const result1 = await createAgentSession({ sessionManager: sm1 });
result1.session.dispose();

const result2 = await createAgentSession({ sessionManager: sm1 });
console.log(result1.session.sessionId === result2.session.sessionId); // true
```

**结论**：使用同一个 `SessionManager` 对象时，`createAgentSession()` 会恢复同一个 session。

**测试 2：每次创建新的 SessionManager 对象**

```typescript
const sm1 = SessionManager.create(process.cwd(), sessionDir);
const result1 = await createAgentSession({ sessionManager: sm1 });
result1.session.dispose();

const sm2 = SessionManager.create(process.cwd(), sessionDir);
const result2 = await createAgentSession({ sessionManager: sm2 });
console.log(result1.session.sessionId === result2.session.sessionId); // false
```

**结论**：每次创建新的 `SessionManager` 对象时，`createAgentSession()` 会创建新的 session。

**测试 3：工具配置是否自动恢复**

```typescript
const sm1 = SessionManager.create(process.cwd(), sessionDir);
const result1 = await createAgentSession({
  sessionManager: sm1,
  tools: ["read", "bash"],
});
console.log(result1.session.getActiveToolNames()); // ["read", "bash"]
result1.session.dispose();

const sm2 = SessionManager.open(sessionFile);
const result2 = await createAgentSession({ sessionManager: sm2 });
console.log(result2.session.getActiveToolNames()); // ["read", "bash", "edit", "write"]
```

**结论**：SDK 不从 session 恢复工具配置，而是使用默认值。

**测试 4：SessionManager.create() 是否需要 createAgentSession()**

```typescript
const sm = SessionManager.create(process.cwd(), sessionDir);
console.log(sm.getSessionId());  // 有值
console.log(sm.getSessionFile());  // 有值
```

**结论**：`SessionManager.create()` 已经创建了 JSONL 文件，`createAgentSession()` 在 `create()` 方法中是不必要的。

### SDK API 验证

```typescript
// SessionManager.create() 签名
static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;

// NewSessionOptions 接口
interface NewSessionOptions {
  parentSession?: string;  // 用于建立 session chain
}

// SessionManager.open() 签名
static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager;
```

**验证**：`SessionManager.create()` 支持 `parentSession` 参数，用于建立 session chain。

### SessionManager 获取方式

`SessionManager` 通过 `piCodingAgent` 模块动态加载：

```typescript
// 在 ensurePiCodingAgent() 中
const SessionManagerClass = (this.piCodingAgent as unknown as {
  SessionManager: {
    create: (cwd: string, sessionDir?: string, options?: NewSessionOptions) => SessionManager;
    open: (path: string, sessionDir?: string, cwdOverride?: string) => SessionManager;
  };
}).SessionManager;
```

**注意**：`_createSessionAndPersist()` 和 `_invokeInternal()` 都需要调用 `await this.ensurePiCodingAgent()` 确保 `piCodingAgent` 已加载。

## 设计方案（最终版）

### 核心思路

1. **首次创建 session**：使用 `SessionManager.create()` 创建新 session，持久化 sessionId + sessionFile
2. **后续恢复 session**：使用 `SessionManager.open(sessionFile)` 恢复已有的 session
3. **系统重启后**：从持久化数据读取 sessionFile，使用 `SessionManager.open()` 恢复

### 参数传递策略

| 参数 | 首次创建 | 后续恢复 | 说明 |
|------|---------|---------|------|
| `model` | ✅ 传入 | ✅ 传入 | SDK 要求 |
| `sessionManager` | `create()` | `open()` | 关键差异 |
| `tools` | ✅ 传入 | ✅ 传入 | 必须传入，否则使用默认值 |
| `customTools` | ✅ 传入 | ✅ 传入 | 必须传入，否则丢失自定义工具 |
| `resourceLoader` | ✅ 传入 | ✅ 传入 | SDK 要求 |
| `modelRuntime` | ✅ 传入 | ✅ 传入 | SDK 要求 |
| 系统提示词 | ✅ 传入 | ✅ 传入 | 作为消息前缀注入，每次都需要 |
| 用户消息 | ✅ 传入 | ✅ 传入 | 每次 invoke 只传入最新消息 |

### sessionFile 格式和存储

- **格式**：JSONL（JSON Lines）
- **存储位置**：`sessionDir` 配置的目录（默认 `./data/sessions`）
- **命名规则**：`{timestamp}_{sessionId}.jsonl`
- **清理策略**：`reset()` 时删除旧文件，`destroy()` 时保留文件（用于审计）

### 数据持久化

#### `agent_sessions` 表（新增 `session_file` 字段）

```sql
ALTER TABLE agent_sessions ADD COLUMN session_file TEXT NOT NULL DEFAULT '';
```

#### `otter_configs` 表（新增）

```sql
CREATE TABLE IF NOT EXISTS otter_configs (
  otter_id TEXT PRIMARY KEY,
  system_prompt TEXT,
  otter_type TEXT NOT NULL DEFAULT 'big' CHECK(otter_type IN ('big', 'small')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**system_prompt 存储格式**：JSON 字符串（`JSON.stringify(OtterPromptConfig)`），允许为 NULL。

### 接口定义

#### `OtterConfigProvider` 接口

**文件**：`src/usecases/ports/otter-config-provider.ts`

```typescript
import type { OtterPromptConfig } from "@contract/api/otter";

export type OtterType = 'big' | 'small';

export interface OtterConfig {
  systemPrompt?: string | OtterPromptConfig;
  otterType: OtterType;
}

export interface OtterConfigProvider {
  getConfig(otterId: string): OtterConfig | null;
  setConfig(otterId: string, config: OtterConfig): void;
  deleteConfig(otterId: string): void;
  hasConfig(otterId: string): boolean;
}
```

#### `SqliteOtterConfigProvider` 实现

**文件**：`src/frameworks/db/otter/sqlite-otter-config-provider.ts`

```typescript
import type Database from "better-sqlite3";
import type { OtterConfig, OtterConfigProvider } from "@usecases/ports/otter-config-provider";

export class SqliteOtterConfigProvider implements OtterConfigProvider {
  constructor(private readonly db: Database.Database) {}

  getConfig(otterId: string): OtterConfig | null {
    const row = this.db.prepare(
      "SELECT system_prompt, otter_type FROM otter_configs WHERE otter_id = ?"
    ).get(otterId) as { system_prompt: string | null; otter_type: string } | undefined;

    if (!row) return null;

    return {
      systemPrompt: row.system_prompt ? JSON.parse(row.system_prompt) : undefined,
      otterType: row.otter_type as OtterConfig['otterType'],
    };
  }

  setConfig(otterId: string, config: OtterConfig): void {
    const systemPromptJson = config.systemPrompt ? JSON.stringify(config.systemPrompt) : null;

    this.db.prepare(`
      INSERT INTO otter_configs (otter_id, system_prompt, otter_type, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(otter_id) DO UPDATE SET
        system_prompt = excluded.system_prompt,
        otter_type = excluded.otter_type,
        updated_at = excluded.updated_at
    `).run(otterId, systemPromptJson, config.otterType);
  }

  deleteConfig(otterId: string): void {
    this.db.prepare("DELETE FROM otter_configs WHERE otter_id = ?").run(otterId);
  }

  hasConfig(otterId: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM otter_configs WHERE otter_id = ?"
    ).get(otterId);
    return !!row;
  }
}
```

#### `AgentSessionStore` 新增方法实现

**文件**：`src/frameworks/agent/agent-session-store.ts`

```typescript
export class AgentSessionStore {
  // 现有方法...

  setWithFile(otterId: string, piSessionId: string, sessionFile: string): void {
    this.db.prepare(`
      INSERT INTO agent_sessions (otter_id, pi_session_id, session_file, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(otter_id) DO UPDATE SET
        pi_session_id = excluded.pi_session_id,
        session_file = excluded.session_file,
        updated_at = excluded.updated_at
    `).run(otterId, piSessionId, sessionFile);
  }

  getWithFile(otterId: string): { piSessionId: string; sessionFile: string } | null {
    const row = this.db.prepare(
      "SELECT pi_session_id, session_file FROM agent_sessions WHERE otter_id = ?"
    ).get(otterId) as { pi_session_id: string; session_file: string } | undefined;
    return row ? { piSessionId: row.pi_session_id, sessionFile: row.session_file } : null;
  }

  updateWithFile(otterId: string, newPiSessionId: string, sessionFile: string): void {
    this.db.prepare(`
      UPDATE agent_sessions SET pi_session_id = ?, session_file = ?, updated_at = datetime('now')
      WHERE otter_id = ?
    `).run(newPiSessionId, sessionFile, otterId);
  }

  updateSessionFile(otterId: string, sessionFile: string): void {
    this.db.prepare(`
      UPDATE agent_sessions SET session_file = ?, updated_at = datetime('now')
      WHERE otter_id = ?
    `).run(sessionFile, otterId);
  }
}
```

### 并发安全方案

使用队列实现的锁机制，避免竞态条件：

```typescript
class SimpleLockManager {
  private queues = new Map<string, Array<() => void>>();

  async acquire(key: string): Promise<() => void> {
    const queue = this.queues.get(key) ?? [];
    this.queues.set(key, queue);

    // 如果队列不为空，等待前一个锁释放
    if (queue.length > 0) {
      await new Promise<void>(resolve => queue.push(resolve));
    }

    // 返回释放函数
    return () => {
      const next = queue.shift();
      if (next) {
        next(); // 唤醒下一个等待者
      } else {
        this.queues.delete(key);
      }
    };
  }

  destroy(): void {
    // 唤醒所有等待者，避免程序挂起
    for (const queue of this.queues.values()) {
      for (const resolve of queue) {
        resolve();
      }
    }
    this.queues.clear();
  }
}
```

### 代码修改

#### `PiSessionFactory`（`src/frameworks/agent/pi-session-factory.ts`）

##### 文件顶部导入

```typescript
import fs from 'fs';
import path from 'path';
```

##### 构造函数修改

```typescript
constructor(
  private readonly cfg: {
    db: Database.Database;
    sessionDir: string;
    otterToolClient: OtterToolClient;
    model: unknown;
    platformPromptFile?: string;
    createTools: (ctx: ToolContext) => AgentTool[];
    resourceLoader?: ResourceLoader;
    otterConfigProvider: OtterConfigProvider;  // 新增
  },
  private readonly logger: Logger,
) {
  // ... 现有初始化代码
  this.lockManager = new SimpleLockManager();
}
```

**说明**：移除 `staticPrompts` 和 `otterTypes` 内存 Map，改用 `otterConfigProvider` 从数据库读取。

##### `create()` 方法（外部版本，带锁）

```typescript
async create(otterId: string, config: AgentConfig): Promise<void> {
  const release = await this.lockManager.acquire(`session:${otterId}`);
  try {
    this._createSessionAndPersist(otterId, config, false);
  } finally {
    release();
  }
}
```

##### `_createSessionAndPersist()` 方法（内部版本，不带锁，核心方法）

```typescript
/**
 * 创建 session 并持久化（内部方法，不带锁）。
 * @param allowOverwrite 是否允许覆盖已有记录（用于迁移场景）
 */
private async _createSessionAndPersist(otterId: string, config: AgentConfig, allowOverwrite: boolean): Promise<void> {
  // 1. 检查是否已存在
  if (!allowOverwrite) {
    const existing = this.sessionStore.get(otterId);
    if (existing) {
      throw new Error(`Agent already exists for otter: ${otterId}`);
    }
  }

  // 2. 确保 piCodingAgent 已加载（获取 SessionManager）
  await this.ensurePiCodingAgent();

  // 3. 创建 SessionManager（新 session）
  const SessionManagerClass = (this.piCodingAgent as unknown as {
    SessionManager: { create: (cwd: string, sessionDir?: string, options?: { parentSession?: string }) => SessionManager };
  }).SessionManager;
  const sessionManager = SessionManagerClass.create(process.cwd(), this.cfg.sessionDir);

  // 4. 获取 sessionId 和 sessionFile
  const sessionId = sessionManager.getSessionId();
  const sessionFile = sessionManager.getSessionFile();

  // 5. 验证
  if (!sessionId || !sessionFile) {
    throw new Error('Failed to create session: missing sessionId or sessionFile');
  }

  // 6. 验证文件存在
  if (!fs.existsSync(sessionFile)) {
    throw new Error(`Session file does not exist: ${sessionFile}`);
  }

  // 7. 使用事务保存配置和 session 映射
  try {
    this.cfg.db.transaction(() => {
      this.cfg.otterConfigProvider.setConfig(otterId, {
        systemPrompt: config.systemPrompt,
        otterType: (config.context?.otterType as OtterType) ?? 'big',
      });
      // 使用 setWithFile，SQLite 的 ON CONFLICT 会自动处理 upsert
      this.sessionStore.setWithFile(otterId, sessionId, sessionFile);
    })();
  } catch (err) {
    // 事务失败时清理已创建的 session 文件
    try {
      fs.unlinkSync(sessionFile);
    } catch {
      // 清理失败不阻塞错误抛出
    }
    throw err;
  }
}
```

**说明**：不调用 `createAgentSession()`，因为 `SessionManager.create()` 已经创建了 JSONL 文件。后续 `invoke()` 时通过 `SessionManager.open()` + `createAgentSession()` 恢复 session，SDK 会自动加载 JSONL 中的历史数据。

##### `invoke()` 方法（外部版本，带锁）

```typescript
async invoke(otterId: string, message: string, options?: InvokeOptions): Promise<AgentRunResult> {
  const release = await this.lockManager.acquire(`session:${otterId}`);
  try {
    return await this._invokeInternal(otterId, message, options, 0);
  } finally {
    release();
  }
}
```

##### `_invokeInternal()` 方法（内部版本，不带锁）

```typescript
private async _invokeInternal(
  otterId: string,
  message: string,
  options: InvokeOptions | undefined,
  recursionDepth: number,
): Promise<AgentRunResult> {
  // 递归深度保护
  const MAX_RECURSION_DEPTH = 1;
  if (recursionDepth > MAX_RECURSION_DEPTH) {
    throw new Error(`Failed to invoke after ${MAX_RECURSION_DEPTH} retries for otter: ${otterId}`);
  }

  // 前置校验
  if (!this.otterToolClient) {
    throw new Error("OtterToolClient not injected. Call setOtterToolClient() before invoke().");
  }

  // 1. 从持久化存储读取 sessionFile
  const stored = this.sessionStore.getWithFile(otterId);
  if (!stored || !stored.sessionFile) {
    // 降级策略：检查 OtterConfig 是否存在
    const existingConfig = this.cfg.otterConfigProvider.getConfig(otterId);
    if (existingConfig) {
      this.logger.info(`Session file missing for otter: ${otterId}, creating new session`);
      await this._createSessionAndPersist(otterId, {
        systemPrompt: existingConfig.systemPrompt,
        context: { otterType: existingConfig.otterType },
      }, true);
    } else {
      throw new Error(`No session or config found for otter: ${otterId}. Call create() first.`);
    }
    return this._invokeInternal(otterId, message, options, recursionDepth + 1);
  }

  // 2. 创建 SessionManager（恢复已有 session）
  let sessionManager: SessionManager;
  try {
    await this.ensurePiCodingAgent();
    const SessionManagerClass = (this.piCodingAgent as unknown as {
      SessionManager: { open: (path: string, sessionDir?: string, cwdOverride?: string) => SessionManager };
    }).SessionManager;
    sessionManager = SessionManagerClass.open(stored.sessionFile);
  } catch (err) {
    // 区分错误类型
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      this.logger.warn(`Session file not found: ${stored.sessionFile}, creating new session`);
    } else {
      this.logger.warn(`Failed to open session file: ${stored.sessionFile}`, { error: err });
    }
    // 降级到 create()
    this.sessionStore.delete(otterId);
    const existingConfig = this.cfg.otterConfigProvider.getConfig(otterId);
    if (existingConfig) {
      await this._createSessionAndPersist(otterId, {
        systemPrompt: existingConfig.systemPrompt,
        context: { otterType: existingConfig.otterType },
      }, true);
    } else {
      throw new Error(`Session file corrupted and no config found for otter: ${otterId}`);
    }
    return this._invokeInternal(otterId, message, options, recursionDepth + 1);
  }

  // 3. 验证 SessionManager 有效性
  const restoredSessionId = sessionManager.getSessionId();
  if (!restoredSessionId) {
    this.logger.warn(`SessionManager.open() returned invalid state for: ${stored.sessionFile}, creating new session`);
    this.sessionStore.delete(otterId);
    const existingConfig = this.cfg.otterConfigProvider.getConfig(otterId);
    if (existingConfig) {
      await this._createSessionAndPersist(otterId, {
        systemPrompt: existingConfig.systemPrompt,
        context: { otterType: existingConfig.otterType },
      }, true);
    }
    return this._invokeInternal(otterId, message, options, recursionDepth + 1);
  }

  // 4. 从数据库加载配置
  const otterConfig = this.cfg.otterConfigProvider.getConfig(otterId);
  if (!otterConfig) {
    throw new Error(`Otter config not found: ${otterId}. Call create() first.`);
  }
  const otterType = otterConfig.otterType;
  const otterPromptConfig = otterConfig.systemPrompt;

  // 5. 构建工具配置（每次都传入）
  const conversationId = options?.conversationId ?? "";
  const messageId = options?.messageId;
  const dynamicContext = options?.dynamicContext;
  const otterToolNames = getOtterToolNamesForType(otterType);
  const customTools = this.buildCustomTools(otterId, conversationId, otterToolNames, messageId);
  const codingTools = getCodingToolsForOtterType(otterType);

  this.logger.info('Tools registered for agent session', {
    otterId, otterType,
    codingTools,
    customToolNames: customTools.map(t => t.name),
    whitelist: [...codingTools, ...customTools.map(t => t.name)],
  });

  // 6. 创建 AgentSession（恢复，传入 tools 和 customTools）
  const piCodingAgent = await this.ensurePiCodingAgent();
  const { session } = await piCodingAgent.createAgentSession({
    model: this.cfg.model,
    sessionManager,
    tools: [...codingTools, ...customTools.map(t => t.name)],
    customTools: customTools,
    resourceLoader: this.resourceLoader,
    modelRuntime: this.modelRuntime,
  });

  // 7. 注册活跃 session 引用，支持外部 abort + 工具调用计数
  const sessionKey = messageId ? `${otterId}:${messageId}` : otterId;
  this.activeSessions.set(sessionKey, { abort: () => session.abort(), toolCallCount: 0 });

  // 8. 熔断器
  const { circuitBreaker, unregisterToolCall } = this.attachCircuitBreaker(session, otterId);

  // 9. 构建完整消息
  const otterPrompt = this.buildOtterPrompt(otterPromptConfig);
  const staticPrompt = [this.platformPrompt, otterPrompt].filter(Boolean).join("\n\n");
  const fullMessage = this.buildMessageWithContext(staticPrompt, message, dynamicContext);

  // 10. 订阅事件
  const activeEntry = this.activeSessions.get(sessionKey);
  const unsubscribe = session.subscribe(this.createEventHandler(activeEntry, options?.onEvent));

  try {
    // 11. 发送消息
    await session.prompt(fullMessage);

    // 12. speak 工具已直接 complete 消息，invoke() 只返回 tokenUsage 等元数据

    // 13. 从 session stats 恢复 token usage
    const stats = session.getSessionStats();
    const tokenUsage = { input: stats.tokens.input, output: stats.tokens.output };
    this.checkTokenWarning(otterId, stats.tokens);

    // 14. token 超阈值警告
    const total = stats.tokens.input + stats.tokens.output;
    if (total > TOKEN_WARNING_THRESHOLD) {
      this.logger.warn(`[token-warning] otter=${otterId} total=${total} threshold=${TOKEN_WARNING_THRESHOLD}`);
    }

    const ctxMax = (this.cfg.model as Record<string, unknown>)?.contextWindow as number | undefined;
    return this.buildResult("", tokenUsage, circuitBreaker, ctxMax);
  } catch (err) {
    // 将 toolCallCount 附着到异常，供 handleInvokeError 在 finally 清理后仍可读取
    (err as Error & { _toolCallCount?: number })._toolCallCount =
      this.activeSessions.get(sessionKey)?.toolCallCount ?? 0;
    throw err;
  } finally {
    circuitBreaker.clearSteerDeadline();
    unregisterToolCall?.();
    unsubscribe();
    this.activeSessions.delete(sessionKey);
    session.dispose();
  }
}
```

##### `reset()` 方法（外部版本，带锁）

```typescript
async reset(otterId: string, context?: AgentContext): Promise<void> {
  const release = await this.lockManager.acquire(`session:${otterId}`);
  try {
    await this._resetInternal(otterId, context);
  } finally {
    release();
  }
}
```

##### `_resetInternal()` 方法（内部版本，不带锁）

```typescript
private async _resetInternal(otterId: string, context?: AgentContext): Promise<void> {
  const stored = this.sessionStore.getWithFile(otterId);
  const oldSessionFile = stored?.sessionFile;

  // 1. 确保 piCodingAgent 已加载
  await this.ensurePiCodingAgent();

  // 2. 创建新 SessionManager（chain，引用旧 session 作为 parent）
  const SessionManagerClass = (this.piCodingAgent as unknown as {
    SessionManager: { create: (cwd: string, sessionDir?: string, options?: { parentSession?: string }) => SessionManager };
  }).SessionManager;
  const sessionManager = SessionManagerClass.create(process.cwd(), this.cfg.sessionDir, {
    ...(stored?.piSessionId && { parentSession: stored.piSessionId }),
  });

  // 3. 获取 sessionId 和 sessionFile
  const sessionId = sessionManager.getSessionId();
  const sessionFile = sessionManager.getSessionFile();

  // 4. 验证
  if (!sessionId || !sessionFile) {
    throw new Error('Failed to create session: missing sessionId or sessionFile');
  }

  // 5. 验证文件存在
  if (!fs.existsSync(sessionFile)) {
    throw new Error(`Session file does not exist: ${sessionFile}`);
  }

  // 6. 使用事务更新持久化数据
  try {
    this.cfg.db.transaction(() => {
      // 使用 setWithFile，SQLite 的 ON CONFLICT 会自动处理 upsert
      this.sessionStore.setWithFile(otterId, sessionId, sessionFile);

      // 可选更新配置
      if (context?.systemPrompt) {
        const existingConfig = this.cfg.otterConfigProvider.getConfig(otterId);
        this.cfg.otterConfigProvider.setConfig(otterId, {
          systemPrompt: context.systemPrompt,
          otterType: existingConfig?.otterType ?? 'big',
        });
      }
    })();
  } catch (err) {
    // 事务失败时清理已创建的 session 文件
    try {
      fs.unlinkSync(sessionFile);
    } catch {
      // 清理失败不阻塞错误抛出
    }
    throw err;
  }

  // 7. 清理旧 session 文件（安全检查：避免删除刚创建的文件）
  if (oldSessionFile && oldSessionFile !== sessionFile) {
    try {
      fs.unlinkSync(oldSessionFile);
      this.logger.debug(`Deleted old session file: ${oldSessionFile}`);
    } catch (err) {
      this.logger.warn(`Failed to delete old session file: ${oldSessionFile}`, { error: err });
    }
  }
}
```

##### `destroy()` 方法（外部版本，带锁）

```typescript
async destroy(otterId: string): Promise<void> {
  const release = await this.lockManager.acquire(`session:${otterId}`);
  try {
    await this._destroyInternal(otterId);
  } finally {
    release();
  }
}
```

##### `_destroyInternal()` 方法（内部版本，不带锁）

```typescript
private async _destroyInternal(otterId: string): Promise<void> {
  // 1. 中止所有相关的活跃 session（先复制 key 列表，避免迭代时修改 Map）
  const keysToDelete: string[] = [];
  for (const [key, entry] of this.activeSessions.entries()) {
    if (key === otterId || key.startsWith(`${otterId}:`)) {
      keysToDelete.push(key);
    }
  }

  // 2. 逐个中止并删除
  for (const key of keysToDelete) {
    const entry = this.activeSessions.get(key);
    if (entry) {
      try {
        await entry.abort();
      } catch {
        // abort 失败不阻塞销毁流程
      }
      this.activeSessions.delete(key);
    }
  }

  // 3. 删除持久化数据（不删除 session 文件，保留用于审计）
  this.cfg.db.transaction(() => {
    this.sessionStore.delete(otterId);
    this.cfg.otterConfigProvider.deleteConfig(otterId);
  })();
}
```

**说明**：`destroy()` 不删除 session 文件，保留用于审计。如需清理，可手动删除或实现定时清理任务。

##### `abort()` 和 `getToolCallCount()` 方法

这两个方法不需要修改，因为它们只使用 `activeSessions` Map，而 `activeSessions` 的结构没有变化。

### 数据库迁移

**迁移时机**：应用启动时执行

```typescript
function migrateDatabase(db: Database.Database): void {
  // 检查 session_file 字段是否存在
  const columns = db.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>;
  const hasSessionFile = columns.some(col => col.name === 'session_file');

  if (!hasSessionFile) {
    db.prepare("ALTER TABLE agent_sessions ADD COLUMN session_file TEXT NOT NULL DEFAULT ''").run();
  }

  // 创建 otter_configs 表
  db.prepare(`
    CREATE TABLE IF NOT EXISTS otter_configs (
      otter_id TEXT PRIMARY KEY,
      system_prompt TEXT,
      otter_type TEXT NOT NULL DEFAULT 'big' CHECK(otter_type IN ('big', 'small')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
}
```

### 数据迁移

**迁移现有数据**：

```typescript
function migrateExistingData(
  db: Database.Database,
  otterConfigProvider: OtterConfigProvider,
  logger: Logger
): void {
  // 1. 检查是否有需要迁移的数据
  const existingSessions = db.prepare(
    "SELECT otter_id, pi_session_id FROM agent_sessions WHERE session_file = ''"
  ).all() as Array<{ otter_id: string; pi_session_id: string }>;

  if (existingSessions.length === 0) {
    logger.info('No existing sessions to migrate');
    return;
  }

  logger.info(`Migrating ${existingSessions.length} existing sessions`);

  // 2. 为每个 session 创建 OtterConfig
  for (const session of existingSessions) {
    // 从 otters 表获取 otterType
    const otter = db.prepare(
      "SELECT type FROM otters WHERE id = ?"
    ).get(session.otter_id) as { type: string } | undefined;

    if (otter) {
      otterConfigProvider.setConfig(session.otter_id, {
        otterType: otter.type as 'big' | 'small',
        // systemPrompt 为 undefined，因为当前代码存储在内存 Map 中，无法迁移
      });
    }
  }

  // 3. 明确说明：迁移后所有旧 session 将失效，首次 invoke 会创建新 session
  logger.warn('Migration completed. IMPORTANT: All old sessions will be recreated on first invoke. Previous session context and system prompts will be lost. You need to reconfigure system prompts after migration.');
}
```

**重要说明**：
1. 迁移后所有旧 session 的 `session_file` 为空字符串，首次 `invoke()` 会触发降级策略创建新 session，**旧 session 的上下文将丢失**。
2. 迁移后所有 otter 的 `systemPrompt` 为 `undefined`（因为当前代码存储在内存 Map 中，无法迁移到数据库），**需要重新配置系统提示词**。

### Handoff 机制集成

session 复用后，token 使用量会累积，Handoff 机制可以正常触发：

```typescript
// 在 invoke 结束时检查
const stats = session.getSessionStats();
const totalTokens = stats.tokens.input + stats.tokens.output;
const ctxMax = (this.cfg.model as Record<string, unknown>)?.contextWindow as number | undefined;

if (ctxMax && totalTokens >= ctxMax * 0.7) {
  // 触发 Handoff（由调用方处理）
  // Handoff 会调用 reset() 创建新 session
}
```

### 约束说明

1. **单实例部署**：当前方案假设单实例部署。如果多实例部署，需要验证 Pi SDK 的 `SessionManager.open()` 是否支持并发访问同一个 JSONL 文件。
2. **Session 文件大小**：长时间运行后，单个 session 的 JSONL 文件可能变得非常大。建议监控文件大小，必要时触发 Handoff 进行 session 轮转。
3. **迁移后需要重新配置系统提示词**：当前代码中 `systemPrompt` 存储在内存 Map 中，无法迁移到数据库。

## 验收标准

1. ✅ 首次 invoke 创建新 session，持久化 sessionId + sessionFile
2. ✅ 后续 invoke 恢复已有的 session（相同的 sessionId）
3. ✅ 系统重启后能正确恢复 session
4. ✅ 系统提示词保持不变，利用 KV cache
5. ✅ 工具配置每次都传入（SDK 不自动恢复）
6. ✅ 每次 invoke 只传入最新用户消息
7. ✅ 无内存泄漏（每次 invoke 结束后 session.dispose()）
8. ✅ 无死锁（内部方法不获取锁）
9. ✅ 并发安全（外部方法获取锁）
10. ✅ 迁移后旧 session 能正确降级处理

### 测试用例

1. **验证 session 复用**：连续调用两次 `invoke()`，检查 sessionId 是否相同
2. **验证系统重启后恢复**：调用 `invoke()` 后重启系统，再次调用 `invoke()`，检查 sessionId 是否相同
3. **验证工具配置**：恢复 session 后，检查 `session.getActiveToolNames()` 是否正确
4. **验证系统提示词**：连续调用两次 `invoke()`，检查系统提示词是否相同
5. **验证降级策略**：删除 session 文件，调用 `invoke()`，检查是否自动创建新 session
6. **验证并发安全**：并发调用多次 `invoke()`，检查是否有竞态条件
7. **验证无死锁**：`invoke()` 内部调用 `create()` 时不会死锁
8. **验证数据迁移**：系统重启后，旧数据能正确迁移到新表
9. **验证迁移后 invoke**：迁移后首次 `invoke()` 能正确创建新 session

## 关联

- **Session 架构设计**：[F20260716zq9q](./F20260716zq9q-conversation-session-architecture.md)
- **Pi SDK 集成**：[F20260716sq6e](./F20260716sq6e-pi-agent-core-vs-coding-agent.md)
