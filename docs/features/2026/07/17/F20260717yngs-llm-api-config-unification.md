# F20260717yngs - 配置系统迁移至 config.yaml + LLM API 配置统一

## 元信息

| 字段 | 值 |
|------|-----|
| 特性编号 | F20260717yngs |
| 创建时间 | 2026-07-17 |
| 状态 | 实现完成 |
| 变更类型 | feature + incompatible |

## 概述

将配置系统从 `.env` + `process.env` 迁移到 `config.yaml` + 独立配置读取模块。同时将 LLM API URL 和 API Key 纳入统一配置体系，支持自定义 API 端点（代理、私有部署），API Key 作为配置项统一管理。

## 用户意图锚

| ID | 用户原话 | 来源 | 关键修饰语 | 架构师解读 |
|----|----------|------|------------|------------|
| UA-1 | "为什么我看.env.example中没有api url？" | 消息 #1 | .env.example、没有、api url | 用户期望在配置中看到 API URL 配置项 |
| UA-2 | "那不行，我不一定是用这两个api url" | 消息 #2 | 不一定、两个 | 用户使用非标准 API 端点（代理或私有部署），不局限于 OpenAI/Anthropic 官方 URL |
| UA-3 | "必须把这个配置也作为配置" | 消息 #2 | 必须、作为配置 | API URL 必须成为可配置项，不是硬编码 |
| UA-4 | "api key也作为配置项，不要让我又去填环境变量" | 消息 #2 | 也、作为配置项、不要、又去填环境变量 | API Key 必须作为配置项统一管理，不要求用户额外设置环境变量 |
| UA-5 | "为什么不能用经典代码仓的config.yaml这种" | 消息 #5 | 经典、config.yaml | 用户期望使用结构化配置文件，而非扁平的环境变量 |
| UA-6 | "我更倾向于有一个独立的配置项读取模块，然后供所有的业务模块使用" | 消息 #5 | 独立的、配置项读取模块、供所有业务模块使用 | 用户期望统一的配置读取入口，所有模块通过同一接口获取配置 |
| UA-7 | "代码仓只保留一份example，然后本地自行看护一份真正的配置文件不就行了" | 消息 #7 | example、本地、真正的配置文件 | 用户确认 example + 本地配置文件的模式，与 .env.example 同理 |

## 行为条目

| ID | 行为 | 预期 | 来源 |
|----|------|------|------|
| B-1 | 配置文件迁移 | 所有配置从 `.env` + `process.env` 迁移到 `config/config.yaml` | ← UA-5, UA-6 |
| B-2 | 配置模板 | 代码仓库保留 `config/config.yaml.example` 作为配置模板，`config.yaml` 加入 `.gitignore` | ← UA-7 |
| B-3 | 独立配置读取模块 | 新增 `config-service.ts`，导出与现有 `config` 同构的不可变对象，消费者代码不变 | ← UA-6 |
| B-4 | API Base URL 可配置 | `config.yaml` 的 `llm.apiBaseUrl` 字段可覆盖默认 API 端点 | ← UA-1, UA-2, UA-3 |
| B-5 | API Key 统一配置 | `config.yaml` 的 `llm.apiKey` 字段作为 API Key 来源 | ← UA-4 |
| B-6 | 自定义 Provider 构造 | 当配置了 `apiBaseUrl` 或 `apiKey` 时，使用 `createProvider()` 构造自定义 provider，复用 pi-ai 内置模型列表和 API handler | ← UA-2, UA-3 |
| B-7 | 默认行为不变 | 未配置 `apiBaseUrl` 和 `apiKey` 时，使用 pi-ai 默认的 provider 工厂 | ← UA-4 |
| B-8 | 启动校验 | 配置文件缺失或必填字段未配置时，启动阶段给出明确错误提示 | ← UA-6 |
| B-9 | 配置校验 | 解析 YAML 后进行必填字段、类型、枚举值校验，校验失败启动报错 | ← UA-6 |

## 设计方案

### 核心概念

**配置架构**：

```
config/
├── config.yaml.example   # 配置模板（提交到代码仓库）
└── config.yaml           # 实际配置（.gitignore）

src/frameworks/
└── config-service.ts     # 统一配置读取模块（新增）
```

**自定义 Provider 触发条件**：

当 `llm.apiBaseUrl` 或 `llm.apiKey` 任一配置时，使用 `createProvider()` 构造自定义 provider，替代默认的 `openaiProvider()` / `anthropicProvider()`。

### 架构变更

