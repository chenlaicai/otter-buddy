---
id: F20260713i5k2
title: infra-llm-agent-embedding
doc_type: feature

# 记忆索引
summary: |
  > 以下章节在需求收敛与设计阶段（代码前）完成并锁定。 > 本文档设计 infra 层剩余三个模块：llm-gateway（pi-ai 封装）、agent-core（pi-agent-core 封装 + AgentRegistry）、embedding（bge-m3 Worker Thread...


# 因果链路（正向依赖）
causal_links:
  from:
    - F20260709p4q7
    - F20260709m2n8
    - F20260710b3m9


# 元数据
status: locked
change_type: feature
tags: [implementation, s4, infra, llm, agent, embedding]
modules: [infra/llm-gateway, infra/agent-core, infra/embedding]

# 时间
created_at: 2026-07-13
---


# F20260713i5k2 [infra] LLM 网关 + Agent 核心 + Embedding 服务

## [design-time]

> 以下章节在需求收敛与设计阶段（代码前）完成并锁定。
>
> 本文档设计 infra 层剩余三个模块：llm-gateway（pi-ai 封装）、agent-core（pi-agent-core 封装 + AgentRegistry）、embedding（bge-m3 Worker Thread）。经架构调整 D-S3-2，pi-agent-core 从 app/agent-runtime 移到 infra/agent-core，使 domain 层可直接依赖 Agent 基础设施。

## 背景 [required]

S3-A8 原设计将 pi-agent-core 集成放在 app/agent-runtime（步骤 ⑦），导致 domain/otter 无法直接使用 Agent 能力（domain 不能依赖 app）。用户纠正（msg#4645）：每个海獭实例对应 pi-agent session chain，otter 模块需要管理 Agent 实例。经两位架构师交叉审视，将 pi-agent-core 移到 infra/agent-core（D-S3-2），先实现全部 infra 再实现 domain。

### 约束输入

- S2 D14: 使用 pi-ai + pi-agent-core（不使用 pi-coding-agent）
- S2 D19: bge-m3 1024 维 embedding，Worker Thread 异步推理
- S2 D20: LLM 多提供商 via pi-ai
- S2 Pi Agent 能力映射表：大獭=持久 Agent，小獭=临时 Agent，重启獭生=Agent.reset()
- S2 部署图：Embed Worker 通过 postMessage 回调给 MemSys
- S3-A8 代码目录结构：全局 4 层架构
- D-S3-1: infra/embedding 无 domain 依赖（纯 text->vector Worker Thread）
- D-S3-2: pi-agent-core 从 app 移到 infra
- F20260710b3m9: infra/base 已完成（db, config, logger）

### 已确认决策

| 项目 | 决策 | 来源 |
|------|------|------|
| pi-agent-core 位置 | infra/agent-core（从 app 移出） | D-S3-2，用户纠正 msg#4645 |
| AgentRegistry 设计 | otterId -> Agent 映射，多模块共享 | 架构师-2 提出 |
| OtterPort 不暴露 Agent 执行 | 执行由 app/agent-runtime 通过 AgentRegistry | 架构师-2 提出 |
| embedding 无 db 依赖 | 纯 postMessage 通信 | D-S3-1 |
| 实现顺序 | llm-gateway(1) -> agent-core(2) -> embedding(3) | 依赖关系决定 |
| 测试位置 | tests/infra/ 统一目录 | F20260710b3m9 用户确认 |

## 用户意图锚 [required]

