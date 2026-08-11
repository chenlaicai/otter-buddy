---
id: F20260731mmr0
title: multi-model-routing
doc_type: feature

summary: |
  多模型路由：大獭创建小獭时可按任务类型选择不同模型。
  config.yaml 配置 llm.models[] 多个模型及其能力描述，构建 ModelPool 统一管理，
  大獭身份 prompt 注入模型选择指南，create_otter 工具增加 modelAlias 参数。
  模型选择在创建时固定，生命周期内不切换。一步到位，完整实现。

causal_links:
  from:
    - F20260716t2ab   # Tool/Skill 机制
    - F20260722ta2k   # Session 复用机制

status: proposed
change_type: feature
tags: [agent, llm, multi-model, routing, pi-ai]
modules: [src/frameworks/llm/, src/frameworks/agent/, src/interface-adapters/agent-runtime/tools/]

created_at: 2026-07-31
---

# F20260731mmr 多模型路由

## 背景

### 现状

系统只支持单模型，config.yaml 中配置一个 provider + model，所有 otter 共享同一个模型：

```
config.yaml (llm.provider + llm.model)
  → initModels() 返回单个 model
  → PiSessionFactory 持有该 model
  → 所有 otter 使用同一个模型
```

### 问题

不同任务对模型的需求不同：
- **日常对话、简单任务**：需要快速响应、低成本
- **复杂推理、编码任务**：需要强推理能力
- **大量子任务**：需要便宜快速的模型

单模型无法兼顾速度、成本、能力的平衡。

### 已有基础

| 组件 | 状态 | 说明 |
|------|------|------|
| Pi AI SDK 多 provider 支持 | ✅ 已有 | 支持 20+ provider（OpenAI、Anthropic、Google、Mistral 等） |
| `createModels()` + `setProvider()` | ✅ 已有 | 可注册多个 provider 到同一个 Models 实例 |
| `models.getModel(provider, modelId)` | ✅ 已有 | 按 provider + modelId 获取模型 |
| `loadCustomProvider()` | ✅ 已有 | 支持自定义 apiBaseUrl/apiKey |

Pi SDK 原生支持多模型，Otter 需要做的是：配置层 + 路由层 + 持久化层。

## 用户意图锚

| ID | 用户原话 | 关键修饰语 | 架构师解读 | 来源 |
|----|---------|-----------|-----------|------|
| UA-1 | "后台有多个模型，创建小獭时基于不同任务使用不同模型" | 多模型；不同任务；不同模型 | 需要模型池 + 路由机制 | 用户反馈 |
| UA-2 | "维持一套模型连接池，以及各个模型的优劣势" | 连接池；优劣势 | 模型需要能力描述，供路由决策 | 用户反馈 |
| UA-3 | "在创建小獭 skill 中让大獭能结合业务需求使用不同的模型连接" | 大獭决策；业务需求 | 路由决策权交给大獭，系统提供信息 | 用户反馈 |
| UA-4 | "决定权交由大獭" | 决定权 | 系统不强制路由，只提供模型描述 | 用户反馈 |
| UA-5 | "暂不考虑切换" | 暂不考虑 | 模型选择在创建时固定，生命周期内不切换 | 用户反馈 |

## 目标

### T1 — 模型连接池（ModelPool）

config.yaml 配置 `llm.models[]` 多个模型，每个模型有唯一 alias、provider 信息、能力描述（description + strengths + weaknesses）。启动时构建 ModelPool，统一管理所有模型。

### T2 — 大獭模型选择能力

大獭身份 prompt 中注入可用模型列表及其能力描述。大獭调用 create_otter 时可指定 modelAlias。

### T3 — 按 otter 绑定模型

不同小獭使用不同模型。模型选择在创建时固定，持久化到 otter_configs 表，生命周期内不切换。

### T4 — 可观测性

invoke 日志记录使用的模型信息，熔断器使用 per-otter 的 contextWindow。

## 非目标

- **不支持运行时切换模型** — 模型选择在创建时固定
- **不支持自动降级** — 模型不可用时直接报错，不自动切换到备选模型
- **不支持成本预算** — 当前不实现 per-otter 成本限额
- **不改造 AgentGateway 接口** — modelAlias 通过接口字段传递，不改方法签名

## 设计方案