#### 1. 配置结构：config.yaml

```yaml
# === 服务配置 ===
server:
  port: 3000

# === 数据库配置 ===
database:
  path: ./otter-buddy.db
  walMode: true
  foreignKeys: true

# === LLM 配置 ===
llm:
  provider: openai          # openai / anthropic
  model: gpt-4o
  apiKey: sk-...            # LLM API Key
  apiBaseUrl:               # 可选，用于代理或私有部署

# === 记忆系统配置 ===
memory:
  rrfK: 60
  weightHalfLifeDays: 7
  userFlagMultiplier: 2.0
  frequencyBoostFactor: 0.1

# === Embedding 配置 ===
embedding:
  dimensions: 1024
  modelPath: Xenova/bge-m3

# === 熔断器配置 ===
circuitBreaker:
  maxToolCalls: 40
  maxConsecutiveIdentical: 5
  maxExecutionTimeMs: 300000
  warningThreshold: 20
  slidingWindowSize: 6
  slidingWindowRepeat: 3
  steerTimeoutMs: 30000
  tokenWarningThreshold: 50000
```

#### 2. 配置读取模块：config-service.ts

**职责**：
- 启动时读取 `config/config.yaml`
- 使用 `js-yaml` 解析
- 进行配置校验（必填字段、类型、枚举值）
- 导出与现有 `config.ts` 同结构的不可变对象

**接口**：
```
export const config: AppConfig  // 不可变配置对象，结构与现有 config.ts 一致
```

**消费者代码不变**：`import { config } from "@frameworks/config"` 路径不变（config-service.ts 替代 config.ts 的导出位置）。

**配置校验规则**：
- 必填字段：`llm.provider`、`llm.model`
- 类型检查：`server.port` 必须是数字
- 枚举值：`llm.provider` 只能是 `openai` / `anthropic`
- 校验失败：启动报错，给出明确提示

#### 3. Provider 工厂：models-factory.ts 重构

**loadProvider 函数变更**：

```
原逻辑：switch(provider) → openaiProvider() / anthropicProvider()

新逻辑：
  判断是否需要自定义 provider（apiBaseUrl 或 apiKey 任一配置）
    → 是：调用 loadCustomProvider(provider, apiBaseUrl, apiKey)
    → 否：调用默认 provider 工厂（行为不变）
```

**新增 loadCustomProvider 函数**：

```
loadCustomProvider(provider, apiBaseUrl?, apiKey?):
  1. 动态导入 provider 对应的模型列表模块
     - openai: OPENAI_MODELS from "pi-ai/providers/openai.models"
     - anthropic: ANTHROPIC_MODELS from "pi-ai/providers/anthropic.models"
  2. 动态导入 provider 对应的 API handler 模块
     - openai: openAIResponsesApi from "pi-ai/api/openai-responses.lazy"
     - anthropic: anthropicMessagesApi from "pi-ai/api/anthropic-messages.lazy"
  3. 构造自定义 auth（见下方 API Key 解析逻辑）
  4. 调用 createProvider({ id, baseUrl, auth, models, api })
```

**自定义 API Key 解析逻辑**：

```
createCustomApiKeyAuth(configApiKey?, provider):
  resolve({ ctx, credential }):
    1. configApiKey 存在 → 返回 { apiKey: configApiKey, source: "config.yaml" }
    2. credential.key 存在 → 返回 { apiKey: credential.key, source: "stored credential" }
    3. 遍历标准环境变量（OPENAI_API_KEY / ANTHROPIC_API_KEY）
       → 返回 { apiKey: value, source: envVar }
    4. 均未找到 → 返回 undefined
```

**兼容性说明**：

- 当前版本仅支持 OpenAI 兼容 API 的自定义 base URL
- Anthropic 兼容 API 的自定义 base URL 需后续验证 `anthropic-messages` handler 的兼容性

### 修改范围

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `config/config.yaml.example` | 新增 | 配置模板，包含所有配置项及注释 |
| `src/frameworks/config-service.ts` | 新增 | 统一配置读取模块（YAML 解析 + 校验 + 导出） |
| `src/frameworks/config.ts` | 删除 | 被 config-service.ts 替代 |
| `src/frameworks/llm/models-factory.ts` | 修改 | 使用 config-service 获取配置；新增 loadCustomProvider 和 createCustomApiKeyAuth |
| `src/main.ts` | 修改 | 使用 config-service 获取配置 |
| `src/frameworks/agent/pi-session-factory.ts` | 修改 | 使用 config-service 获取配置 |
| `.env.example` | 删除 | 被 config.yaml.example 替代 |
| `.gitignore` | 修改 | 添加 `config/config.yaml` |
| `README.md` | 修改 | 添加迁移指南（从 .env 到 config.yaml） |

