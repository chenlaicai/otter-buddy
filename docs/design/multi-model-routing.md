# 多模型路由设计文档

## 1. 愿景

Otter 系统后台维护多个模型连接池，大獭创建小獭时能基于任务类型选择最合适的模型。系统提供模型能力描述，路由决策权交给大獭。

## 2. 核心数据流

```
config.yaml (llm.models[] + llm.default)
  → initModels() 构建 ModelPool（统一 Models 注册表 + alias→model 映射）
  → PiSessionFactory 持有 ModelPool
  → 大獭身份 prompt 注入模型能力描述
  → 大獭调用 create_otter(name, type, systemPrompt, modelAlias)
  → CreateOtter.execute() → AgentGateway.create(otterId, { context: { modelAlias } })
  → PiSessionFactory.create() 持久化 modelAlias 到 otter_configs 表
  → PiSessionFactory.invoke() 读取 modelAlias → modelPool.getModel(alias) → 用该模型创建 session
```

## 3. 配置结构

```yaml
llm:
  default: "mimo-fast"
  models:
    - alias: "mimo-fast"
      provider: "openai"
      model: "mimo-v2.5-pro"
      apiKey: "tp-..."
      apiBaseUrl: "https://token-plan-cn.xiaomimimo.com/v1"
      description: "MiMo v2.5 Pro — 快速推理，性价比高，适合日常对话和简单任务"
      strengths: ["快速响应", "中文优秀", "性价比高"]
      weaknesses: ["复杂推理较弱", "长上下文窗口有限"]
      contextWindow: 131072

    - alias: "claude-sonnet"
      provider: "anthropic"
      model: "claude-sonnet-4-20250514"
      apiKey: "sk-..."
      description: "Claude Sonnet 4 — 平衡型，推理和编码能力强"
      strengths: ["强推理", "代码能力优秀", "长上下文"]
      weaknesses: ["价格较高"]
      contextWindow: 200000
```

**要点**：
- `default` 指定大獭使用的模型（也作为小獭不指定时的回退）
- `models[]` 定义模型池，每个条目有唯一 `alias`
- description/strengths/weaknesses 用于注入大獭 prompt

## 4. 接口设计

### 4.1 ModelConfig（config 层）

```typescript
// src/frameworks/config-service.ts
interface ModelConfig {
  alias: string;
  provider: string;
  model: string;
  apiKey?: string;
  apiBaseUrl?: string;
  description?: string;
  strengths?: string[];
  weaknesses?: string[];
  contextWindow?: number;
}
```

### 4.2 ModelPool（模型池）

```typescript
// src/frameworks/llm/model-pool.ts
interface ModelPool {
  getModel(alias: string): unknown;          // 按 alias 获取 pi-ai Model
  getDefaultModel(): unknown;                // default 模型
  getDefaultAlias(): string;
  describeModels(): ModelDescriptor[];       // 供 prompt 注入
  hasModel(alias: string): boolean;
}

interface ModelDescriptor {
  alias: string;
  description: string;
  strengths: string[];
  weaknesses: string[];
  contextWindow?: number;
}
```

### 4.3 OtterConfig（持久化层）

```typescript
// src/usecases/ports/otter-config-provider.ts
interface OtterConfig {
  systemPrompt?: string | OtterPromptConfig;
  otterType: OtterType;
  modelAlias?: string;  // 本次新增
}
```

### 4.4 CreateOtterInput（业务层）

```typescript
// src/usecases/otter/create-otter.ts
interface CreateOtterInput {
  name: string;
  type: OtterType;
  role?: OtterRole;
  parentOtterId?: string;
  systemPrompt?: string | OtterPromptConfig;
  context?: Record<string, unknown>;
  modelAlias?: string;  // 本次新增
}
```

### 4.5 OtterToolClient.CreateOtterInput（工具层）

```typescript
// src/interface-adapters/agent-runtime/otter-tool-client.ts
interface CreateOtterInput {
  name: string;
  type: "big" | "small";
  systemPrompt: string;
  parentOtterId: string;
  modelAlias?: string;  // 本次新增
}
```

## 5. 文件改动清单

