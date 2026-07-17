# F20260717f4u2 — Pi Agent 交互协议梳理

## 元信息

- **特性编号**：F20260717f4u2
- **变更类型**：design-only（无代码变更，协议文档化）
- **创建日期**：2026-07-17
- **状态**：design-time
- **前序特性**：F20260716sq6e（pi-agent-core vs pi-coding-agent 技术选型）

## 用户意图锚

| ID | 用户原话 | 来源 | 关键修饰语 | 架构师解读 |
|----|---------|------|-----------|-----------|
| UA-1 | "整理一下当前实现的 otter系统 调用 pi agent的交互协议" | 消息 #1 | "当前实现"——梳理现状而非设计新方案；"交互协议"——关注接口契约和数据流 | 本文档是对现有代码的事实梳理，不引入新设计 |
| UA-2 | "我认为需要梳理清楚，这两者的边界是什么" | 消息 #1 | "边界"——职责划分的清晰界限 | 需要明确哪些逻辑属于 Otter、哪些属于 Pi SDK |
| UA-3 | "调用pi的协议是什么，用到pi的什么能力、注入哪些能力" | 消息 #1 | "协议"——调用方式和数据格式；"用到"——Pi 提供的能力；"注入"——Otter 注入给 Pi 的能力 | 需要覆盖三个维度：调用协议、Pi 能力、注入能力 |
| UA-4 | "前提还是要满足 整洁架构 设计模式" | 消息 #1 | "整洁架构"——Clean Architecture 分层约束 | 边界划分必须尊重现有的四层架构 |

## 摘要

梳理 Otter 系统与 Pi Agent（pi-coding-agent SDK）之间的交互协议：边界定义、调用链、注入机制、能力矩阵。本文档为设计文档，不引入代码变更。

---

## 1. 架构总览

### 1.1 依赖关系

```
@earendil-works/pi（monorepo, MIT）
├── pi-ai              -- LLM 抽象层（20+ Provider 统一 API）
├── pi-agent-core      -- Agent 运行时（传递依赖，非直接依赖）
└── pi-coding-agent    -- 编码 Agent 产品（Otter 的直接依赖）
```

Otter 直接依赖 `@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-ai`。pi-agent-core 作为 pi-coding-agent 的传递依赖存在。

### 1.2 Clean Architecture 分层

```
┌─ entities ──────────── 领域实体（零外部依赖）────────────────────┐
│  Otter, Conversation, Memory, Terminology                       │
├─ usecases ──────────── 业务逻辑 + 接口定义 ──────────────────────┤
│  AgentGateway（生命周期接口）│ SendMessage │ SearchMemory │ ...  │
├─ interface-adapters ── 适配器 ───────────────────────────────────┤
│  AgentInvokePort（调用接口）│ AgentInvoker │ OtterToolClient    │
│  tool-factory（16 工具）│ skill-loader │ HTTP Controllers      │
├─ frameworks ────────── 框架实现 ─────────────────────────────────┤
│  PiSessionFactory（SDK 薄封装）│ AgentSessionStore              │
│  ToolCallCircuitBreaker │ Models 工厂 │ DB │ Embedding         │
└─────────────────────────────────────────────────────────────────┘
```

依赖方向：外层 → 内层。usecases 层定义接口，frameworks 层提供实现。

---

## 2. 边界定义

### 2.1 属于 Otter 系统的职责

| 层 | 职责 | 关键文件 |
|---|------|---------|
| entities | Otter 实体、类型系统（big/small）、状态机 | `src/entities/otter/otter.ts` |
| usecases | Otter 生命周期、对话管理、记忆管理、术语库 | `src/usecases/otter/*.ts` |
| interface-adapters | AgentInvoker（事件映射+动态上下文）、OtterToolClient（工具门面）、16 个工具定义、SkillLoader | `src/interface-adapters/agent-runtime/` |
| frameworks | PiSessionFactory（SDK 薄封装）、AgentSessionStore、ToolCallCircuitBreaker | `src/frameworks/agent/` |

