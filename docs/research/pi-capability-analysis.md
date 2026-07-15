# Pi Agent 能力探索与 Otter 集成方案

## 探索范围

本报告基于对 `@earendil-works/pi-agent-core@0.80.6` 和 `@earendil-works/pi-ai@0.80.6` 的源码级分析，覆盖以下主题：

1. Pi 的完整架构（两个平行 Agent 实现：Agent + AgentHarness）
2. System Prompt 管理机制（覆盖 vs 追加 -> 动态函数）
3. System-Reminder 机制（两个注入点：systemPrompt 函数 vs transformContext）
4. Skill 机制（Tool vs Skill 边界、activeToolNames、resources.skills）
5. MCP 替代方案（Pi 是嵌入式库，不是外挂式 CLI）
6. Session 管理（Pi 自行管理 JSONL，Otter 只存 session ID）
7. Compaction（手动触发，需应用层 hook 触发策略）
8. 事件流与前端流式对接
9. 场景分析（大獭创建设计獭/检视獭）

### 交叉审视修订记录

| # | 修订内容 | 来源 |
|---|---------|------|
| R1 | Compaction 从"自动"修正为"手动触发" | 架构师-2 C1，源码验证通过 |
| R2 | ~~Session 双写问题消除，改为 SqliteSessionStorage~~ -> 修正为：使用 Pi 内置 JsonlSessionRepo，Otter 只存 session ID | 架构师-2 C2 -> 用户纠正 |
| R3 | 架构图从"包含关系"修正为"平行关系" | 架构师-2 C3，源码验证通过 |
| R4 | Steering 时机从"运行中"修正为"轮次间"（不能中断运行中的 Agent） | 架构师-2 C4，源码验证通过 |
| R5 | ~~ExecutionEnv 最小实现仅需 4 个 FS 方法~~ -> 修正为：直接使用 Pi 内置 NodeExecutionEnv | 架构师-2 C5 -> 用户纠正 |
| R6 | shouldStopAfterTurn 是低层 AgentLoopConfig 的可选字段，Agent 和 AgentHarness 均不使用 | 架构师-2 C6 -> 架构师-1 源码验证修正 |
| R7 | Skill 可不依赖文件系统，支持代码构造 | 架构师-2 N1 |
| R8 | 新增 Custom Session Entries 用于存储 Otter 元数据 | 架构师-2 N2 |
| R9 | Session 模型选择：Otter chain 而非 Pi fork | 架构师-2 N4 |
| R10 | System Prompt 从四层简化为两层（静态+动态） | 架构师-2 DP-5 |
| R11 | 小獭 Session 也需要持久化（不存在"临时存在"） | 用户纠正 |
| R12 | Otter-Pi 边界：Pi 自行管理 Session 存储，Otter 只存 session ID | 用户纠正 |
| R13 | ExecutionEnv 使用 Pi 内置 NodeExecutionEnv，不需要自定义 | 用户纠正 + 源码验证 |
| R14 | Pi 是嵌入式 Agent 库（非外挂式 CLI），这是 MCP 不需要的根本原因 | 用户认知对齐 |
| R15 | Tool vs Skill 边界明确：Tool 执行代码，Skill 注入指令文本 | 用户讨论 |
| R16 | activeToolNames 控制工具可见性，resources.skills 控制 Skill 可见性 | 用户讨论 |
| R17 | 冷启动模型：每次发言创建 harness，完成后释放 | 用户决策 |
| R18 | SQLite 不需要额外锁：better-sqlite3 同步 + WAL 已够 | 用户纠正 + 源码验证 |
| R19 | Compaction 触发策略修正：不能在 after_provider_response 中调用 compact()（phase 非 idle） | 架构师-1 E1 源码验证 |
| R20 | AgentHarnessFactory 接口增加 onEvent 回调支持 SSE 流式推送 | 架构师-1 D1 |
| R21 | 新增嵌套 harness 场景说明和 session 文件生命周期说明 | 架构师-1 D2/D3 |

---

## 1. Pi 架构总览

### 1.1 核心认知：Pi 是嵌入式 Agent 库

**Pi 不是"轻量版 Claude CLI"，而是"可嵌入应用的 Agent 框架"**。