| # | 来源 | 用户原话（逐字引用） | 关键修饰语 | 架构师解读 |
|---|------|---------------------|-----------|-----------|
| UA-1 | F20260710b3m9 UA-S4-4 | infra都应该全是基础设施，如果量不大，是否可以一次性做完呢 | 范围：全部 infra 应全是基础设施 | pi-agent-core 和 embedding 都属于 infra，不应依赖 domain |
| UA-2 | 当前讨论 msg#4641 | 为什么infra/embedding要依赖memory domain？这是拆解的不够清晰吗？infra应该是基础设施，模块依赖途径一定要搞清楚 | 疑问：infra 依赖 domain；要求：依赖途径搞清楚 | embedding 无 domain 依赖，S3-A8 表格错误（D-S3-1） |
| UA-3 | 当前讨论 msg#4645 | 每一个海獭实例都对应底层pi agent的session chain（涉及到session交接、组成的链路） | 每个：海獭实例；对应：pi agent session chain | pi-agent-core 是 infra 技术能力，domain/otter 依赖它管理 Agent |
| UA-4 | 当前讨论 msg#4645 | 是否可以先把pi agent和embding 这些 infra层都整理好，然后再来做domain | 建议：先 infra 后 domain | 实现顺序调整：先全部 infra，再 domain |
| UA-5 | 当前讨论 msg#4649 | 继续。另外，你当前这个otter设计其实也整理好了，你可以一并放入到特性文档中，然后我下一个新issue就让你直接对着最新特性文档来继续做、就不必重头分析了 | 动作：继续；要求：otter 设计放入特性文档；工作流：下一个 issue 直接基于特性文档继续 | 创建 infra Feature 文档 + 更新 otter Feature 文档，下一个 issue 直接基于文档实现，不需要重新分析 |

## 目标 [required]

### P1 - 实现三个 infra 模块

**infra/llm-gateway**：封装 pi-ai，提供多提供商 LLM 抽象
**infra/agent-core**：封装 pi-agent-core，提供 AgentRegistry + Agent 生命周期管理
**infra/embedding**：bge-m3 Worker Thread，纯 text->vector 服务

### P2 - 可独立验证

每个模块可通过集成测试独立验证，不依赖 domain 层。

## 非目标 [required]

- 不实现任何 domain 层模块（otter, memory, conversation, capability, external）
- 不实现 app 层模块（orchestration, agent-runtime）
- 不实现 Skill-to-AgentTool 转换（由 app/agent-runtime 编排）
- 不实现 SSE 事件分发（由 app/agent-runtime 或 adapter/http）
- 不修改 infra/base 已有代码（database.ts, schema.ts, config.ts, logger.ts）
- 不修改 S3 已锁定的 DDL

## 设计 [required]

### 模块总览

```
src/infra/
├── db/                    # 已完成 (F20260710b3m9)
│   ├── database.ts
│   └── schema.ts
├── llm-gateway.ts         # NEW: pi-ai 封装（单文件）
├── agent-core/            # NEW: pi-agent-core 封装（2+ 文件，建子目录）
│   ├── registry.ts        # AgentRegistry（otterId -> Agent 映射）
│   ├── agent.ts           # Agent 包装类（create/destroy/reset/run/stream）
│   └── tool.ts            # AgentTool 类型定义 + 注册辅助
├── embedding/             # NEW: bge-m3 Worker（2+ 文件，建子目录）
│   ├── worker.ts          # Worker Thread 代码（模型加载 + 推理）
│   └── service.ts         # 主线程接口（postMessage 通信封装）
├── config.ts              # 已完成，需扩展 LLM/agent/embedding 配置
└── logger.ts              # 已完成
```


### 1. infra/llm-gateway -- pi-ai LLM 网关

**职责**：封装 pi-ai，提供统一的多提供商 LLM 调用接口。

**公开 API**：

```typescript
// src/infra/llm-gateway.ts

interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

interface LLMGateway {
  /** 同步聊天（等待完整响应） */
  chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse>;

  /** 流式聊天（返回异步迭代器） */
  streamChat(messages: LLMMessage[], options?: LLMChatOptions): AsyncIterable<LLMStreamChunk>;
}

interface LLMChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

interface LLMResponse {
  content: string;
  usage?: { promptTokens: number; completionTokens: number };
}

interface LLMStreamChunk {
  delta: string;
  done: boolean;
}

/** 工厂函数 */
function initLLMGateway(config?: LLMGatewayConfig): LLMGateway;
```

**设计要点**：