| 文件 | 改动 |
|------|------|
| `src/frameworks/config-service.ts` | AppConfig.llm 增加 `default` + `models[]`，新增 ModelConfig 接口，validate() 增加校验 |
| `src/frameworks/llm/model-pool.ts` | **新建**。ModelPool 实现 |
| `src/frameworks/llm/models-factory.ts` | `initModels()` 返回 ModelPool，loadCustomProvider() 用 alias 作为 provider ID |
| `src/frameworks/db/migration.ts` | otter_configs 表增加 model_alias 列 |
| `src/usecases/ports/otter-config-provider.ts` | OtterConfig 增加 modelAlias |
| `src/frameworks/db/otter/sqlite-otter-config-provider.ts` | 读写 model_alias |
| `src/usecases/otter/agent-gateway.ts` | AgentConfig 增加 modelAlias 字段 |
| `src/usecases/otter/create-otter.ts` | CreateOtterInput 增加 modelAlias，execute() 直接传入 AgentConfig |
| `src/interface-adapters/agent-runtime/otter-tool-client.ts` | CreateOtterInput 增加 modelAlias |
| `src/frameworks/agent/session-restore.ts` | createSessionAndPersist() config 参数增加 modelAlias，透传给 setConfig（含内部两个调用点） |
| `src/frameworks/agent/pi-session-factory.ts` | 接收 ModelPool，invoke 按 otter 解析模型，ensurePiCodingAgent 遍历 provider 设 key，reset 保留 modelAlias，invoke 日志增加模型信息（含 modelAlias），_buildInvokeResult 使用 per-otter contextWindow，buildIdentityPrefix 注入模型能力描述 |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | create_otter 工具增加 modelAlias 参数 + 校验；createTools 签名增加 modelPool 参数 |
| `src/main.ts` | 组装 ModelPool，syncApiKeyToAgentAuth 遍历所有模型，settings 引用改为 defaultAlias |

## 6. 实施顺序

### Phase 0: SDK 兼容性验证（前置）
验证 pi-coding-agent SDK 的三个关键能力：
- `createAgentSession()` 是否支持不同 provider 的 model 对象
- `setRuntimeApiKey()` 是否支持多次调用设置不同 provider 的 key
- `createProvider()` 是否支持自定义 ID + model.provider 与 provider.id 一致
- 若不支持，调整方案为每个 provider 单独创建 Models 实例

### Phase 1: 配置 + ModelPool（基础设施）
1. config-service.ts — ModelConfig 接口 + AppConfig.llm 扩展 + validate() 增加 default/alias/models[] 校验 + 旧格式迁移提示
2. model-pool.ts — ModelPool 实现（新建）
3. models-factory.ts — initModels() 返回 ModelPool，loadCustomProvider() 用 alias 作为 provider ID + model.provider 改为 alias，loadProvider() 增加 alias 参数

### Phase 2: 持久化
4. migration.ts — otter_configs 加 model_alias 列
5. otter-config-provider.ts — OtterConfig 接口扩展
6. sqlite-otter-config-provider.ts — 读写 model_alias

### Phase 3: 业务串联
7. agent-gateway.ts — AgentConfig 增加 modelAlias 字段
8. create-otter.ts — CreateOtterInput 增加 modelAlias，execute() 直接传入 AgentConfig
9. otter-tool-client.ts — CreateOtterInput 接口
10. session-restore.ts — createSessionAndPersist() config 参数增加 modelAlias，透传给 setConfig（含内部两个调用点）

### Phase 4: Session 工厂
11. pi-session-factory.ts — 接收 ModelPool，invoke 按 otter 解析模型
12. pi-session-factory.ts — ensurePiCodingAgent() 遍历所有 provider 设置 key
13. pi-session-factory.ts — _resetInternal() 保留 modelAlias
14. pi-session-factory.ts — _buildInvokeResult() 使用 per-otter contextWindow
15. pi-session-factory.ts — invoke 日志增加模型信息（含 modelAlias）

### Phase 5: 工具 + Prompt
16. tool-factory.ts — createTools 签名增加 modelPool 参数，create_otter 增加 modelAlias 参数 + 校验
17. pi-session-factory.ts — buildIdentityPrefix() 注入模型能力描述

### Phase 6: 组装
18. main.ts — initModels 传 ModelPool，createTools 传 modelPool，syncApiKeyToAgentAuth 遍历，settings 引用适配

