---
id: F20260716t2ab
title: tool-skill-mechanism
from_ids: [F20260716i5n2, F20260715k4p2, F20260715r3s2]
tags: [architecture, agent, tools, skills, pi-agent]
modules: [src/interface-adapters/agent-runtime/, src/frameworks/agent/]
doc_kind: spec
status: locked
created_at: 2026-07-16
---

# F20260716xxxx Otter 系统 Tool/Skill 机制搭建

## [design-time]

> Issue：tool/skill机制查缺补漏。核心认知：**Pi 提供机制，Otter 定义产物**。Pi 的 AgentHarness 已有完整的 Tool 注册/发现/执行机制和 Skill 加载/注入机制。Otter 的职责是：定义本系统所需的工具（遵循 Pi AgentTool 格式）和 Skill（遵循 Pi SKILL.md 格式）。

## 背景 [required]

### 已有基础

| 组件 | 状态 | 来源 |
|------|------|------|
| Pi AgentTool 机制（注册/发现/执行） | ✅ Pi 已提供 | F20260715r3s2 第 4/5 节 |
| Pi Skill 机制（加载/注入/可见性） | ✅ Pi 已提供 | F20260715r3s2 第 4 节 |
| 8 个 AgentTool 实现 | ✅ 已实现 | F20260716i5n2 interface-adapters/agent-runtime/tools/ |
| AgentInvoker 编排器 | ✅ 已实现 | F20260716i5n2 interface-adapters/agent-runtime/agent-invoker.ts |
| PiHarnessFactory（冷启动模型） | ✅ 已实现 | F20260715k4p2 frameworks/agent/pi-harness-factory.ts |

### Pi 已提供的机制（不需要 Otter 重建）

| 机制 | Pi 提供 | Otter 需要做的 |
|------|---------|---------------|
| 工具注册 | `AgentHarness({ tools })` | 定义工具数组传入 |
| 工具可见性 | `activeToolNames` + `setActiveTools()` | 按 otterType 选择子集 |
| 工具执行 | Pi 的 agent loop 自动调用 `execute` | 实现 execute 函数 |
| Skill 加载 | `loadSkills(env, ['skills/'])` | 创建 SKILL.md 文件 |
| Skill 可见性 | `resources.skills` | 按 otterType 筛选 |
| Skill 注入 | `formatSkillsForSystemPrompt()` | 在 systemPrompt 函数中调用 |

### 当前代码的问题

1. **工具不足**：只有 7 个工具，缺少消息历史检索、上下文管理等能力
2. **Skill 从未接入**：无 SKILL.md 文件，Skill 从未注入 system prompt
3. **OtterToolClient 缺失**：工具各自注入 use case，没有统一的数据访问层

## 用户意图锚 [required]

| ID | 用户原话 | 关键修饰语 | 架构师解读 | 来源 |
|----|---------|-----------|-----------|------|
| UA-1 | "otter系统要搭建一套什么机制" + "skill和tool机制难道不是pi自行加载的吗" | Pi 提供机制；Otter 定义产物 | Otter 不重建 Pi 已有的机制，而是定义本系统所需的工具和 Skill | msg-1 + msg-3 |
| UA-2 | "pi agent如何访问otter系统提供的接口来访问到数据，而这些接口应该是同一个机制" | 统一访问机制；Tool 是通用能力 | 工具通过统一的 OtterToolClient 访问 Otter 数据 | msg-2 |
| UA-3 | "在otter系统中，也要有完整的一套对话工具集" | 完整的一套 | 定义完整的工具集 | msg-1 |

## 目标 [required]

### T1 — 定义新工具

按 Pi AgentTool 格式定义 6 个新工具：get_message、list_messages、search_messages、get_turn_history、get_context、set_context。

### T2 — 创建 Skill 文件

按 Pi SKILL.md 格式创建 Skill 文件，放在 `skills/` 目录。Pi 的 `loadSkills` 自动加载。

### T3 — OtterToolClient（工具内部便利层）

定义 `OtterToolClient` 作为工具访问 Otter 数据的统一门面。工具的 execute 函数通过 client 访问数据，不直接注入 use case。

### T4 — Schema 变更

新增 `otter_context` 表（上下文存储）和 `messages_fts` 虚拟表（消息全文搜索）。

### T5 — main.ts 装配

在 main.ts 中创建 OtterToolClient、定义工具、配置 activeToolNames、加载 Skill。

## 非目标 [required]

- **不重建 ToolRegistry** — Pi 的 AgentHarness 已处理工具注册/可见性
- **不重建 SkillLoader** — Pi 的 `loadSkills` 已处理 Skill 加载
- **不改造 system-prompt-builder** — Pi 的 `formatSkillsForSystemPrompt` 已处理 Skill 注入
- **不实现 Skill 依赖验证** — Skill 是纯指令文档，不依赖工具
- 不实现 MCP 协议（Pi 是嵌入式库）
- 不修改 AgentInvoker 消息生命周期