```
Claude CLI / OpenCode CLI（外挂式 Agent）：

┌─ Agent 进程 ──────────┐     ┌─ 你的系统进程 ─────────┐
│  Claude CLI           │     │  Otter / Snail         │
│  (独立程序)            │     │  (你的应用)             │
│  LLM -> MCP Tool      │────>│  /api/xxx              │
└───────────────────────┘     └────────────────────────┘
两个进程，需要 MCP 协议通信

Pi（嵌入式 Agent）：

┌─ Otter 进程（只有一个）──────────────────────┐
│  Pi AgentHarness (npm 库)                    │
│    LLM -> AgentTool.execute()                 │
│            └── 直接调用 usecase              │
│                  └── 直接调用 repository     │
│                        └── 直接访问 SQLite   │
│  HTTP Controller (同进程)                    │
└──────────────────────────────────────────────┘
一个进程，函数调用，不需要任何协议
```

这是理解 Pi 所有设计决策的前提：**Pi 运行在应用进程内，AgentTool 就是应用代码**。

### 1.2 两个平行的 Agent 实现

Pi 提供两个**平行的** Agent 实现（非包含关系，都消费同一个 `agent-loop.js`）：

```
agent-loop.js  (低层循环：streaming, tool execution, turn management)
     ^
     |--- Agent        (轻量有状态封装：state, events, queues)
     |--- AgentHarness (重型封装：Session, Skills, Compaction, Hooks, Resources)
```

**Agent**：轻量级，有状态，自己管理 messages/tools/prompt。无 Session、无 Skill、无 Compaction。

**AgentHarness**：重型，自带 Session 管理、Skill 系统、Compaction、动态 System Prompt、Hook 系统。**不继承、不包装 Agent**，是独立的平行实现。

### 1.3 pi-ai（LLM 抽象层）

**核心能力**：
- 统一 API：OpenAI / Anthropic / Google / Mistral / Bedrock 等 20+ 提供商
- Provider Collection：`Models` 对象持有多个 Provider，路由请求
- Auth 解析：环境变量 / CredentialStore / OAuth（自动刷新）
- Tools：TypeBox schema 定义，流式 partial JSON 解析
- Streaming：text / thinking / tool_call 事件流

### 1.4 AgentHarness 关键类型

```typescript
interface AgentHarnessOptions {
  env: ExecutionEnv;           // Pi 内置 NodeExecutionEnv
  session: Session;            // 通过 JsonlSessionRepo 创建
  models: Models;              // LLM Provider 集合
  tools?: TTool[];             // 全部注册的工具
  activeToolNames?: string[];  // LLM 可见的工具子集
  resources?: AgentHarnessResources;  // skills + promptTemplates
  systemPrompt?: string | ((context) => string | Promise<string>);
  model: Model<any>;
  thinkingLevel?: ThinkingLevel;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
}
```

---

## 2. System Prompt 管理

### Pi 的机制

Pi 不区分"覆盖"和"追加"。`systemPrompt` 接受 `string` 或 `(ctx) => string` 函数。

**关键机制**：
- 函数在**每次 LLM API 调用前**执行（包括多轮 tool 调用中的每一轮）
- **无缓存**：`createTurnState()` 每次都重新调用函数
- 函数收到的 `ctx` 包含 `session` 对象，可访问对话历史、compaction 摘要等
- `formatSkillsForSystemPrompt()` 是工具函数，需要应用自己在 systemPrompt 函数中调用

**执行路径**：
```
用户发消息 -> harness.prompt(text)
  -> createTurnState()  [调用 systemPrompt 函数，拿到字符串]
  -> runAgentLoop()
    -> 第1轮 LLM 调用 [用这个 systemPrompt]
    -> 如果有 tool 调用 -> prepareNextTurn() -> createTurnState() [重新调用]
    -> 第2轮 LLM 调用 [用新的 systemPrompt]
    -> ...
```

### 对 Otter 的建议

**使用动态函数模式，两层组合**：

| 层 | 内容 | 变化频率 | 说明 |
|----|------|---------|------|
| 静态层 | Otter 角色定义 + Skill 声明 | 低 | 内容每轮一样，但函数每轮都执行 |
| 动态层 | 会话摘要 + 记忆检索结果 + 系统提醒 | 高 | 内容每轮可能变化 |

**注意**：动态内容如果放在 systemPrompt 函数中，会破坏 LLM 的 prefix caching。对于每轮都变化的提醒，建议用 transformContext 注入到消息列表尾部（见第 3 节）。

---

## 3. System-Reminder 机制

### Pi 没有 system-reminder，但有两个注入点