Otter 系统的核心职责：
1. **业务实体和规则**：Otter 类型、状态机、不变量校验
2. **Session 生命周期**：创建、归档、交接、handoffSummary
3. **系统提示构建**：静态 prompt + Skills + 动态上下文的组合
4. **工具定义和业务逻辑**：16 个工具的参数定义和 execute 实现
5. **事件流映射**：Pi 事件 → SSE 事件 → 前端
6. **熔断和安全**：ToolCallCircuitBreaker 的所有规则
7. **动态上下文注入**：记忆检索结果、会话摘要

### 2.2 属于 Pi SDK 的职责

| 职责 | 说明 |
|------|------|
| LLM API 调用 | 通过 pi-ai 统一调用 OpenAI/Anthropic 等 Provider |
| Agent Loop | LLM 决策 → tool_call → execute → 返回结果 → 下一轮 |
| Session 持久化 | SessionManager 管理 JSONL 文件 |
| 编码工具实现 | read/write/edit/bash 的实际文件系统操作 |
| 事件流产生 | message_update, tool_execution_start/end, turn_end, agent_end |
| 上下文窗口管理 | 自动 compaction |
| 工具调用协议 | TypeBox schema 验证、参数解析、结果格式化 |
| abort/steer 机制 | 中断生成、注入纠正提示 |

### 2.3 边界原则

- **Pi 是嵌入式 Agent 库**，运行在 Otter 进程内，不存在跨进程通信
- **Tool 的 execute 函数是 Otter 代码**，通过 `ToolContext` 闭包注入 `OtterToolClient`
- **Pi 管理 LLM 交互和 Session 文件**，Otter 管理业务数据和 Agent 生命周期
- **系统提示作为消息前缀注入**（非独立 system message），因为 SDK 无公开 API 覆盖 system prompt
- **`otterId` 和 `conversationId` 由系统注入**，LLM 不感知这些参数

---

## 3. 接口契约

### 3.1 AgentGateway（生命周期管理）

定义位置：`src/usecases/otter/agent-gateway.ts`

```typescript
export interface AgentGateway {
  create(otterId: string, config: AgentConfig): Promise<void>;
  destroy(otterId: string): Promise<void>;
  reset(otterId: string, context?: AgentContext): Promise<void>;
}
```

| 方法 | 触发时机 | 实现行为 |
|------|---------|---------|
| `create` | `CreateOtter` use case | 创建 Pi Session → 存储映射 → 记录静态 prompt 和 otterType |
| `destroy` | `DissolveOtter` use case | 中止活跃 session → 删除映射 |
| `reset` | `ManageSession`（归档/交接） | 创建新 session（chain，parent=旧 session）→ 更新映射 |

### 3.2 AgentInvokePort（运行时调用）

定义位置：`src/interface-adapters/agent-runtime/agent-invoke-port.ts`

```typescript
export interface AgentInvokePort {
  invoke(otterId: string, message: string, options?: InvokeOptions): Promise<AgentRunResult>;
  abort(otterId: string): void;
}
```

| 参数/返回 | 类型 | 说明 |
|----------|------|------|
| `otterId` | `string` | 目标 Otter ID |
| `message` | `string` | 用户消息文本 |
| `options.dynamicContext` | `DynamicContext` | 记忆检索 + 会话摘要 |
| `options.conversationId` | `string` | 当前对话 ID |
| `options.onEvent` | `(event: AgentStreamEvent) => void` | 流式事件回调 |
| 返回 `text` | `string` | Agent 生成的完整文本 |
| 返回 `tokenUsage` | `{input, output}` | Token 用量 |
| 返回 `ctxMax` | `number` | 上下文窗口大小 |
| 返回 `circuitBreakerMetadata` | `{totalCalls, circuitReason?}` | 熔断器元数据 |

### 3.3 事件映射

Pi SDK 事件 → Otter SSE 事件：

| Pi 事件 | SSE 事件 | DB 持久化 |
|---------|---------|----------|
| `message_update` (delta) | `message.delta` | `text_delta` |
| `tool_execution_start` | `tool.start` | `tool_call` |
| `tool_execution_end` | `tool.result` | `tool_result` |
| `turn_end` | 显式跳过（D5-fix：`turn.complete` 在 `message.complete` 之后手动发射） | — |
| `agent_end` | `agent.idle` | — |