## 设计方案

### D1 — OtterToolClient（工具内部便利层）

**定位**：工具访问 Otter 数据的统一门面。不是机制层，是便利层——替代每个工具各自注入 use case 的模式。

```typescript
// interface-adapters/agent-runtime/otter-tool-client.ts

export interface OtterToolClient {
  conversation: {
    message: {
      send(params: { conversationId: string; senderId: string; body: string; talkingStonePassedTo?: string[] }): Promise<Message>;
      getById(id: string): Promise<Message | null>;
      list(conversationId: string, opts?: { limit?: number; before?: string }): Promise<Message[]>;
      search(conversationId: string, query: string, limit?: number): Promise<Message[]>;
      getTurnHistory(conversationId: string, opts?: { includeMessages?: boolean }): Promise<TurnHistory[]>;
    };
    participant: {
      join(conversationId: string, otterId: string): Promise<Participant>;
      getActive(conversationId: string): Promise<Participant[]>;
    };
  };
  memory: {
    search(query: string, limit?: number): Promise<MemoryEntry[]>;
    store(entry: StoreMemoryInput): Promise<string>;
  };
  otter: {
    create(params: CreateOtterInput): Promise<Otter>;
    dissolve(otterId: string): Promise<void>;
    getById(id: string): Promise<Otter | null>;
  };
  context: {
    get(otterId: string, key?: string): Promise<Record<string, string>>;
    set(otterId: string, key: string, value: string): Promise<void>;
  };
  resource: {
    link(params: LinkResourceInput): Promise<LinkedResource>;
  };
}
```

在 `main.ts` 装配时创建，包装所有 use case 实例。

### D2 — 工具定义（遵循 Pi AgentTool 格式）

工具定义在 `interface-adapters/agent-runtime/tools/tool-factory.ts` 中，遵循 Pi 的 AgentTool 接口。

**现有工具**（8 个）：send_message、pass_talking_stone、search_memory、get_memory_detail、store_memory、create_otter、dissolve_otter、create_linked_resource

**新增工具**（6 个）：

**工具创建模式**：invoke 时创建工具（闭包捕获 ToolContext），不在启动时注册。Pi 的 AgentHarness 处理工具注册/可见性/执行。

```typescript
// PiHarnessFactory.invoke() 中
invoke(otterId, message, options) {
  const ctx: ToolContext = {
    client: this.otterToolClient,
    otterId,
    conversationId: options.conversationId,
  };
  const tools = createTools(ctx); // invoke 时创建，闭包捕获 ctx
  const activeToolNames = getToolNamesForOtterType(otterType);
  const harness = new AgentHarness({ tools, activeToolNames, ... });
  await harness.prompt(message);
}
```

| 工具名 | 功能 | 参数 |
|--------|------|------|
| `get_message` | 按 ID 获取消息 | messageId |
| `list_messages` | 分页查询消息列表 | conversationId, limit?, before? |
| `search_messages` | 关键词搜索消息 | conversationId, query, limit? |
| `get_turn_history` | 获取 Turn 历史链 | conversationId, includeMessages? |
| `get_context` | 获取 Otter 上下文 | key? |
| `set_context` | 设置 Otter 上下文 | key, value |

**工具通过 OtterToolClient 访问数据**（ToolContext 注入）：

```typescript
interface ToolContext {
  client: OtterToolClient;
  otterId: string;
  conversationId: string;
}
```

`otterId` 和 `conversationId` 由系统在 invoke 时注入，LLM 不传。

### D3 — Skill 文件（遵循 Pi SKILL.md 格式）

创建 `skills/` 目录，包含示例 Skill 文件。Pi 的 `loadSkills` 自动加载。

```markdown
# skills/otter-shared/SKILL.md

---
name: otter-shared
description: 海獭系统共享行为规范
---

## 消息规范

1. 每次发言必须包含完整的最终答复
2. 使用中文与用户交流
3. 消息内容应结构化，使用 Markdown 格式

## 记忆规范

1. 重要决策应存储到记忆系统
2. 检索记忆后再回答历史相关问题
```

**配置 Skill 可见性**：在 `main.ts` 中按 otterType 筛选 Skill 子集，传入 `resources.skills`。

### D4 — Schema 变更

```sql
-- Otter 上下文存储
CREATE TABLE IF NOT EXISTS otter_context (
  otter_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (otter_id, key),
  FOREIGN KEY (otter_id) REFERENCES otters(id)
);

-- 消息全文搜索
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  message_id UNINDEXED, body, tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(message_id, body) VALUES (NEW.id, NEW.body);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, message_id, body) VALUES ('delete', OLD.id, OLD.body);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF body ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, message_id, body) VALUES ('delete', OLD.id, OLD.body);
  INSERT INTO messages_fts(message_id, body) VALUES (NEW.id, NEW.body);
END;
```