| 要点 | 决策 | 依据 |
|------|------|------|
| 提供商支持 | OpenAI / Anthropic / Google（通过 pi-ai） | S2 D20 |
| API Key 管理 | 环境变量 | S1 NFR：单用户本地 |
| 流式支持 | AsyncIterable | SSE 推送需要 |
| 错误处理 | 抛出异常，含提供商错误信息 | S2 D22 分层降级 |
| pi-ai API 调研 | development 阶段完成 | 架构师定义接口要求，开发者调研具体 API |

**config.ts 扩展**：

```typescript
// config.ts 新增
llm: {
  provider: process.env.OTTER_BUDDY_LLM_PROVIDER ?? 'openai',
  model: process.env.OTTER_BUDDY_LLM_MODEL ?? 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY ?? '',
},
```


### 2. infra/agent-core -- pi-agent-core 封装 + AgentRegistry

**职责**：封装 pi-agent-core，提供 Agent 实例生命周期管理和 AgentRegistry。

**公开 API**：

```typescript
// src/infra/agent-core/registry.ts

interface AgentConfig {
  systemPrompt?: string;
  context?: string;           // 初始上下文（如前情摘要）
}

interface AgentHandle {
  /** 注册 AgentTool */
  registerTool(tool: AgentToolDef): void;
  /** 注销 AgentTool */
  unregisterTool(toolId: string): void;
  /** 执行消息（同步，等待完整响应） */
  run(message: string): Promise<string>;
  /** 执行消息（流式） */
  stream(message: string): AsyncIterable<string>;
  /** 重置上下文（重启獭生） */
  reset(context?: string): void;
}

interface AgentToolDef {
  id: string;
  name: string;
  description: string;
  schema: Record<string, unknown>;   // 参数 schema
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

interface AgentRegistry {
  /** 创建 Agent 实例并注册映射 */
  create(otterId: string, config: AgentConfig): AgentHandle;
  /** 销毁 Agent 实例并移除映射 */
  destroy(otterId: string): void;
  /** 重置 Agent 上下文 */
  reset(otterId: string, context?: string): void;
  /** 获取 Agent Handle（不存在返回 null） */
  get(otterId: string): AgentHandle | null;
}

/** 工厂函数 */
function initAgentCore({ llmGateway }: { llmGateway: LLMGateway }): { agentRegistry: AgentRegistry };
```

**设计要点**：

| 要点 | 决策 | 依据 |
|------|------|------|
| AgentRegistry | Map<otterId, AgentHandle> | 多模块共享 Agent 实例 |
| Agent 生命周期 | create/destroy/reset | S2 能力映射表 |
| AgentTool 注册 | registerTool/unregisterTool | S2 统一能力库 = AgentTool[] |
| Agent 执行 | run/stream | 对话执行 + SSE 流式 |
| AgentHandle 不通过 Port 暴露 | app/agent-runtime 直接使用 AgentRegistry | 避免 infra 类型泄漏到 domain Port |
| pi-agent-core API 调研 | development 阶段完成 | 架构师定义接口要求 |

**AgentRegistry 消费方**：

| 消费方 | 用途 | 方法 |
|--------|------|------|
| domain/otter | Agent 生命周期管理 | create, destroy, reset |
| app/agent-runtime | Agent 执行 + Tool 注册 | get, registerTool, run, stream |


### 3. infra/embedding -- bge-m3 Worker Thread

**职责**：在 Worker Thread 中运行 bge-m3 模型，提供 text->vector 服务。不直接访问数据库。

**公开 API**：

```typescript
// src/infra/embedding/service.ts

interface EmbeddingService {
  /** 生成文本的 embedding 向量 */
  embed(text: string): Promise<Float32Array>;
  /** 释放 Worker Thread 资源 */
  dispose(): void;
}

/** 工厂函数（无 db 参数） */
function initEmbedding(config?: EmbeddingConfig): EmbeddingService;
```

**设计要点**：