### D1 — 配置结构

config.yaml 一步到位改为多模型配置：

```yaml
llm:
  default: "mimo-fast"        # 默认模型 alias
  models:
    - alias: "mimo-fast"
      provider: "openai"
      model: "mimo-v2.5-pro"
      apiKey: "tp-..."
      apiBaseUrl: "https://..."
      description: "快速推理，性价比高，适合日常对话"
      strengths: ["快速响应", "中文优秀", "性价比高"]
      weaknesses: ["复杂推理较弱", "长上下文窗口有限"]
      contextWindow: 131072

    - alias: "claude-sonnet"
      provider: "anthropic"
      model: "claude-sonnet-4-20250514"
      apiKey: "sk-..."
      description: "平衡型，推理和编码能力强"
      strengths: ["强推理", "代码能力优秀", "长上下文"]
      weaknesses: ["价格较高"]
      contextWindow: 200000
```

**设计要点**：
- `alias` 是路由键，解耦 otter 与 provider 内部细节
- `description/strengths/weaknesses` 用于注入大獭 prompt，由运维人员维护
- `default` 指定大獭使用的模型，也作为小獭不指定时的回退
- `contextWindow` 用于 per-otter 熔断器配置

**启动时校验**：
- `default` 必须在 `models[]` 中存在
- `alias` 不能重复
- `models[]` 不能为空
- 扫描 otter_configs 表，对引用了不存在的 modelAlias 的 otter 发出警告日志
- 检测旧格式（`llm.provider` + `llm.model`）并给出迁移提示，不支持旧格式需手动迁移

### D2 — ModelPool（模型池）

新建 `src/frameworks/llm/model-pool.ts`，封装 alias→model 映射和能力描述：

| 方法 | 功能 |
|------|------|
| `getModel(alias)` | 按 alias 获取 pi-ai Model，不存在时回退到默认模型 |
| `getDefaultModel()` | 获取默认模型 |
| `getDefaultAlias()` | 获取默认 alias |
| `describeModels()` | 返回模型描述列表，供 prompt 注入 |
| `hasModel(alias)` | 检查 alias 是否存在 |
| `getContextWindow(alias)` | 获取模型的 contextWindow |
| `getAllEntries()` | 返回所有 ModelEntry，供 ensurePiCodingAgent 遍历设 key |

**`initModels()` 新签名**：
```typescript
export async function initModels(
  modelConfig: AppConfig["llm"],
  logger?: Logger,
): Promise<{ models: Models; model: unknown; modelPool: ModelPool }>
```
- `models`：pi-ai Models 注册表（所有 provider 已注册）
- `model`：默认模型（兼容旧代码引用）
- `modelPool`：ModelPool 实例

**构建过程**：
- 创建一个 `pi-ai createModels()` 实例
- 遍历 `config.llm.models[]`，对每个条目独立创建 provider 实例（不复用）
- 用 `Map<alias, ModelEntry>` 做查找

**`loadProvider` 签名改造**：
- 当前签名：`loadProvider(provider, modelId, llmConfig)` — provider 用于 switch-case 模块加载
- 新签名：`loadProvider(providerType, modelId, alias, llmConfig)` — providerType 用于模块加载（openai/anthropic），alias 用于注册 provider ID
- config 中每个 model 条目保留 `provider` 字段作为 providerType（pi-ai 原生类型名），`alias` 作为路由键
- `loadCustomProvider()` 同理：providerType 做 if/else 模块选择，alias 做 `createProvider({ id: alias })`

**VALID_PROVIDERS 处理**：
- 扩展白名单支持 pi-ai 的全部 provider：`["openai", "anthropic", "google", "mistral", "deepseek", ...]`
- 或改为动态校验（检查 pi-ai 是否支持该 provider）

**SPIKE 测试**：
- 验证 `createProvider({ id: "custom-alias", ... })` 是否被 pi-ai 接受
- 验证 `models.getModel("custom-alias", modelId)` 返回的 model 能否正确发起请求
- 验证 `setRuntimeApiKey("custom-alias", key)` 是否能正确为后续请求提供 auth
- 验证单 Models 实例注册多个不同 ID 的 provider 后，跨 provider 的 model 能否正常工作
- B 计划：若不支持，每个 alias 创建独立的 Models 实例（`Map<alias, { models, model }>`），每个实例自带 auth，ModelRuntime 不再需要跨 provider 设 key