### D5 — Use Case 扩展

| 变更 | 内容 |
|------|------|
| 新增 `ManageContext` use case | CRUD for otter_context（get/set/delete/listByOtter） |
| 新增 `OtterContextRepository` 接口 | 定义在 usecases 层，实现 frameworks/db |
| 扩展 `QueryMessage` | +searchMessages() +getTurnHistory() |
| 扩展 `ConversationRepository` | +searchMessages()（FTS5 查询） |

### D6 — main.ts 装配

```typescript
// 1. 创建 OtterToolClient（包装 use case，含 QueryOtter）
const otterToolClient: OtterToolClient = {
  conversation: {
    message: {
      send: (params) => uc.sendMessage.send(params),
      getById: (id) => uc.queryMessage.getMessageById(id),
      list: (convId, opts) => uc.queryMessage.getMessages(convId, opts),
      search: (convId, query, limit) => uc.queryMessage.searchMessages(convId, query, limit),
      getTurnHistory: (convId, opts) => uc.queryMessage.getTurnHistory(convId, opts),
    },
    participant: {
      join: (convId, otterId) => uc.manageParticipant.join(convId, otterId),
      getActive: (convId) => uc.manageParticipant.getActiveParticipants(convId),
    },
  },
  memory: {
    search: (query, limit) => uc.searchMemory.search({ query, limit }),
    store: (entry) => uc.storeMemory.execute(entry),
  },
  otter: {
    create: (params) => uc.createOtter.execute(params),
    dissolve: (id) => uc.dissolveOtter.execute(id),
    getById: (id) => uc.queryOtter.getById(id),  // QueryOtter
  },
  context: {
    get: (otterId, key) => uc.manageContext.get(otterId, key),
    set: (otterId, key, value) => uc.manageContext.set(otterId, key, value),
  },
  resource: {
    link: (params) => uc.manageKeyInfo.linkResource(params),
  },
};

// 2. PiHarnessFactory 持有 otterToolClient，invoke 时创建工具
// （不在启动时注册工具，invoke 时闭包捕获 ToolContext）
```

## 核心业务行为

| ID | 触发条件 | 预期行为 | 追溯 |
|----|---------|---------|------|
| B1 | invoke() 时 | Pi AgentHarness 加载工具 + Skill，LLM 获得完整能力 | ← UA-1 |
| B2 | LLM 调用工具时 | Tool.execute(args, ctx) 通过 OtterToolClient 访问数据 | ← UA-2 |
| B3 | invoke() 时 | Skill 内容通过 formatSkillsForSystemPrompt 注入 system prompt | ← UA-1 |

## 硬约束

1. 工具遵循 Pi 的 AgentTool 格式（name + description + parameters + execute）
2. Skill 遵循 Pi 的 SKILL.md 格式
3. 不重建 Pi 已有的机制（ToolRegistry、SkillLoader、system-prompt-builder）
4. 追求完整，不考虑向后兼容 ← UA-3
5. 不引入新的第三方依赖

## 验证

- [x] 6 个新工具遵循 Pi AgentTool 格式
- [x] 工具通过 OtterToolClient 访问数据（不直接注入 use case）
- [x] get_context/set_context 从闭包捕获的 ctx.otterId 取值，不从 LLM 参数取
- [x] 工具在 invoke 时创建（闭包捕获 ToolContext），不在启动时注册
- [x] Skill 文件存在于 `skills/` 目录，Pi loadSkills 可加载
- [x] 按 otterType 配置不同的 activeToolNames 和 Skill 子集（harness 创建时）
- [x] OtterToolClient 注入 QueryOtter
- [x] Schema 变更（otter_context + messages_fts + trigger）正确执行
- [x] `tsc --noEmit` 通过

## 实现分 Part

| Part | 内容 | 依赖 |
|------|------|------|
| Part 1 | Schema 变更 + OtterContextRepository + ManageContext use case | 无 |
| Part 2 | QueryMessage 扩展（+searchMessages +getTurnHistory）+ ConversationRepository 扩展 | Part 1 |
| Part 3 | OtterToolClient（含 QueryOtter）+ ToolFactory 重构（invoke 时创建，闭包捕获 ToolContext）+ 6 个新工具 | Part 2 |
| Part 4 | PiHarnessFactory 改造（invoke 时创建工具 + 加载 Skill + 配置 activeToolNames）+ 移除 ToolRegistry | Part 3 |
| Part 5 | Skill 文件创建 + 测试 | Part 1-4 |

## 相关链接

- [Pi Agent 能力探索](docs/research/R20260716x2k9-pi-capability-analysis.md) — F20260715r3s2
- [Interface Adapters 层实现](docs/features/2026/07/16/F20260716i5n2.md) — F20260716i5n2
- [Frameworks 层实现](docs/features/2026/07/15/F20260715k4p2-frameworks-layer-implementation.md) — F20260715k4p2