## 7. 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 路由键 | modelAlias 字符串 | 解耦 otter 与 provider，改 provider 只改 config |
| 模型信息传递 | prompt 注入 | 零工具调用开销，大獭始终可见可选 |
| modelAlias 路径 | context 内透传 → OtterConfig 持久化 | 不改 AgentGateway 接口 |
| 大獭模型 | 固定用 default | 大獭是决策者，用最强模型；路由只针对小獭 |
| 单模型场景 | 仍然需要配 models[] | 统一入口，不保留旧的单字段模式 |
| modelAlias 传递 | AgentConfig 直接加字段 | 类型安全，不污染 context，改动面极小 |
| provider ID | 用 alias 而非 provider 名称 | 避免同 provider 多实例冲突 |

## 8. 自检：链路追踪结果

10 个连接点，1 个天然打通（连接点 7），9 个需改动，无结构性断点。

| # | 连接点 | 状态 | 说明 |
|---|--------|------|------|
| 1 | config.yaml → initModels() | 改动 | AppConfig.llm 改为 default + models[] |
| 2 | initModels() → ModelPool | 改动 | 新建 model-pool.ts，loadProvider() 可多次调用注册同一 Models（已验证） |
| 3 | main.ts 组装 | 改动 | 传 modelPool 替代 model；syncApiKeyToAgentAuth 遍历所有模型 |
| 4a | PiSessionFactory._createSessionAndPersist | 改动 | 从 config.context 提取 modelAlias 透传给 SessionRestore |
| 4b | PiSessionFactory._createSessionWithTools | 改动 | invoke 时从 otterConfig.modelAlias 解析模型 |
| 5 | create_otter 工具 | 改动 | parameters 增加 modelAlias，execute 透传 |
| 6 | CreateOtter.execute() → AgentGateway.create() | 改动 | CreateOtterInput 增加 modelAlias，放入 context |
| 7 | AgentGateway → PiSessionFactory.create() | **已打通** | context 是 Record<string, unknown>，modelAlias 直接透传 |
| 8 | SessionRestore.createSessionAndPersist() | 改动 | config 参数增加 modelAlias |
| 9 | SessionRestore → OtterConfigProvider.setConfig() | 改动 | OtterConfig 增加 modelAlias，setConfig 写入时带上 |
| 10 | OtterConfigProvider → DB | 改动 | otter_configs 表增加 model_alias 列 |

### 8.1 SessionRestore 内部调用点（文档补充）

SessionRestore 内部有两处调用 `createSessionAndPersist()` 的地方，也需要同步传递 modelAlias：

```typescript
// handleMissingSession() - session 文件丢失时从 DB 配置重建
private handleMissingSession(otterId, piCodingAgent, sessionDir) {
  const existingConfig = this.otterConfigProvider.getConfig(otterId);
  return this.createAndReturnSession(otterId, {
    systemPrompt: existingConfig.systemPrompt,
    otterType: existingConfig.otterType,
    modelAlias: existingConfig.modelAlias,  // ← 补上
  }, piCodingAgent, sessionDir);
}

// recreateFromConfig() - session 文件损坏时从 DB 配置重建
private recreateFromConfig(otterId, piCodingAgent, sessionDir, cause?) {
  const config = this.otterConfigProvider.getConfig(otterId);
  return this.createAndReturnSession(otterId, {
    systemPrompt: config?.systemPrompt,
    otterType: config?.otterType ?? 'big',
    modelAlias: config?.modelAlias,  // ← 补上
  }, piCodingAgent, sessionDir, cause);
}
```

这两处从 `otterConfigProvider.getConfig()` 读取配置（此时 OtterConfig 已含 modelAlias），重建 session 时需要把 modelAlias 写回去，否则 session 重建后会丢失模型选择。

## 9. 架构师对抗审视：发现与修复

### P0-1: Pi SDK 兼容性假设未验证

**问题**：方案假设 pi-coding-agent 的 `createAgentSession()` 支持跨 provider 的 model 对象混用，且 `ModelRuntime.setRuntimeApiKey()` 支持同 provider 多 key。当前代码中 `setRuntimeApiKey()` 只设置一个 provider 的 key（`pi-session-factory.ts` 第 194-197 行）。

**修复**：实施前先做 spike 测试。`setRuntimeApiKey()` 需要改为遍历所有 provider 设置 key：