### D3 — 数据流

```
config.yaml (llm.models[] + llm.default)
  → initModels() 构建 ModelPool
  → PiSessionFactory 持有 ModelPool
  → 大獭身份 prompt 注入模型能力描述（buildModelSelectionGuidance）
  → 大獭调用 create_otter(name, type, systemPrompt, modelAlias)
  → CreateOtter.execute() → AgentGateway.create(otterId, { modelAlias })
  → PiSessionFactory.create() 持久化 modelAlias 到 otter_configs 表
  → PiSessionFactory.invoke() 读取 modelAlias → modelPool.getModel(alias) → 用该模型创建 session
```

**modelAlias 传递路径**：
- `create_otter 工具` → `OtterToolClient.CreateOtterInput.modelAlias` → `CreateOtter.execute()` → `AgentConfig.modelAlias` → `PiSessionFactory.create()` → `OtterConfigProvider.setConfig()` → DB
- 注意：有两个 `CreateOtterInput` 接口（`otter-tool-client.ts` 和 `create-otter.ts`），都需要增加 modelAlias 字段

**模型解析时机**：
- invoke 时从 `otterConfig.modelAlias` 读取，通过 `modelPool.getModel(alias)` 解析
- 找不到 alias 时回退到默认模型并记录错误日志

### D4 — 持久化

`otter_configs` 表增加 `model_alias TEXT` 列：
- 新增 migration：`ALTER TABLE otter_configs ADD COLUMN model_alias TEXT`
- `OtterConfig` 接口增加 `modelAlias?: string`
- `SqliteOtterConfigProvider` 的 `setConfig()`/`getConfig()` 同步读写该列

**Session 恢复时保留 modelAlias**：
- `SessionRestore.createSessionAndPersist()` 写入 OtterConfig 时包含 modelAlias
- `handleMissingSession()` 和 `recreateFromConfig()` 从 DB 读取 modelAlias 并写回
- `PiSessionFactory._resetInternal()` 保留已有 modelAlias

### D5 — 工具层改动

**create_otter 工具**：
- parameters 增加 `modelAlias` 可选参数
- execute 时校验 modelAlias 是否存在
- 校验失败返回错误信息，列出可用模型

**modelPool 注入**：
- 通过扩展 `ToolContext` 接口注入：`ToolContext` 增加可选 `modelPool?: ModelPool` 字段
- 不改 `createTools` 签名，避免影响所有调用方和测试文件
- `createCreateOtterTool` 从 `ctx.modelPool` 获取 modelPool
- **注入点**：`PiSessionFactory.cfg` 增加 `modelPool: ModelPool` 字段，`buildCustomTools()` 中构造 ToolContext 时填入 `modelPool: this.cfg.modelPool`

### D6 — Prompt 注入

大獭身份 prompt 中注入模型选择指南，格式：

```markdown
## 可用模型

- **mimo-fast**：快速推理，性价比高，适合日常对话
  优势: 快速响应、中文优秀、性价比高；劣势: 复杂推理较弱
- **claude-sonnet**：平衡型，推理和编码能力强
  优势: 强推理、代码能力优秀；劣势: 价格较高

创建小獭时可通过 `modelAlias` 参数选择模型。不指定则使用默认模型。
只在任务有明确的模型适配需求时才选择，大多数情况下默认模型即可。
```

**注入条件**：
- 仅注入大獭身份（小獭不需要选模型）
- 当模型数量 > 1 时才注入（单模型无选择可言）

### D7 — invoke 时模型解析

`PiSessionFactory._createSessionWithTools()` 中：
- 签名增加 `otterConfig` 参数（从 `_executeWithSession` 传入）
- 从 `otterConfig` 读取 `modelAlias`
- 通过 `modelPool.getModel(alias)` 解析模型，不存在时回退到默认模型
- 将解析后的模型传给 `createAgentSession({ model })`
- 记录日志：otterId、requestedAlias、resolvedAlias、provider

**大獭的 default 模型回退逻辑**：
- 大獭不是通过 create_otter 创建的，otterConfig 中没有 modelAlias
- 模型解析逻辑：`otterConfig.modelAlias ?? modelPool.getDefaultModel()`
- 即：有 modelAlias 用指定模型，没有则用 default