Pi 没有 Claude Code 的 `<system-reminder>` 概念。要在 LLM 上下文中注入动态信息，有两个注入点：

#### 注入点 A：systemPrompt 函数（注入到 system message）

```typescript
systemPrompt: (ctx) => {
  return [
    "你是一个水獭助手。",
    formatSkillsForSystemPrompt(ctx.resources.skills),
    `<system-reminder>当前时间：${new Date().toISOString()}</system-reminder>`,
  ].join('\n\n');
}
```

- **优点**：system message 权重高，模型当作系统级指令
- **缺点**：如果内容每轮变化，**破坏 LLM prefix caching**

#### 注入点 B：transformContext（注入到消息列表）

```typescript
transformContext: async (messages) => {
  return [...messages, {
    role: "user",
    content: `<system-reminder>你的上一个工具调用失败了，请检查参数</system-reminder>`,
    timestamp: Date.now()
  }];
}
```

- **优点**：不破坏 prefix caching（system prompt 不变）；可插入到消息列表任意位置
- **缺点**：作为 user message，权重低于 system message

#### 实际建议

| 场景 | 机制 | 理由 |
|------|------|------|
| 稳定的提醒（日期、角色约束） | systemPrompt 函数 | 不变，不破坏缓存 |
| 每轮变化的提醒（工具反馈、发言石通知） | transformContext | 保留缓存，注入到消息尾部 |
| 用户打断正在运行的 Agent | `abort()` + `followUp()` | steering 不能中断运行中的 Agent |

**注意**：Steering 消息在**当前轮次的所有 tool 调用完成后**才注入，不能中断正在流式输出的消息或正在执行的工具。

---

## 4. Tool vs Skill 边界

### 核心区别

| | AgentTool | Skill |
|---|-----------|-------|
| 本质 | **可执行的函数** | **可阅读的指令文档**（markdown） |
| 控制字段 | `activeToolNames` | `resources.skills` |
| LLM 怎么用 | 决定"我要调用这个函数" | 决定"我要读取这个指令" |
| 有参数吗 | 有（TypeBox schema） | 没有 |
| 有返回值吗 | 有（执行结果） | 没有 |
| 执行代码吗 | 执行（运行 `execute` 函数） | 不执行 |

### Skill 中的脚本文件

Skill 目录可以包含脚本文件（.py, .sh 等），但：
1. Pi 的 `loadSkills` **只读 SKILL.md**，忽略所有其他文件
2. SKILL.md 可以引用这些脚本（如"运行 ./scripts/analyze.py"）
3. LLM 需要通过 **Tool**（如 bash）来执行脚本，Pi 自己不执行
4. 对 Otter 而言：Otter 不是 coding agent，没有 bash 工具，所以 Skill 应该是**纯指令文档**

### 判断标准

- 它需要**执行代码** + 有**参数** + 有**返回值** -> Tool
- 它是**指导性文字**，告诉 LLM "怎么做" -> Skill

例："创建新獭"需要执行代码（写数据库、创建 harness）-> Tool
例："设计时遵循以下原则"是指导性文字 -> Skill

### 对应到 Snail 系统

| Snail 系统 | Pi 对应 | 例子 |
|-----------|---------|------|
| MCP Tool | AgentTool | `get_current_msg_id()`, `set_final_body()` |
| Skill (SKILL.md) | Skill (SKILL.md) | `cd-design`, `cd-shared` |

---

## 5. MCP 替代方案：AgentTool + 嵌入式架构

### 为什么 Pi 不需要 MCP

**Pi 是嵌入式 Agent 库，运行在应用进程内**。MCP 解决的是"跨进程通信"问题，而 Pi 中不存在进程边界：

| | Claude CLI / Snail | Pi |
|---|-------------------|-----|
| Agent 形态 | 独立程序 | npm 库 |
| 进程关系 | Agent 和系统是两个进程 | 同一个进程 |
| 工具调用 | MCP（跨进程协议） | 函数调用（进程内） |
| 数据访问 | HTTP API | usecase（依赖注入） |
| 需要 MCP | **需要** | **不需要** |

### Tool 如何访问 Otter 系统数据

AgentTool 的 `execute` 函数是 **Otter 系统代码**，通过依赖注入访问数据：