```typescript
// pi-session-factory.ts ensurePiCodingAgent() 中
// 当前：只设置一个 provider 的 key
if (llmConfig.apiKey && this.modelRuntime) {
  await this.modelRuntime.setRuntimeApiKey(llmConfig.provider, llmConfig.apiKey);
}

// 改为：遍历所有模型，按 provider 去重设置 key
if (this.modelRuntime && this.cfg.modelPool) {
  const seen = new Set<string>();
  for (const entry of this.cfg.modelPool.getAllEntries()) {
    const provider = entry.config.provider;
    if (entry.config.apiKey && !seen.has(provider)) {
      seen.add(provider);
      await this.modelRuntime.setRuntimeApiKey(provider, entry.config.apiKey);
    }
  }
}
```

**风险**：如果 SDK 不支持跨 provider model 混用，需要改为每个 provider 单独创建 Models 实例。这会增加复杂度但不影响整体架构。

### P0-2: modelAlias 无校验，错误不可恢复

**问题**：大獭调用 `create_otter` 时可以传任意字符串作为 modelAlias。如果 alias 不存在，会静默写入 DB，之后每次 invoke 都会解析失败。

**修复**：双重校验

```typescript
// tool-factory.ts createCreateOtterTool.execute() 中
if (params.modelAlias && !modelPool.hasModel(params.modelAlias as string)) {
  const available = modelPool.describeModels().map(m => m.alias).join(", ");
  return textResponse(`[错误] 未知的模型别名「${params.modelAlias}」。可用模型：${available}`);
}

// pi-session-factory.ts _createSessionWithTools() 中
if (modelAlias && !this.cfg.modelPool.hasModel(modelAlias)) {
  this.logger.error(`模型别名 ${modelAlias} 不存在，回退到默认模型`, { otterId });
  model = this.cfg.modelPool.getDefaultModel();
}
```

**ModelPool 接口补充**：`getModel()` 找不到 alias 时抛异常（fail-fast），`getDefaultModel()` 始终返回默认模型。

### P0-3: config 结构变更的连锁反应

**问题**：`AppConfig.llm` 结构变更影响所有引用 `appConfig.llm` 的代码。遗漏引用点会导致编译失败。

**完整引用点清单**：

| 文件 | 引用方式 | 改动 |
|------|---------|------|
| `config-service.ts` | `AppConfig.llm` 类型定义 + `validate()` + `applyDefaults()` | 重写为 models[] 结构 |
| `main.ts:450` | `syncApiKeyToAgentAuth(appConfig.llm)` | 遍历 models[] |
| `main.ts:463` | `initModels(appConfig.llm, logger)` | 传 AppConfig["llm"] |
| `pi-session-factory.ts:194` | `appConfig.llm.apiKey` + `appConfig.llm.provider` | 改为从 modelPool 获取 |
| `main.ts:489-494` | `settings.provider = appConfig.llm.provider` | 改为 defaultAlias |

### P1-1: reset 时 modelAlias 会丢失

**问题**：`_resetInternal()` 调用 `setConfig()` 时只传 `systemPrompt` 和 `otterType`，不传 `modelAlias`。

**文件**：`pi-session-factory.ts` 第 292-296 行

```typescript
// 当前
if (context?.systemPrompt) {
  const existingConfig = this.cfg.otterConfigProvider.getConfig(otterId);
  this.cfg.otterConfigProvider.setConfig(otterId, {
    systemPrompt: context.systemPrompt,
    otterType: existingConfig?.otterType ?? 'big',
    // ← modelAlias 丢失！
  });
}

// 修复：保留 modelAlias
if (context?.systemPrompt) {
  const existingConfig = this.cfg.otterConfigProvider.getConfig(otterId);
  this.cfg.otterConfigProvider.setConfig(otterId, {
    systemPrompt: context.systemPrompt,
    otterType: existingConfig?.otterType ?? 'big',
    modelAlias: existingConfig?.modelAlias,  // 保留
  });
}
```

### P1-2: invoke 日志缺少模型信息

**问题**：无法知道某个小獭用的是哪个模型，难以追踪和调试。

**修复**：在 `_createSessionWithTools()` 中增加日志：

```typescript
const resolvedModel = modelAlias && this.cfg.modelPool
  ? this.cfg.modelPool.getModel(modelAlias)
  : this.cfg.modelPool.getDefaultModel();

this.logger.info('模型解析', {
  otterId,
  requestedAlias: modelAlias ?? '(default)',
  resolvedAlias: modelAlias ?? this.cfg.modelPool.getDefaultAlias(),
  provider: (resolvedModel as any)?.provider,
});
```

