---
id: F20260804rtpr
title: runtime-provider-registration
doc_type: feature

summary: |
  修复多模型自定义 alias（mimo/kimi）报 "No API key found for <alias>" 导致 agent 完全不可用的缺陷。
  根因：pi-coding-agent 0.81 的 AgentSession 鉴权走 ModelRuntime 内部 provider 注册表，而 models-factory 只把自定义 provider 注册到 app 自建的 models 对象，runtime 注册表查不到 alias 直接返回 undefined。
  修法：启动时对每个自定义 alias 调 modelRuntime.registerProvider() 把 provider 注册进运行时注册表。

causal_links:
  from:
    - F20260731mmrk   # 多模型路由：引入 alias 作为 provider id 的方案，但只覆盖了 app 侧注册表
  to: []

status: implemented
change_type: fix
tags: [llm, multi-model, pi-sdk, auth, model-runtime]
modules:
  - src/frameworks/agent/pi-session-factory.ts
  - src/frameworks/llm/model-pool.ts
  - tests/frameworks/llm/model-pool.test.ts
---

# F20260804rtpr: 自定义模型 alias 注册进 ModelRuntime provider 注册表

## 背景

config.yaml 把多模型 alias 从 `anthropic` 改为 `mimo`/`kimi` 后，所有 agent 调用立即失败：

```
No API key found for mimo.
Use /login to log into a provider via OAuth or API key. ...
```

诡异之处：启动日志显示 `Set runtime API key for alias=mimo` 已成功执行，key 明明注入了，请求却报找不到 key。

## 根因分析

### 表层：鉴权短路

pi-coding-agent 0.81 的 `AgentSession._getRequiredRequestAuth()`（agent-session.js:165）调 `modelRuntime.getAuth(model)`；pi-ai 的 `getAuth`（pi-ai/dist/models.js:194）第一步是 `this.providers.get(providerId)`，**provider 不存在就直接返回 undefined**，根本走不到 credentials 查询。AgentSession 拿到 undefined 后抛 `formatNoApiKeyFoundMessage(model.provider)`。

### 深层：两个互不知情的 provider 注册表

系统里存在两个 models 注册表：

1. **app 自建**：`models-factory.ts` 用 `piAi.createModels()` 创建，`loadCustomProvider()` 以 alias 为 provider id 调 `createProvider()` 注册进去（models-factory.ts:114-120）。模型解析（`models.getModel(alias, modelId)`）走这里，所以启动初始化正常。
2. **SDK ModelRuntime 内部**：`ModelRuntime.create()` 自建 `createModels({ credentials, modelsStore })`（model-runtime.js:54），provider 只来自三个源：内置 provider 目录、`~/.pi/agent/models.json`、extension 的 `registerProvider()`。

`pi-session-factory.ensurePiCodingAgent()` 只做了 `setRuntimeApiKey(alias, key)`——key 确实进了 credentials，但 runtime 注册表里没有 `mimo` 这个 provider，`getAuth` 在第一步就短路了。

### 为什么以前能跑

旧配置 alias 就叫 `anthropic`，**撞上了内置 provider id**，runtime 注册表天然认识它，配合 runtime key 恰好能解析。换成 `mimo`/`kimi` 后巧合失效。这是 F20260731mmrk 多模型路由的遗留盲点：当时只用 `alias=anthropic` 验证过，自定义 alias 路径从未真正跑通。

## 修复方案

`pi-session-factory.ts` 新增 `_registerRuntimeModel(alias, config, model)`，在 `ensurePiCodingAgent()` 的多模型分支里对每个 entry 调用：

1. **注册 provider**：alias ≠ 内置 provider 名时，调 `modelRuntime.registerProvider(alias, { baseUrl, apiKey, api, models })`，把自定义 provider 注册进 runtime 注册表（SDK 文档 custom-provider.md 的 extension 注册口）。`api` 按 config.provider 映射：`anthropic` → `anthropic-messages`，`openai` → `openai-responses`（与 models-factory 的 API handler 选择保持一致）。模型元数据（reasoning/input/cost/compat 等）从 pool 里已解析的 model 对象提取。
2. **注入 key**：`setRuntimeApiKey(alias, key)`（原有逻辑不变）。

alias 与内置 provider 同名时跳过注册——内置 provider 本来就在注册表中，重复注册会用单模型列表覆盖内置模型全集，反而引入回归。

配套改动：`ModelPool.getAllEntries()` 返回值增加 `model` 字段（注册需要模型元数据），唯一调用方就是 ensurePiCodingAgent。

## 验证

- `npx tsc` + eslint 通过；`tests/frameworks/` 22 文件 326 测试全过（含更新的 model-pool 测试）
- 主目录构建 dist 并重启服务后，日志确认：
  - `Registered runtime provider for alias=mimo` / `alias=kimi`
  - `Set runtime API key for alias=mimo` / `alias=kimi`
- 实际对话调用不再报 `No API key found`

## 已知边界

- 单模型模式（无 `models[]`）不注册：provider id 即内置 id（anthropic/openai），runtime 天然认识，行为不变。
- 注册进 runtime 的模型列表只有 pool 里那一个模型；SDK 交互式 `/model` 列表不代表完整可用集，但本系统不走交互式模型选择，无影响。
