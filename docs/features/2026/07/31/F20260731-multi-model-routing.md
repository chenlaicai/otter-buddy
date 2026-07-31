---
id: F20260731mmr
title: multi-model-routing
doc_type: feature

summary: |
  多模型路由：大獭创建小獭时可按任务类型选择不同模型。
  config.yaml 新增可选 llm.models[] 配置多个模型，create_otter 工具增加 modelAlias 参数，
  大獭身份 prompt 注入模型列表。模型选择在创建时固定，生命周期内不切换。
  保持旧 config 格式完全兼容。

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

### T1 — 多模型配置

config.yaml 新增可选 `llm.models[]` 配置多个模型，每个模型有唯一 alias、provider 信息、一句话 description。旧 `llm.provider + llm.model` 格式完全兼容。

### T2 — 大獭模型选择能力

大獭身份 prompt 中注入可用模型列表（alias + description）。大獭调用 create_otter 时可指定 modelAlias。

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

保持旧 `llm.provider + llm.model` 格式完全兼容，新增可选 `llm.models[]` 扩展：

```yaml
# 旧格式（继续有效，单模型模式）
llm:
  provider: "openai"
  model: "gpt-4o"
  apiKey: "sk-..."

# 新格式（多模型模式，可选）
llm:
  default: "mimo-fast"        # 默认模型 alias
  models:
    - alias: "mimo-fast"
      provider: "openai"
      model: "mimo-v2.5-pro"
      apiKey: "tp-..."
      apiBaseUrl: "https://..."
      description: "快速推理，性价比高，适合日常对话"

    - alias: "claude-sonnet"
      provider: "anthropic"
      model: "claude-sonnet-4-20250514"
      apiKey: "sk-..."
      description: "平衡型，推理和编码能力强"
```

**设计要点**：
- `alias` 是路由键，解耦 otter 与 provider 内部细节，不侵入 SDK provider 体系
- `description` 一句话描述，用于注入大獭 prompt（不写 strengths/weaknesses，避免运维手写过时）
- `default` 指定大獭使用的模型，也作为小獭不指定时的回退
- 旧格式 → 单模型模式，行为完全不变；新格式 → 多模型模式

**启动时校验**（仅多模型模式）：
- `default` 必须在 `models[]` 中存在
- `alias` 不能重复
- `models[]` 不能为空
- 扫描 otter_configs 表，对引用了不存在的 modelAlias 的 otter 发出警告日志

### D2 — 模型注册

不新建 ModelPool 类，直接在 `initModels()` 中构建 `Map<alias, ModelEntry>`：

```typescript
// initModels() 返回值
{ models: Models, model: unknown, modelMap?: Map<string, { model: unknown, config: ModelConfig }> }
```

**构建过程**：
- 遍历 `config.llm.models[]`，对每个条目调用 `loadProvider()` 注册到同一个 pi-ai Models 实例
- 用 `Map<alias, ModelEntry>` 做查找
- 旧格式时 modelMap 为 undefined，用 model 字段兜底

**SPIKE 测试 B 计划**：
- 如果 pi-ai 不支持单 Models 实例多 provider，退回为每个 alias 创建独立的 Models 实例
- 如果 `setRuntimeApiKey()` 不支持多次调不同 provider，改为 per-request 传入 apiKey

### D3 — 数据流

```
config.yaml (llm.models[] + llm.default)
  → initModels() 构建 modelMap (alias → Model)
  → PiSessionFactory 持有 modelMap
  → 大獭身份 prompt 注入模型列表（alias + description）
  → 大獭调用 create_otter(name, type, systemPrompt, modelAlias)
  → CreateOtter.execute() → AgentGateway.create(otterId, { modelAlias })
  → PiSessionFactory.create() 持久化 modelAlias 到 otter_configs 表
  → PiSessionFactory.invoke() 读取 modelAlias → modelMap.get(alias) → 用该模型创建 session
```