### P1-3: 同 provider 多 key 不支持

**问题**：如果两个模型都用 openai provider 但不同的 apiBaseUrl/apiKey，`setRuntimeApiKey()` 只能设一个。

**修复**：Pi SDK 的 `loadCustomProvider()` 为每个模型创建独立的 provider 实例（含独立 auth），所以同 provider 不同 apiBaseUrl 的模型会注册为不同的 provider ID。实际上这个问题在 Pi SDK 层面已经解决——每个 `loadCustomProvider()` 调用都创建独立的 provider 实例。

但 `setRuntimeApiKey()` 按 provider ID 设置 key，同 provider 不同 key 的场景需要在 `createAgentSession()` 时通过 options 传入 apiKey（Pi SDK 支持 per-request apiKey）。这个作为后续增强，当前 MVF 不处理。

### P1-4: contextWindow 按默认模型读取

**问题**：`_buildInvokeResult()` 从 `this.cfg.model` 读 contextWindow，多模型时应该从当前 otter 的模型读。

**修复**：

```typescript
// pi-session-factory.ts _buildInvokeResult() 中
private _buildInvokeResult(otterId, session, circuitBreaker): AgentRunResult {
  // ... existing ...
  const otterConfig = this.cfg.otterConfigProvider.getConfig(otterId);
  const modelAlias = otterConfig?.modelAlias;
  const ctxMax = modelAlias
    ? this.cfg.modelPool?.getModel(modelAlias)?.contextWindow
    : this.cfg.modelPool?.getDefaultModel()?.contextWindow;
  return buildResult("", tokenUsage, circuitBreaker, ctxMax);
}
```

### 第二轮审视发现

#### P0-4: 同 provider 多 apiBaseUrl 的 provider ID 冲突

**问题**：`loadCustomProvider()` 用 provider 名称（如 `"openai"`）作为 `createProvider({ id: provider })` 的 ID。如果两个模型都是 "openai" provider 但不同 apiBaseUrl/apiKey，第二次 `createProvider` 会覆盖第一次注册的 provider。

**修复**：用 alias 作为 provider ID，而非 provider 名称：

```typescript
// models-factory.ts loadCustomProvider() 中
// 当前
return piAi.createProvider({
  id: provider,  // "openai" — 同 provider 会冲突
  ...
});

// 改为：用 alias 作为 provider ID
return piAi.createProvider({
  id: alias,  // "mimo-fast" — 每个模型独立
  ...
});
```

同时 `models.getModel(alias, modelId)` 的第一个参数也要改为 alias。

**注意**：此修复需要在 Phase 0 spike 测试中验证 `createProvider()` 支持自定义 ID。

#### P0-5: default alias 无启动时校验

**问题**：`config-service.ts` 的 `validate()` 不检查 `llm.default` 是否在 `llm.models[]` 中存在。配错 default 值时运行时才暴露。

**修复**：在 `validate()` 中增加校验：

```typescript
// config-service.ts validate() 中
if (raw.llm?.models && raw.llm.models.length > 0) {
  const aliases = raw.llm.models.map(m => m.alias);
  // 校验 alias 唯一性
  const duplicates = aliases.filter((a, i) => aliases.indexOf(a) !== i);
  if (duplicates.length > 0) {
    throw new Error(`配置校验失败: models[] 中存在重复的 alias: ${duplicates.join(", ")}`);
  }
  // 校验 default 有效性
  if (raw.llm.default && !aliases.includes(raw.llm.default)) {
    throw new Error(`配置校验失败: llm.default "${raw.llm.default}" 不在 models[] 中。可用 alias: ${aliases.join(", ")}`);
  }
  // 校验 models[] 非空
  if (raw.llm.models.length === 0) {
    throw new Error("配置校验失败: llm.models 为空数组，至少需要一个模型");
  }
}
```

#### 设计决策调整：modelAlias 传递方式

**原方案**：通过 `context: Record<string, unknown>` 透传 modelAlias。

**问题**：context 是无类型 bag，modelAlias 的存在性和类型无法在编译期保证。

**调整为**：扩展 `AgentConfig` 接口，直接加 `modelAlias` 字段：

```typescript
// agent-gateway.ts
interface AgentConfig {
  systemPrompt?: string | OtterPromptConfig;
  context?: Record<string, unknown>;
  modelAlias?: string;  // 直接加在接口上
}
```