```typescript
// frameworks/agent/tools/get-current-msg-id.ts
function createGetCurrentMsgIdTool(messageService: MessageService): AgentTool {
  return {
    name: 'get_current_msg_id',
    label: '获取当前消息ID',
    description: '获取当前正在流式输出的消息ID',
    parameters: Type.Object({}),
    execute: async () => {
      const msgId = await messageService.getCurrentMessageId();
      return { content: [{ type: 'text', text: msgId }] };
    },
  };
}
```

Tool 和 HTTP Controller 是同层级的东西，只是入口不同：
- HTTP Controller：用户通过 HTTP 调用
- AgentTool：LLM 通过 tool_call 调用

两者都通过 usecase 访问数据，不直接碰数据库。

### activeToolNames 机制

每个 AgentHarness 维护两个工具列表：
- `tools`（内部 Map）：全部注册的工具
- `activeToolNames`（string[]）：LLM 实际能看到的工具子集

**运行时变更**：`harness.setActiveTools(['toolA', 'toolB'])` 可动态切换，不需要重建 harness。空闲时立即生效，运行中下一轮生效。

### beforeToolCall / afterToolCall 钩子

- `beforeToolCall`：可**阻止**工具执行（`{ block: true, reason: "..." }`）
- `afterToolCall`：可**替换**工具结果（`content`、`details`、`isError`、`terminate` 均可覆盖）

提供完整的工具权限控制和结果审计框架。

### Otter 系统 AgentTool 规划

| 工具名 | 用途 | 大獭 | 设计獭 | 检视獭 |
|--------|------|------|--------|--------|
| `send_message` | 发送消息到对话 | yes | yes | yes |
| `pass_talking_stone` | 传递发言石 | yes | - | - |
| `search_memory` | 检索记忆 | yes | yes | yes |
| `store_memory` | 存储记忆 | yes | - | - |
| `create_otter` | 创建新獭 | yes | - | - |
| `dissolve_otter` | 销毁獭 | yes | - | - |
| `create_linked_resource` | 创建链接资源 | - | yes | yes |

所有獭的 `tools` 数组一样（全部注册），差异只在 `activeToolNames`。Skill 的差异通过 `resources.skills` 控制。

---

## 6. Session 管理

### Otter 与 Pi 的边界

```
┌─ Otter 系统（SQLite）───────────┐    ┌─ Pi Agent（JSONL 文件）─────────┐
│                                  │    │                                  │
│  otter_sessions 表               │    │  .pi/sessions/                   │
│    - id (otter session ID)       │───>│    {timestamp}_{sessionId}.jsonl │
│    - pi_session_id (Pi 的 ID)    │    │    - 消息树                      │
│    - previous_session_id (chain) │    │    - compaction 摘要             │
│    - otter_id                    │    │    - 分支/fork 历史              │
│    - status                      │    │                                  │
│                                  │    │  Pi 自行管理，Otter 不感知       │
└──────────────────────────────────┘    └──────────────────────────────────┘
```

**Otter 侧**：只存 `pi_session_id`，通过这个 ID 与 Pi 的 session 文件关联。Session Chain（`previous_session_id`）在 Otter 侧管理。

**Pi 侧**：使用内置 `JsonlSessionRepo` 自行管理 JSONL 文件。Otter 不介入。

### Pi 内置的 Session 能力

Pi 自带完整的 JSONL Session 方案，零自定义实现：

```typescript
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { JsonlSessionRepo, AgentHarness } from "@earendil-works/pi-agent-core";

const env = new NodeExecutionEnv({ cwd: process.cwd() });
const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: ".pi/sessions" });
const session = await repo.create({ cwd: process.cwd() });

const harness = new AgentHarness({ env, session, ... });
```

- `JsonlSessionRepo`：Pi 内置，管理 JSONL 会话文件，支持 create/open/fork/list/delete
- `NodeExecutionEnv`：Pi 内置，完整 Node.js 文件系统实现
- `SessionStorage` 是解耦接口，可自定义实现，但 Otter **不需要自定义**

### Session 模型：Otter chain 而非 Pi fork

Pi 的 `session.fork()` 是**复制历史条目到新文件**。Otter 的 `previousSessionId` 是**引用链**（不复制数据）。

**选用 Otter chain 模型**：新 session 从空开始，通过 `previous_session_id` 形成链。避免 fork 的数据复制开销。

### 大獭和小獭的 Session 策略

| | 大獭 | 小獭 |
|---|------|------|
| 生命周期 | 长期存活 | 有进场/退场，但"活过的证据"需持久化 |
| 存储后端 | `JsonlSessionRepo`（Pi 内置） | `JsonlSessionRepo`（Pi 内置） |
| 区别 | 长期活跃 | 有进场/退场生命周期管理 |