---

## 4. 调用链

```
HTTP POST /conversations/:id/messages
  └─ MessageController.sendMessage()
       ├─ 1. SendMessage.send() — 创建用户消息写入 DB
       ├─ 2. streamEvents() — 创建 SSE 流
       └─ 3. AgentInvoker.invokeConversation() [异步，不 await]
            ├─ 3a. buildDynamicContext()
            │       ├─ SearchMemory.search(userMessage) → top-10 snippet
            │       └─ ManageSession.getActiveSession() → handoffSummary 或 summary
            ├─ 3b. SendMessage.start() — 创建 streaming 状态的 Otter 消息
            ├─ 3c. AgentInvokePort.invoke(otterId, message, options)
            │       └─ PiSessionFactory.invoke()
            │            ├─ 加载 Skills (SkillLoader)
            │            ├─ 构建 customTools (16 个 Otter 工具)
            │            ├─ 获取 codingTools (read/write/edit/bash)
            │            ├─ createAgentSession() — 创建 Pi session
            │            ├─ 注册熔断器 (ToolCallCircuitBreaker)
            │            ├─ buildMessageWithContext() — 拼接完整消息
            │            ├─ session.subscribe() — 事件监听
            │            ├─ session.prompt(fullMessage) — 发送给 LLM
            │            └─ session.dispose() — 释放
            ├─ 3d. SendMessage.complete() — 完成 Otter 消息
            └─ 3e. SSE 事件推送
```

---

## 5. 注入机制

### 5.1 系统提示注入

Pi SDK 的 `_systemPromptOverride` 为 private，无公开 setter。系统提示作为**用户消息前缀**注入。

`PiSessionFactory.buildMessageWithContext()` 拼接结构：

```
[静态系统提示]              ← AgentConfig.systemPrompt（Otter 角色定义 + 行为规范）
[Skills 章节]              ← ## Skills + otter-shared/SKILL.md 内容
[会话摘要]                  ← ## 会话摘要 + handoffSummary 或 summary
[记忆检索结果]              ← ## 记忆检索结果 + search_memory 的 snippet 结果
[用户消息]                  ← 用户实际发送的文本
```

### 5.2 工具注入

每个工具的 `execute` 函数通过闭包捕获 `ToolContext`：

```typescript
export interface ToolContext {
  client: OtterToolClient;  // 统一门面，包装所有 use case
  otterId: string;          // 系统注入，LLM 不传
  conversationId: string;   // 系统注入，LLM 不传
}
```

工具通过 `customTools` 参数传入 `createAgentSession()`。

### 5.3 Session 注入

- `AgentSessionStore` 维护 `otter_id ↔ pi_session_id` 映射（SQLite `agent_sessions` 表）
- `SessionManager.create(cwd, sessionDir, { parentSession })` 支持 session chain
- 冷启动模型：每次 `invoke()` 创建 session 对象，完成后 `dispose()`

### 5.4 熔断器注入

ToolCallCircuitBreaker 本身是纯评估引擎（`check(toolName)` 方法）。订阅逻辑在 `PiSessionFactory.attachCircuitBreaker()` 中，通过 `session.subscribe()` 拦截 `tool_execution_start` 事件，委托给 `circuitBreaker.check()` 判断是否熔断。无需 Pi SDK 特殊支持。

---

## 6. 能力矩阵

### 6.1 编码工具（Pi SDK 内置）

| Otter 类型 | 启用的编码工具 |
|-----------|--------------|
| `big` | `read`, `write`, `edit`, `bash` |
| `small` | 无 |

### 6.2 Otter 自定义工具（16 个）

**消息与对话（6 个）：**

| 工具名 | 功能 | big | small |
|-------|------|-----|-------|
| `send_message` | 发送消息到当前对话 | ✅ | ✅ |
| `pass_talking_stone` | 传递发言石 | ✅ | ❌ |
| `get_message` | 按 ID 获取消息详情 | ✅ | ✅ |
| `list_messages` | 分页查询消息列表 | ✅ | ✅ |
| `search_messages` | 关键词搜索消息 | ✅ | ✅ |
| `get_turn_history` | 获取 Turn 历史链 | ✅ | ✅ |