好处：
- 类型安全，编译期可检查
- 只有一个实现者（PiSessionFactory），改动面极小
- 不需要从 context 中提取，代码更清晰

相应调整 `CreateOtter.execute()` 中的调用：

```typescript
await this.agentGateway.create(id, {
  systemPrompt: params.systemPrompt,
  context: { ...params.context, otterType: params.type },
  modelAlias: params.modelAlias,  // 直接传，不放 context
});
```

#### OtterConfig 链路完整性确认

`SessionRestore.createSessionAndPersist()` 内部的 `setConfig()` 调用（第 159-165 行）需要同步增加 modelAlias：

```typescript
// session-restore.ts createSessionAndPersist() 事务内
this.otterConfigProvider.setConfig(otterId, {
  systemPrompt: config.systemPrompt,
  otterType: config.otterType as OtterType,
  modelAlias: config.modelAlias,  // 新增
});
```

此改动在第一轮 8.1 节已覆盖，此处确认完整性。

### 第三轮审视发现

#### P0-6: model.provider 字段与 provider.id 不一致（F2 断点）

**问题**：P0-4 修复要求用 alias 作为 `createProvider({ id: alias })` 的 provider ID。但 `loadCustomProvider()` 推入模型数组时，model.provider 字段仍是模板的原始值（如 "openai"）。pi-coding-agent SDK 的 `createAgentSession()` 用 `model.provider` 字段去 ModelRuntime 查找 auth。如果 model.provider 是 "openai" 但 auth 设置在 alias "mimo-fast" 上，auth 解析会失败。

**修复**：`loadCustomProvider()` 中推入自定义模型时，`provider` 字段必须改为 alias：

```typescript
// models-factory.ts loadCustomProvider() 中，推入自定义模型时
if (!hasModel) {
  const template = modelsArray[0] as Record<string, unknown> | undefined;
  if (template) {
    modelsArray.push({
      id: modelId,
      name: modelId,
      api: template.api,
      provider: alias,  // ← 用 alias 而非 template.provider
      baseUrl: apiBaseUrl ?? template.baseUrl,
      reasoning: template.reasoning,
      compat: template.compat,
      thinkingLevelMap: template.thinkingLevelMap,
      input: template.input,
      cost: (template as Record<string, unknown>).cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  }
}
```

**关键**：`loadProvider()` 签名需要增加 `alias` 参数：
```typescript
async function loadProvider(provider: string, modelId: string, alias: string, llmConfig?: AppConfig["llm"]): Promise<unknown>
```

#### P0-7: modelPool 注入到工具层的机制（F4 断点）

**问题**：`createCreateOtterTool.execute()` 中需要调用 `modelPool.hasModel()` 进行校验，但 `ToolContext` 接口当前只有 `{ client, otterId, conversationId, currentMessageId }`，不含 modelPool。

**修复方案**：通过闭包注入，不改 ToolContext。`createTools` 工厂函数在 `main.ts` 中创建时，modelPool 已可用，直接闭包捕获：

```typescript
// main.ts 中
const createToolsWithModelPool = (ctx: ToolContext) => {
  return createTools(ctx, modelPool);  // modelPool 通过参数传入
};

// tool-factory.ts 中
export function createTools(ctx: ToolContext, modelPool?: ModelPool): AgentTool[] {
  // ...
  return [
    // ...
    createCreateOtterTool(ctx, modelPool),
    // ...
  ];
}

function createCreateOtterTool(ctx: ToolContext, modelPool?: ModelPool): AgentTool {
  return {
    // ...
    execute: async (_id, params) => {
      if (params.modelAlias && modelPool && !modelPool.hasModel(params.modelAlias as string)) {
        const available = modelPool.describeModels().map(m => m.alias).join(", ");
        return textResponse(`[错误] 未知的模型别名「${params.modelAlias}」。可用模型：${available}`);
      }
      // ...
    },
  };
}
```

**接口变更**：`createTools` 签名从 `(ctx: ToolContext) => AgentTool[]` 改为 `(ctx: ToolContext, modelPool?: ModelPool) => AgentTool[]`。

相应 `AgentSessionFactoryConfig.createTools` 签名也需要更新。

#### 遗漏 1: 旧 config.yaml 迁移提示（F1）

**问题**：现有 config.yaml 使用 `llm.provider` + `llm.model` 单模型格式。改为 `llm.models[]` 后，旧格式直接报错，用户不知道怎么改。