| 要点 | 决策 | 依据 |
|------|------|------|
| 运行环境 | Worker Thread | S2 D19：不阻塞主线程 |
| 模型 | Xenova/bge-m3 ONNX | S2 D19 |
| 向量维度 | 1024 | S2 D19 |
| 通信方式 | postMessage（text 请求 -> Float32Array 响应） | S2 部署图 |
| 数据库访问 | **不访问** | D-S3-1：纯 text->vector 服务 |
| 依赖 | @huggingface/transformers | S2 技术选型 |
| 模型加载 | 首次调用时懒加载或初始化时预加载 | development 阶段决定 |

**config.ts 扩展**：

```typescript
// config.ts 已有 embedding.dimensions，新增：
embedding: {
  dimensions: 1024,           // 已有
  modelPath: 'Xenova/bge-m3', // 模型标识
},
```

**Worker Thread 通信协议**：

```
主线程 -> Worker: { type: 'embed', text: string, id: number }
Worker -> 主线程: { type: 'result', embedding: Float32Array, id: number }
Worker -> 主线程: { type: 'error', error: string, id: number }
```


### 4. main.ts 装配（修订后）

```typescript
// main.ts 伪代码（修订后）
const db = initDatabase();                          // infra/db ✅
const llm = initLLMGateway();                       // infra/llm-gateway (NEW)
const { agentRegistry } = initAgentCore({ llm });   // infra/agent-core (NEW)
const embedding = initEmbedding();                  // infra/embedding (NEW)

// domain 层（待实现）
const otterPort = initOtter({ db, agentRegistry }); // domain/otter
const memoryPort = initMemory({ db, embedding });   // domain/memory
// ...
```

## 偏差记录 [required]

### D-S3-1: infra/embedding 依赖方向纠正

| 项目 | S3-A8 表格（错误） | 正确设计 |
|------|-------------------|---------|
| infra/embedding 依赖 | memoryPort（domain） | 无 domain 依赖（纯 Worker Thread） |
| initEmbedding 参数 | { db } | () 或 ({ modelPath? }) |

### D-S3-2: pi-agent-core 从 app 移到 infra

| 项目 | S3-A8 原设计 | 修订设计 |
|------|-------------|---------|
| pi-agent-core 位置 | app/agent-runtime（步骤 ⑦） | infra/agent-core（步骤 ②） |
| domain/otter 依赖 | 仅 infra/db | infra/db + infra/agent-core |
| 实现顺序 | otter(①) 先于 agent-core(⑦) | agent-core(②) 先于 otter(④) |

## 硬约束 [required]

- infra 层不依赖 domain/app/adapter 层
- infra/embedding 不访问数据库（D-S3-1）
- AgentRegistry 是 Agent 实例的唯一管理入口
- AgentHandle 不通过 domain Port 接口暴露
- 所有 infra 模块可独立测试（不依赖 domain）

## 设计取舍 [required]

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| pi-agent-core 位置 | infra/agent-core | app/agent-runtime | domain/otter 需直接使用 Agent 能力，infra 依赖方向正确 |
| AgentRegistry 设计 | 集中管理 otterId->Agent | 各模块自行管理 | 多模块共享 Agent 实例，避免重复创建 |
| embedding 无 db | 纯 postMessage 通信 | Worker 直接写 memory_vec | 职责分离：embedding 生成是 infra，存储是 domain |
| llm-gateway 单文件 | llm-gateway.ts | llm-gateway/ 子目录 | 单文件足够，pi-ai 封装层薄 |
| agent-core 子目录 | agent-core/{registry,agent,tool}.ts | 单文件 | 3 个相关文件，符合 2+ 建子目录原则 |
| pi-ai/pi-agent-core API | development 阶段调研 | design 阶段调研 | 架构师定义接口要求，开发者调研具体 API |