**记忆系统（3 个）：**

| 工具名 | 功能 | big | small |
|-------|------|-----|-------|
| `search_memory` | 检索记忆（渐进式披露） | ✅ | ✅ |
| `store_memory` | 存储记忆条目 | ✅ | ❌ |
| `get_memory_detail` | 获取记忆完整内容 | ✅ | ✅ |

**Otter 生命周期（2 个）：**

| 工具名 | 功能 | big | small |
|-------|------|-----|-------|
| `create_otter` | 创建子 Otter | ✅ | ❌ |
| `dissolve_otter` | 解散 Otter | ✅ | ❌ |

**上下文与资源（3 个）：**

| 工具名 | 功能 | big | small |
|-------|------|-----|-------|
| `get_context` | 获取 Otter 上下文 | ✅ | ✅ |
| `set_context` | 设置 Otter 上下文 | ✅ | ✅ |
| `create_linked_resource` | 创建链接资源 | ✅ | ✅ |

**术语库（2 个）：**

| 工具名 | 功能 | big | small |
|-------|------|-----|-------|
| `search_terminology` | 查找术语定义 | ✅ | ✅ |
| `add_terminology` | 记录新术语 | ✅ | ✅ |

### 6.3 Skills

| Skill | 内容 | big | small |
|-------|------|-----|-------|
| `otter-shared` | 海獭系统共享行为规范（消息规范、记忆规范、上下文管理） | ✅ | ✅ |

---

## 7. 关键文件索引

| 文件 | 职责 |
|------|------|
| `src/usecases/otter/agent-gateway.ts` | AgentGateway 接口定义 |
| `src/interface-adapters/agent-runtime/agent-invoke-port.ts` | AgentInvokePort 接口定义 |
| `src/frameworks/agent/pi-session-factory.ts` | PiSessionFactory：SDK 薄封装，实现 AgentGateway + invoke() |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | AgentInvoker：事件映射 + 动态上下文 + 消息生命周期 |
| `src/interface-adapters/agent-runtime/otter-tool-client.ts` | OtterToolClient 接口：工具门面 |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | 16 个工具定义 |
| `src/interface-adapters/skill-adapter/skill-loader.ts` | Skill 加载器 |
| `src/frameworks/agent/agent-session-store.ts` | Otter ID ↔ Pi Session ID 映射 |
| `src/frameworks/agent/tool-call-circuit-breaker.ts` | 工具调用熔断器 |
| `src/main.ts` | Composition Root：依赖注入装配 |

---

## 8. 决策记录

| 决策 | 正面论点 | 反面论点 | 结论 |
|------|---------|---------|------|
| 系统提示作为消息前缀注入 | 无需修改 SDK 源码，兼容性好 | 消耗用户消息的 context window，非标准做法 | 接受，因 SDK 无公开 API 覆盖 system prompt |
| 冷启动模型（每次 invoke 创建/销毁 session） | 简化并发模型，避免 session 状态泄漏 | 每次创建 session 有开销 | 接受，SessionManager 的 JSONL 持久化保证数据不丢失 |
| ToolContext 闭包注入而非依赖注入框架 | 简单直接，无额外依赖 | 工具测试需要构造完整 ToolContext | 接受，与项目手动 DI 风格一致 |
| big/small Otter 工具差异化 | 最小权限原则，small otter 不需要管理工具 | 增加了配置复杂度 | 接受，通过白名单函数实现 |
| turn_end 事件手动发射（D5-fix） | 保证 `turn.complete` 在 `message.complete` 之后到达前端，避免竞态 | 与 Pi SDK 事件流解耦，需手动维护时序 | 接受，`turn_end` 在 SSE 映射中显式跳过，`turn.complete` 在 `invokeConversation()` 中手动发射 |
| SkillLoader 通配符语义 | empty skillNames = 加载全部，简化配置 | 无法按 otterType 差异化加载 | 接受，当前仅 `otter-shared` 一个 skill，差异化无实际收益 |

---

## [design-time]

本特性为 design-only，无代码变更。文档锁定后可直接进入 development 阶段（如果后续需要基于此文档做代码调整）。