**修复**：在 `validate()` 中检测旧格式并给出明确提示：

```typescript
// config-service.ts validate() 中
if (raw.llm?.provider && raw.llm?.model && !raw.llm?.models) {
  throw new Error(
    "配置格式已更新：请将 llm.provider + llm.model 迁移到 llm.models[] 格式。\n" +
    "示例：\nllm:\n  default: \"my-model\"\n  models:\n    - alias: \"my-model\"\n      provider: \"openai\"\n      model: \"gpt-4o\"\n      apiKey: \"sk-...\""
  );
}
```

#### 遗漏 2: prompt 注入格式定义（F3）

**问题**：模型描述注入 prompt 的格式未精确定义。

**修复**：在 `buildModelSelectionGuidance()` 中明确格式：

```typescript
private buildModelSelectionGuidance(): string {
  if (!this.cfg.modelPool) return "";
  const models = this.cfg.modelPool.describeModels();
  if (models.length <= 1) return "";

  const lines = models.map(m => {
    const strengths = m.strengths?.length ? `优势: ${m.strengths.join("、")}` : "";
    const weaknesses = m.weaknesses?.length ? `劣势: ${m.weaknesses.join("、")}` : "";
    const details = [strengths, weaknesses].filter(Boolean).join("；");
    return `- **${m.alias}**：${m.description ?? "无描述"}${details ? `\n  ${details}` : ""}`;
  });

  return [
    "",
    "## 可用模型",
    "",
    ...lines,
    "",
    "创建小獭时可通过 `modelAlias` 参数选择模型。不指定则使用默认模型。",
    "只在任务有明确的模型适配需求时才选择，大多数情况下默认模型即可。",
  ].join("\n");
}
```

#### 遗漏 3: LLM request 日志增加模型信息（F9）

**问题**：`_executeWithSession()` 中的 LLM request 日志不包含模型信息。

**修复**：

```typescript
// pi-session-factory.ts _executeWithSession() 中
const otterConfig = this.cfg.otterConfigProvider.getConfig(otterId);
const modelAlias = otterConfig?.modelAlias;
const resolvedAlias = modelAlias ?? this.cfg.modelPool?.getDefaultAlias() ?? 'unknown';

this.logger.info('LLM request', {
  otterId,
  conversationId: options?.conversationId,
  modelAlias: resolvedAlias,
  messageLength: fullMessage.length,
  messagePreview: fullMessage.substring(0, 300),
});
```

#### 遗漏 4: syncApiKeyToAgentAuth 完整改动（F11）

**修复**：

```typescript
// main.ts
function syncApiKeyToAgentAuth(llmConfig: AppConfig["llm"]): void {
  if (!llmConfig.models || llmConfig.models.length === 0) return;

  const homeDir = os.homedir();
  const agentDir = path.join(homeDir, ".pi", "agent");
  const authPath = path.join(agentDir, "auth.json");
  let auth: Record<string, string> = {};
  try {
    auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
  } catch { /* 文件不存在或格式错误 */ }

  let changed = false;
  for (const mc of llmConfig.models) {
    if (!mc.apiKey) continue;
    const key = mc.provider;  // 按 provider 去重，同 provider 用同一个 key
    if (auth[key] !== mc.apiKey) {
      auth[key] = mc.apiKey;
      changed = true;
    }
  }

  if (changed) {
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
    logger.info(`Synced API keys to ${authPath}`);
  }
}
```

#### 遗漏 5: settings 接口适配（F12）

**问题**：`SettingsConfig` 当前有 `provider` 和 `model` 字段，多模型后如何适配？

**修复**：改为显示 default 模型信息：

```typescript
// main.ts 中
const settings: SettingsConfig = {
  provider: appConfig.llm.default ?? 'multiple',  // 显示 default alias
  model: modelPool.getDefaultAlias(),              // 显示 default 模型
  port: appConfig.server.port,
  dbPath: appConfig.db.path,
  embeddingModelPath: appConfig.embedding.modelPath,
  embeddingDim: appConfig.embedding.dimensions,
};
```

#### 消除 P1-3 尾巴

原方案标记"同 provider 多 key 不支持"为"后续增强"。P0-6 修复后（alias 作为 provider ID + model.provider 改为 alias），每个模型有独立的 provider ID 和 auth，P1-3 问题自然消除。无需额外处理。