**modelAlias 传递路径**：
- `create_otter 工具` → `CreateOtterInput.modelAlias` → `AgentConfig.modelAlias` → `SessionRestore.createSessionAndPersist()` → `OtterConfigProvider.setConfig()` → DB

**模型解析时机**：
- invoke 时从 `otterConfig.modelAlias` 读取，通过 `modelMap.get(alias)` 解析
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

**modelMap 注入**：
- 通过闭包注入：`createTools(ctx, modelMap)` 签名扩展
- 不改 ToolContext 接口，modelMap 作为参数传入

### D6 — Prompt 注入

大獭身份 prompt 中注入模型列表，格式：

```markdown
## 可用模型

- **mimo-fast**：快速推理，性价比高，适合日常对话
- **claude-sonnet**：平衡型，推理和编码能力强

创建小獭时可通过 `modelAlias` 参数选择模型。不指定则使用默认模型。
```

**注入条件**：
- 仅注入大獭身份（小獭不需要选模型）
- 当模型数量 > 1 时才注入（单模型无选择可言）
- 只注入 alias + description，不注入 strengths/weaknesses（避免运维手写过时）

### D7 — invoke 时模型解析

`PiSessionFactory._createSessionWithTools()` 中：
- 从 `otterConfig` 读取 `modelAlias`
- 通过 `modelMap.get(alias)` 解析模型，不存在时回退到默认模型
- 将解析后的模型传给 `createAgentSession({ model })`
- 记录日志：otterId、requestedAlias、resolvedAlias、provider

**ensurePiCodingAgent() 改造**：
- 遍历所有模型，按 provider 去重设置 API key
- 替代当前只设置一个 provider key 的逻辑
- SPIKE 失败时退回：per-request 传入 apiKey

### D8 — 其他适配

| 改动点 | 说明 |
|--------|------|
| `_buildInvokeResult()` | 初期用默认模型的 contextWindow，后续可扩展为 per-otter |
| `syncApiKeyToAgentAuth()` | 遍历 models[] 设置所有 provider 的 key |
| `settings` 接口 | 显示 default 模型信息 |
| LLM request 日志 | 增加 modelAlias 字段 |
| 启动时校验 | 扫描 otter_configs，对引用不存在的 modelAlias 发出警告 |

## 链路追踪

| # | 连接点 | 状态 |
|---|--------|------|
| 1 | config.yaml → initModels() | 改动 |
| 2 | initModels() → modelMap | 改动 |
| 3 | main.ts 组装 | 改动 |
| 4 | PiSessionFactory.create() → SessionRestore → OtterConfigProvider → DB | 改动 |
| 5 | create_otter 工具 → CreateOtter.execute() → AgentGateway.create() | 改动 |
| 6 | AgentGateway.create() → PiSessionFactory.create() | **已打通** |
| 7 | PiSessionFactory.invoke() → modelMap.get() → createAgentSession() | 改动 |
| 8 | SessionRestore 内部重建路径 | 改动 |

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `src/frameworks/config-service.ts` | AppConfig.llm 增加可选 models[] 结构 + validate() 校验 |
| `src/frameworks/llm/models-factory.ts` | initModels() 返回 modelMap，loadProvider/loadCustomProvider 适配 |
| `src/frameworks/db/migration.ts` | otter_configs 加 model_alias 列 |
| `src/usecases/ports/otter-config-provider.ts` | OtterConfig 增加 modelAlias |
| `src/frameworks/db/otter/sqlite-otter-config-provider.ts` | 读写 model_alias |
| `src/usecases/otter/agent-gateway.ts` | AgentConfig 增加 modelAlias 字段 |
| `src/usecases/otter/create-otter.ts` | CreateOtterInput 增加 modelAlias，execute() 透传 |
| `src/interface-adapters/agent-runtime/otter-tool-client.ts` | CreateOtterInput 增加 modelAlias |
| `src/frameworks/agent/session-restore.ts` | createSessionAndPersist() 透传 modelAlias（含内部两个调用点） |
| `src/frameworks/agent/pi-session-factory.ts` | 接收 modelMap，invoke 按 otter 解析模型，ensurePiCodingAgent 遍历设 key，reset 保留 modelAlias，日志增加模型信息，buildIdentityPrefix 注入模型列表 |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | createTools 增加 modelMap 参数，create_otter 增加 modelAlias + 校验 |
| `src/main.ts` | 组装 modelMap，createTools 传 modelMap，syncApiKeyToAgentAuth 遍历，settings 适配 |