**两者都使用持久化存储**。小獭虽然有进场/退场，但它的 session 历史也需要持久化保存。

### Session 文件生命周期

当 Otter 被解散时，Pi 侧的 JSONL session 文件处理策略：
- 可通过 `JsonlSessionRepo.delete(metadata)` 删除文件
- 也可保留作为历史归档
- 具体策略属于 Otter 业务设计，不在本文档展开

### Custom Session Entries

Pi Session 支持两种自定义条目：
- `CustomEntry`（`type: "custom"`）- 纯数据，不进入 LLM 上下文。可存 issue ID、stage ID 等
- `CustomMessageEntry`（`type: "custom_message"`）- 携带内容，可选是否进入 LLM 上下文

Otter 可用此机制在 Pi Session 树中存储业务元数据。

---

## 7. Compaction（上下文压缩）

### Pi 的机制（手动触发，非自动）

**重要**：Compaction 是**手动**的，不是自动的。

- `shouldCompact()` 函数被导出，但 **AgentHarness 自身从不调用它**
- `harness.compact()` 是公开方法，必须由应用代码显式调用
- Harness 不在轮次间检查 token 用量，也不自动触发压缩

### 压缩配置

```typescript
const DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 16384,    // 摘要 prompt + 输出预留
  keepRecentTokens: 20000, // 保留最近 N token 原始消息
};
```

### 对 Otter 的建议

**触发策略**（冷启动模型下）：

1. 通过 `harness.subscribe()` 监听 `turn_end` 事件，从 `event.message.usage` 缓存 token 用量
2. `harness.prompt()` resolve 后（此时 phase 已回到 "idle"），检查缓存的 token 用量
3. 超过阈值则调用 `harness.compact()`
4. compact 完成后，drop harness 引用

**注意**：`compact()` 要求 `phase == "idle"`，不能在运行中调用。`after_provider_response` 事件不包含 token usage 且触发时 harness 仍在运行，不能用于触发 compact。

**定制点**：
- `session_before_compact` 钩子：在压缩前注入自定义指令
- 压缩摘要自动存入 Memory 系统（通过 `session_compact` 事件监听）

---

## 8. 事件流与前端流式对接

### Pi 事件 -> SSE 映射

| Pi 事件 | SSE 事件 | 前端处理 |
|---------|---------|---------|
| `message_update` (text_delta) | `message.delta` | 追加文本到当前消息 |
| `message_end` (assistant) | `message.complete` | 标记消息完成 |
| `tool_execution_start` | `tool.start` | 显示工具调用中 |
| `tool_execution_end` | `tool.result` | 显示工具结果 |
| `turn_end` | `turn.complete` | 轮次结束 |
| `agent_end` | `agent.idle` | Agent 空闲 |

### Hook 系统（17 种事件）

AgentHarness 提供 17 种类型化 hook 事件，包括：
- `before_agent_start`（可修改 systemPrompt）
- `context`（可修改消息列表）
- `before_provider_request`（可修改 streamOptions）
- `tool_call` / `tool_result`（可阻止/修改）
- `session_before_compact` / `session_compact`
- `model_update` / `tools_update` / `resources_update`
- 等

---

## 9. 场景分析：大獭创建设计獭/检视獭

### Otter 与 Pi 的职责边界