## 改动范围 [required]

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/infra/llm-gateway.ts` | 新增 | pi-ai LLM 网关封装 |
| `src/infra/agent-core/registry.ts` | 新增 | AgentRegistry |
| `src/infra/agent-core/agent.ts` | 新增 | Agent 包装类 |
| `src/infra/agent-core/tool.ts` | 新增 | AgentTool 类型 + 辅助 |
| `src/infra/embedding/worker.ts` | 新增 | Worker Thread 代码 |
| `src/infra/embedding/service.ts` | 新增 | 主线程接口 |
| `src/infra/config.ts` | 修改 | 新增 llm/embedding 配置项 |
| `tests/infra/llm-gateway.test.ts` | 新增 | LLM 网关测试 |
| `tests/infra/agent-core.test.ts` | 新增 | Agent 核心 + Registry 测试 |
| `tests/infra/embedding.test.ts` | 新增 | Embedding 服务测试 |

## 验证 [required]

### 验收标准

- [ ] `npm run check` 通过（lint + build）
- [ ] `npm run test` 通过（含已有 infra 测试）
- [ ] llm-gateway: chat 和 streamChat 可调用（mock LLM 或真实 API）
- [ ] agent-core: AgentRegistry create/destroy/reset/get 全流程
- [ ] agent-core: AgentHandle registerTool/unregisterTool 可用
- [ ] agent-core: AgentHandle run/stream 可调用（mock LLM）
- [ ] embedding: embed(text) 返回 Float32Array[1024]
- [ ] embedding: Worker Thread 通信正确（postMessage 协议）
- [ ] embedding: 不访问数据库
- [ ] 所有 infra 模块不 import domain/app/adapter 层

### 测试设计

#### tests/infra/llm-gateway.test.ts

| 测试用例 | 验证点 |
|---------|--------|
| chat 基本调用 | 返回 LLMResponse |
| streamChat 基本调用 | 返回 AsyncIterable<LLMStreamChunk> |
| 错误处理 | LLM 调用失败时抛出异常 |

#### tests/infra/agent-core.test.ts

| 测试用例 | 验证点 |
|---------|--------|
| AgentRegistry.create | 创建 Agent 实例，get 可获取 |
| AgentRegistry.destroy | 销毁后 get 返回 null |
| AgentRegistry.reset | reset 后 Agent 上下文清空 |
| AgentRegistry.get 不存在 | 返回 null |
| AgentHandle.registerTool | 工具注册成功 |
| AgentHandle.unregisterTool | 工具注销成功 |
| AgentHandle.run | 返回响应（mock LLM） |
| AgentHandle.stream | 返回异步迭代器（mock LLM） |

#### tests/infra/embedding.test.ts

| 测试用例 | 验证点 |
|---------|--------|
| embed 基本调用 | 返回 Float32Array，长度 1024 |
| embed 多次调用 | 每次返回正确向量 |
| dispose | 释放后 embed 抛出异常 |
| Worker 通信 | postMessage 协议正确 |

## 关联 [required]

- **S3 数据模型设计**：[F20260709p4q7](../09/F20260709p4q7-data-model-design.md)
- **S2 能力模块架构设计**：[F20260709m2n8](../09/F20260709m2n8-capability-module-architecture.md)
- **infra/base 基础设施基础层**：[F20260710b3m9](../10/F20260710b3m9-infra-base-foundation.md)
- **domain/otter 设计**：[F20260713o4t8](./F20260713o4t8-domain-otter.md)
- **项目实施计划**：[otter-buddy#5](https://github.com/chenlaicai/otter-buddy/issues/5)

## 核心业务行为 [required]

> infra 层不直接承载业务行为，但以下行为依赖 infra 能力。

| # | 场景 | 依赖的 infra 能力 | 意图锚 |
|---|------|------------------|--------|
| B-Infra-1 | 当创建海獭时 | AgentRegistry.create() 创建 Agent 实例 | ← UA-3 |
| B-Infra-2 | 当解散海獭时 | AgentRegistry.destroy() 销毁 Agent 实例 | ← UA-3 |
| B-Infra-3 | 当重启獭生时 | AgentRegistry.reset() 重置 Agent 上下文 | ← UA-3 |
| B-Infra-4 | 当 Agent 执行对话时 | AgentHandle.run/stream + LLMGateway | ← UA-3 |
| B-Infra-5 | 当记忆系统需要 embedding 时 | EmbeddingService.embed() 生成向量 | ← UA-2 |
| B-Infra-6 | 当加载 Skill 到 Agent 时 | AgentHandle.registerTool() 注册 AgentTool | ← UA-3 |