**ensurePiCodingAgent() 改造**：
- 通过 `this.cfg.modelPool.getAllEntries()` 获取所有模型条目
- 遍历每个条目，调用 `setRuntimeApiKey(alias, key)`
- 不做 provider 去重（每个 alias 对应独立的 provider 实例和 auth）

### D8 — 其他适配

| 改动点 | 说明 |
|--------|------|
| `_buildInvokeResult()` | 签名增加 otterId 参数，从 otterConfig 读 modelAlias，通过 modelPool.getContextWindow(alias) 获取 per-otter contextWindow |
| `syncApiKeyToAgentAuth()` | 遍历 models[] 设置所有 provider 的 key |
| `settings` 接口 | 显示 default 模型信息 |
| LLM request 日志 | 增加 modelAlias 字段 |
| 启动时校验 | 扫描 otter_configs，对引用不存在的 modelAlias 发出警告 |

## 链路追踪

| # | 连接点 | 状态 |
|---|--------|------|
| 1 | config.yaml → initModels() | 改动 |
| 2 | initModels() → ModelPool | 改动（新建） |
| 3 | main.ts 组装 | 改动 |
| 4 | PiSessionFactory.create() → SessionRestore → OtterConfigProvider → DB | 改动 |
| 5 | create_otter 工具 → CreateOtter.execute() → AgentGateway.create() | 改动 |
| 6 | AgentGateway.create() → PiSessionFactory.create() | **已打通** |
| 7 | PiSessionFactory.invoke() → modelPool.getModel() → createAgentSession() | 改动 |
| 8 | SessionRestore 内部重建路径 | 改动 |

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `src/frameworks/config-service.ts` | AppConfig.llm 改为 models[] 结构 + validate() 校验 |
| `src/frameworks/llm/model-pool.ts` | **新建**。ModelPool 实现 |
| `src/frameworks/llm/models-factory.ts` | initModels() 返回 ModelPool，loadProvider/loadCustomProvider 适配 |
| `src/frameworks/db/migration.ts` | otter_configs 加 model_alias 列 |
| `src/usecases/ports/otter-config-provider.ts` | OtterConfig 增加 modelAlias |
| `src/frameworks/db/otter/sqlite-otter-config-provider.ts` | 读写 model_alias |
| `src/usecases/otter/agent-gateway.ts` | AgentConfig 增加 modelAlias 字段 |
| `src/usecases/otter/create-otter.ts` | CreateOtterInput 增加 modelAlias，execute() 透传 |
| `src/interface-adapters/agent-runtime/otter-tool-client.ts` | CreateOtterInput 增加 modelAlias |
| `src/frameworks/agent/session-restore.ts` | createSessionAndPersist() 透传 modelAlias（含内部两个调用点） |
| `src/frameworks/agent/pi-session-factory.ts` | 接收 ModelPool，invoke 按 otter 解析模型（_createSessionWithTools 增加 otterConfig 参数），ensurePiCodingAgent 遍历设 key，reset 保留 modelAlias，日志增加模型信息，_buildInvokeResult per-otter contextWindow，buildIdentityPrefix 注入模型描述，buildCustomTools 注入 modelPool 到 ToolContext |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | ToolContext 增加可选 modelPool 字段，create_otter 增加 modelAlias + 校验 |
| `src/main.ts` | 组装 ModelPool，syncApiKeyToAgentAuth 遍历，settings 适配，启动时校验 |

## 实施顺序

### Phase 0: SDK 兼容性验证
- spike 测试：跨 provider model 混用、多次 setRuntimeApiKey
- B 计划：若不支持，每个 alias 创建独立的 Models 实例

### Phase 1: 配置 + ModelPool
- config-service.ts — ModelConfig + AppConfig.llm + validate()
- model-pool.ts — ModelPool 实现（新建）
- models-factory.ts — initModels() 返回 ModelPool

### Phase 2: 持久化
- migration.ts — model_alias 列
- otter-config-provider.ts — OtterConfig 接口
- sqlite-otter-config-provider.ts — 读写

### Phase 3: 业务串联
- agent-gateway.ts — AgentConfig 增加 modelAlias
- create-otter.ts — CreateOtterInput + execute()
- otter-tool-client.ts — CreateOtterInput 接口
- session-restore.ts — 透传 modelAlias