```
┌─ Otter 系统负责 ──────────────────────────────────────────┐
│                                                           │
│  1. 獭的生命周期管理（创建、销毁、进场、退场）              │
│  2. 獭的类型配置（activeToolNames、skills 子集、prompt）   │
│  3. 工具的业务逻辑实现（AgentTool.execute 函数内部）        │
│     - search_memory -> 调用 Otter 记忆检索引擎             │
│     - send_message -> 写入 Otter 对话消息表                │
│     - create_otter -> 创建新獭 + 新 harness                │
│  4. 业务数据（SQLite：otter、session 元数据、对话消息）     │
│  5. 獭间通信（发言石机制、消息传递）                       │
│  6. Web API + SSE 流式推送                                │
│                                                           │
└───────────────────────────────────────────────────────────┘
                         │
                    session ID + harness 实例
                         │
┌─ Pi Agent 负责 ───────────────────────────────────────────┐
│                                                           │
│  1. LLM API 调用（通过 pi-ai）                             │
│  2. 工具调用流程（LLM 决策 -> 调用 execute -> 返回结果）    │
│  3. Session 管理（JSONL 文件、消息树、compaction）          │
│  4. System Prompt 执行（函数求值、Skill 注入）             │
│  5. 事件流（message_update、tool_execution_*、turn_end）   │
│  6. Steering / followUp 机制                               │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

### 场景流程

1. 用户发消息给大獭 -> `harness.prompt(text)`
2. LLM 决定调用 `create_otter({ type: "design" })` 工具
3. Otter 侧（tool execute 内）：
   - SQLite 创建 otter 记录
   - `JsonlSessionRepo.create()` 创建新 Pi Session
   - SQLite 记录 `pi_session_id`
   - 创建新 AgentHarness（配置 activeToolNames + skills + systemPrompt）
   - 调用 `designHarness.prompt(task)` 启动设计獭
4. 设计獭工作：LLM 只看到 3 个工具（send_message, search_memory, create_linked_resource）
5. 设计獭产出后，大獭创建检视獭（同样流程）

### Skill 差异化

所有 Skill 从 `skills/` 目录加载，每个獭通过 `resources.skills` 获得不同子集：

```typescript
const { skills: allSkills } = await loadSkills(env, ['skills/']);
const designSkills = allSkills.filter(s => DESIGN_SKILL_NAMES.includes(s.name));
```

### 待设计：獭间通信

设计獭的产出如何回传给大獭？可选机制：
1. 设计獭调用 `send_message` -> 消息写入对话 -> 大獭下一轮看到
2. Otter 系统调用 `大獭.harness.steer("设计獭的产出是...")` -> 注入大獭下一轮
3. `create_otter` 的 execute 函数直接返回产出 -> 大獭 LLM 在 tool_result 中看到

属于 Otter 系统设计，超出 Pi 能力探索范围。

---

## 10. 完整决策表

| 决策 | 结论 | 理由 |
|------|------|------|
| Pi 集成入口 | **AgentHarness** | 需要 Session/Skill/Compaction/动态 Prompt |
| Agent 形态 | **嵌入式库**（非外挂式 CLI） | Pi 是 npm 库，运行在 Otter 进程内 |
| Session 存储 | **JsonlSessionRepo**（Pi 内置） | 边界清晰，不越界，零自定义实现 |
| Session 模型 | **Otter chain**（previousSessionId 引用） | 避免 fork 复制开销 |
| 小獭 Session | **持久化**（同大獭） | 小獭"活过的证据"需持久化 |
| Otter-Pi 边界 | **Otter 只存 session ID** | Pi 自行管理 session 数据 |
| ExecutionEnv | **NodeExecutionEnv**（Pi 内置） | 不需要自定义 |
| Skill 机制 | **Pi 内置 + loadSkills** | 从 `skills/` 目录加载，纯指令文档 |
| 工具差异化 | **activeToolNames** | 所有工具统一注册，按獭类型激活子集 |
| Skill 差异化 | **resources.skills** | 按獭类型筛选 Skill 子集 |
| MCP | **不引入** | Pi 是嵌入式，无跨进程通信需求 |
| System Prompt | **函数模式，两层** | 静态层（角色+Skill）+ 动态层（上下文+提醒） |
| System-Reminder | **两个注入点** | 稳定内容放 systemPrompt，动态内容放 transformContext |
| Compaction | **Pi compact()，hook 触发** | after_provider_response 中检查 token |
| Tool 数据访问 | **依赖注入 usecase** | 和 HTTP Controller 同模式 |
| Prompt Builder | **接口在 usecases，实现在 frameworks** | 符合整洁架构依赖规则 |
| Harness 生命周期 | **冷启动模型** | 每次发言创建 harness，完成后释放，无空闲内存占用 |
| SQLite 并发 | **不需要额外处理** | better-sqlite3 同步 + WAL 模式已够 |

---

## 11. 修订后的 frameworks/agent/ 架构

```
frameworks/agent/
  pi-harness-factory.ts     # AgentHarness 工厂（创建+配置）
  system-prompt-builder.ts  # 动态 system prompt 组合函数
  tool-registry.ts          # AgentTool 注册表（按 Otter 角色筛选 activeToolNames）
  tools/                    # AgentTool 实现
    get-current-msg-id.ts   # 每个 tool 通过工厂函数注入 usecase
    send-message.ts
    search-memory.ts
    create-otter.ts
    ...