### 依赖变更

- 新增 `js-yaml`（YAML 解析库）
- 新增 `@types/js-yaml`（类型定义）

### 不兼容更新

- **配置来源变更**：所有配置从 `.env` + `process.env` 迁移到 `config/config.yaml`
- **环境变量移除**：删除所有 `process.env` 读取（12 个环境变量）
- **文件删除**：`.env.example` 被 `config/config.yaml.example` 替代
- **迁移要求**：已有用户需将 `.env` 中的配置迁移到 `config/config.yaml`

### 测试计划

1. **配置读取测试**
   - config-service 正确读取并解析 config.yaml
   - 配置对象结构与现有 config.ts 一致
   - 缺失配置文件时启动报错

2. **配置校验测试**
   - 必填字段缺失时报错
   - 类型错误时报错
   - 枚举值无效时报错

3. **默认行为测试**
   - 未配置 apiBaseUrl 和 apiKey 时，使用 pi-ai 默认 provider 工厂
   - 行为与迁移前完全一致

4. **自定义 API Key 测试**
   - config.yaml 中设置 apiKey，验证生效
   - 未设置 apiKey 时，回退到标准环境变量
   - 所有来源均未设置时，启动报错

5. **自定义 API Base URL 测试**
   - config.yaml 中设置 apiBaseUrl，验证请求发往自定义端点
   - 未设置时，使用默认官方端点

6. **组合场景测试**
   - apiBaseUrl + apiKey 同时配置
   - apiBaseUrl 配置但 apiKey 未配置（回退到标准环境变量）
   - apiKey 配置但 apiBaseUrl 未配置（仅覆盖 key，URL 不变）

### 设计决策

#### 决策 1：配置系统从 .env 迁移到 config.yaml

**决策**：将整个配置系统从 `.env` + `process.env` 迁移到 `config.yaml`。

**正方论点**：用户明确要求"独立的配置读取模块"和"config.yaml"。YAML 支持嵌套结构、原生类型，比扁平的环境变量更适合结构化配置。统一配置入口符合用户"供所有业务模块使用"的诉求。

**反方论点**：这是不兼容变更，已有使用环境变量的部署方式需要迁移。引入 `js-yaml` 新依赖。

**最终决策**：采用 config.yaml。用户明确确认"不需要环境变量覆盖"，接受一次性迁移成本。

#### 决策 2：使用 createProvider 自定义 vs 修改 provider 工厂函数签名

**决策**：使用 `createProvider()` 直接构造自定义 provider。

**正方论点**：pi-ai 的 `openaiProvider()` / `anthropicProvider()` 是零参数函数，内部硬编码 baseUrl 和 envApiKeyAuth 逻辑。无法通过传参修改其行为。`createProvider()` 是 pi-ai 的公开 API，支持自定义 baseUrl 和 auth。

**反方论点**：依赖 pi-ai 内部模块路径（`*.models.js`、`*.lazy.js`），非公开导出，存在版本升级后路径变更的风险。

**最终决策**：采用 `createProvider()` 方案。内部模块路径虽然非公开导出，但 pi-ai 的模块结构稳定，且 Otter Buddy 已通过动态 import 依赖 pi-ai 的 provider 模块。

#### 决策 3：自定义 provider 触发条件

**决策**：`apiBaseUrl` 或 `apiKey` 任一配置即触发自定义 provider 构造。

**正方论点**：覆盖所有场景——只改 URL（代理场景）、只改 Key（统一管理）、两者都改。

**反方论点**：仅配置 apiKey 时也需要走自定义 provider 路径，增加了代码复杂度。

**最终决策**：任一触发。因为自定义 auth resolver 需要通过 `createProvider()` 实现，无法通过默认 provider 工厂实现。

#### 决策 4：常量配置是否迁移

**决策**：将 memory（4 个）和 embedding（2 个）的硬编码常量也迁移到 config.yaml。

**正方论点**：统一配置入口是用户核心诉求。常量也需要在不改代码的情况下调整（如 embedding dimensions）。config.yaml.example 中可标注"一般无需修改"。

**反方论点**：这些值从未作为环境变量暴露，迁移增加配置文件复杂度。

**最终决策**：迁移。保持配置完整性，所有可调参数统一入口。