### Phase 4: Session 工厂
- pi-session-factory.ts — 接收 ModelPool，invoke 解析模型，ensurePiCodingAgent 遍历设 key，reset 保留，日志，contextWindow
- pi-session-factory.ts — buildCustomTools 中注入 modelPool 到 ToolContext

### Phase 5: 工具 + Prompt
- tool-factory.ts — ToolContext 增加可选 modelPool 字段，create_otter 增加 modelAlias + 校验
- pi-session-factory.ts — buildIdentityPrefix 注入模型描述

### Phase 6: 组装
- main.ts — 组装 ModelPool，syncApiKeyToAgentAuth，settings 适配，启动时校验

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 路由键 | modelAlias 字符串 | 解耦 otter 与 provider，改 provider 只改 config |
| provider ID | 用 alias 作为 provider ID | 避免同 provider 多 apiBaseUrl 时 ID 冲突 |
| model.provider | 也改为 alias | 确保 SDK auth 解析正确 |
| 模型信息传递 | prompt 注入 | 零工具调用开销，大獭始终可见 |
| 能力描述 | description + strengths + weaknesses | 完整信息帮助大獭决策，运维维护合理 |
| modelAlias 传递 | AgentConfig 直接加字段 | 类型安全，改动面极小 |
| 大獭模型 | 固定用 default | 大獭是决策者，用最强模型 |
| modelPool 注入工具层 | ToolContext 扩展字段 | 不改 createTools 签名，避免影响所有调用方 |
| getModel 行为 | 不存在时回退默认 | 容错，避免单点失败 |
| contextWindow | per-otter 从 modelPool 获取 | 熔断器配置准确 |

## 审视记录

经六轮架构师对抗审视：

| 问题 | 轮次 | 修复 |
|------|------|------|
| Pi SDK 兼容性假设未验证 | 第 1 轮 | Phase 0 spike 测试 |
| modelAlias 无校验 | 第 1 轮 | 工具层 + invoke 层双重校验 |
| config 连锁反应 | 第 1 轮 | 补全所有引用点 |
| 同 provider 多 apiBaseUrl 的 provider ID 冲突 | 第 2 轮 | 用 alias 作为 provider ID |
| default alias 无启动时校验 | 第 2 轮 | validate() 增加校验 |
| model.provider 与 provider.id 不一致 | 第 3 轮 | model.provider 也改为 alias |
| modelPool 注入工具层机制 | 第 3 轮 | 闭包注入，扩展 createTools 签名 |
| 模型变更时存量 otter 处理 | 第 4 轮 | 启动时扫描警告 |
| 大獭决策有效性 | 第 4 轮 | 完整设计一步到位，出了效果再调整 |
| loadProvider switch-case 与 alias 矛盾 | 第 5 轮 | loadProvider 签名改为 (providerType, modelId, alias, llmConfig) |
| VALID_PROVIDERS 白名单限制 | 第 5 轮 | 扩展白名单支持 pi-ai 全部 provider |
| createTools 签名变更影响面 | 第 5 轮 | 改为 ToolContext 扩展字段，不改 createTools 签名 |
| _createSessionWithTools 缺 otterConfig | 第 5 轮 | 签名增加 otterConfig 参数 |
| _buildInvokeResult 的 contextWindow 来源 | 第 5 轮 | 签名增加 otterId，从 modelPool.getContextWindow(alias) 获取 |
| B 计划实现细节 | 第 5 轮 | 补充 B 计划的具体实现细节 |
| 两个 CreateOtterInput 接口需同步改动 | 第 6 轮 | D3 数据流明确标出 OtterToolClient.CreateOtterInput |
| ToolContext 的 modelPool 注入点未明确 | 第 6 轮 | buildCustomTools 中从 this.cfg.modelPool 注入 |
| initModels 返回类型未写 | 第 6 轮 | 补充新签名 |
| 大獭 default 模型回退逻辑未说明 | 第 6 轮 | D7 明确 otterConfig.modelAlias ?? modelPool.getDefaultModel() |
| apiKey 多 provider 环境变量限制 | 第 6 轮 | 每个 model 条目独立 apiKey，env var 回退需扩展 |