## 实施顺序

### Phase 0: SDK 兼容性验证
- spike 测试：跨 provider model 混用、多次 setRuntimeApiKey
- B 计划：若不支持，每个 alias 创建独立的 Models 实例

### Phase 1: 配置 + 模型注册
- config-service.ts — ModelConfig + AppConfig.llm 增加可选 models[] + validate()
- models-factory.ts — initModels() 返回 modelMap

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
- pi-session-factory.ts — 接收 modelMap，invoke 解析模型，ensurePiCodingAgent 遍历设 key，reset 保留，日志

### Phase 5: 工具 + Prompt
- tool-factory.ts — createTools 增加 modelMap，create_otter 增加 modelAlias + 校验
- pi-session-factory.ts — buildIdentityPrefix 注入模型列表

### Phase 6: 组装
- main.ts — 组装 modelMap，syncApiKeyToAgentAuth，settings 适配，启动时校验

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 路由键 | modelAlias 字符串 | 解耦 otter 与 provider，改 provider 只改 config |
| provider ID | 保持 SDK 原生 ID | alias 只做路由键，不侵入 SDK provider 体系 |
| 模型信息传递 | prompt 注入 | 零工具调用开销，大獭始终可见 |
| 能力描述 | 只用 alias + description | strengths/weaknesses 运维手写不可持续，先验证大獭是否真会用 |
| modelAlias 传递 | AgentConfig 直接加字段 | 类型安全，改动面极小 |
| 大獭模型 | 固定用 default | 大獭是决策者，用最强模型 |
| modelMap 注入工具层 | 闭包注入 | 不改 ToolContext 接口 |
| getModel 行为 | 不存在时回退默认 | 容错，避免单点失败 |
| 向后兼容 | 旧 config 格式继续有效 | 不破坏现有部署 |
| contextWindow | 初期用默认模型值 | 简化，后续可扩展为 per-otter |

## 审视记录

经四轮架构师对抗审视：

| 问题 | 轮次 | 修复 |
|------|------|------|
| Pi SDK 兼容性假设未验证 | 第 1 轮 | Phase 0 spike 测试 |
| modelAlias 无校验 | 第 1 轮 | 工具层 + invoke 层双重校验 |
| config 连锁反应 | 第 1 轮 | 补全所有引用点 |
| 同 provider 多 apiBaseUrl 的 provider ID 冲突 | 第 2 轮 | 不改 provider ID，alias 只做路由键 |
| default alias 无启动时校验 | 第 2 轮 | validate() 增加校验 |
| model.provider 与 provider.id 不一致 | 第 3 轮 | 不改 model.provider，保持 SDK 原生 |
| modelPool 注入工具层机制 | 第 3 轮 | 闭包注入，扩展 createTools 签名 |
| ModelPool 过度抽象 | 第 4 轮 | 不建 ModelPool，用 Map<alias, Model> |
| strengths/weaknesses 不可持续 | 第 4 轮 | 只用 alias + description |
| 向后兼容被破坏 | 第 4 轮 | 旧 config 格式继续有效 |
| 模型变更时存量 otter 处理 | 第 4 轮 | 启动时扫描警告 |
| 大獭决策有效性未验证 | 第 4 轮 | 先最小改动验证，再投入增强 |