```

**不需要自定义的**：
- ~~SqliteSessionStorage~~ -> 使用 Pi 内置 JsonlSessionRepo
- ~~MinimalExecutionEnv~~ -> 使用 Pi 内置 NodeExecutionEnv
- ~~session-repo-adapter.ts~~ -> Otter 只存 session ID，不需要适配

### AgentRegistry 接口（冷启动模型）

冷启动模型下，AgentRegistry 不再长期持有 harness 实例，而是每次发言时创建，完成后释放：

```typescript
interface AgentHarnessFactory {
  /** 每次发言时调用：创建 harness -> prompt -> 释放。
   *  onEvent 回调用于 SSE 流式推送（message_update, tool_execution_* 等） */
  invoke(otterId: string, message: string, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult>;

  /** 创建新 session（新獭或重启獭生时） */
  createSession(otterId: string, parentSessionId?: string): Promise<string>;

  /** 获取 session 信息 */
  getSessionInfo(otterId: string): Promise<{ piSessionId: string } | null>;
}
```

冷启动流程：
1. 用户发消息 -> `factory.invoke(otterId, message)`
2. 工厂内部：`JsonlSessionRepo.open(sessionId)` 加载 session -> 创建 AgentHarness -> `harness.prompt(message)` -> 等待完成
3. 返回结果，drop harness 引用
4. Session 数据已通过 JSONL 持久化，不丢失

---

## 12. 并发模型与运行时分析

### Pi 的并发模型

**单个 Otter 内部**：严格串行
- `harness.prompt()` 有 `phase` 状态机：运行中（phase != "idle"）调用立即 throw `"busy"`
- 不排队，不缓冲
- 运行中注入消息用 `steer()` / `followUp()`

**多个 Otter 之间**：自然并发
- 每个 AgentHarness 实例完全独立，无共享状态、无锁、无全局协调
- 整个 agent loop 是 async/await，当 Otter A 等待 LLM 响应时，Otter B 可以执行
- Node.js 事件循环天然处理 I/O 并发

### 冷启动模型（用户决策）

每次发言都是独立的生命周期：

```
用户发消息
  -> JsonlSessionRepo.open(sessionId)  [从 JSONL 加载 session]
  -> 创建 AgentHarness（配置 tools, skills, systemPrompt）
  -> harness.prompt(message)
  -> LLM 处理 + 工具执行
  -> 响应完成
  -> drop harness 引用（GC 回收）
```

**优势**：
- 无空闲 harness 占用内存
- 内存中的 harness 数量 = 当前正在发言的 Otter 数量（自然限制）
- 不需要 LRU 淘汰、不需要 max 并发限制
- Session 通过 JSONL 持久化，drop 后不丢数据

**前提验证**：Pi 的 session 写入是 `await` 的（`JsonlSessionStorage.appendEntry()` 调用 `fs.appendFile()` 并 await）。`harness.prompt()` resolve 时，所有 session 写入已完成。

**嵌套场景**：大獭在 `create_otter` 工具的 execute 函数中创建设计獭的 harness 并调用 `designHarness.prompt(task)`。此时大獭的 harness 仍在运行中（`prompt()` 尚未 resolve）。冷启动模型适用于"一次发言"的生命周期；嵌套场景中，外层 harness 不会被释放，内层 harness 在工具 execute 完成后释放。内存中的 harness 数量 = 正在发言的 Otter 数量 + 嵌套创建的 Otter 数量，仍是自然限制。

### SQLite 并发分析

项目使用 `better-sqlite3`（同步 API）+ WAL 模式：

- **同步 API**：所有数据库操作在主线程执行，事件循环天然序列化
- **单线程**：Node.js 单线程，不存在多线程并发写入
- **WAL 模式**：读不阻塞写，写不阻塞读（已启用：`db.pragma("journal_mode = WAL")`）
- **结论**：不需要写入队列、不需要额外锁

### Pi 没有提供的（已确认不需要或暂不关注）

| 缺失能力 | 处理方式 |
|---------|---------|
| LLM 限流 | **不关注**，外部 provider 负责 |
| 内存管理 | **冷启动模型解决**，不需要 Pi 提供 |
| Harness 池 | **不需要**，冷启动自然限制 |
| 连接池 | **不关注**，LLM 侧外部负责 |
| Dispose | **不需要**，drop 引用即可 |
| CPU 密集操作 | **到时候具体分析** |
