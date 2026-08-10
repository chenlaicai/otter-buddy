---
id: R20260810piab
title: pi-coding-agent-sdk-usage-audit
doc_type: research
summary: |
  审查 otter-buddy 对 @earendil-works/pi-coding-agent@0.83.0 SDK 的使用质量。
  发现 3 个严重问题（system prompt 注入方式错误、AgentSession 每次 invoke 重建、类型安全绕过）、
  3 个中等问题（工具 execute 签名截断、双层重试冲突、依赖未文档化行为）、若干未用能力。
  核心根因：集成时误以为 SDK 无公开 system prompt setter，实际有两条正规路径未使用。

status: draft
exploration_type: audit
tags: [agent, pi-sdk, integration-quality]
modules:
  - src/frameworks/agent/pi-session-factory.ts
  - src/frameworks/agent/session-helpers.ts
  - src/frameworks/agent/session-restore.ts
  - src/frameworks/agent/circuit-breaker-helpers.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
---

# R20260810piab: Pi Coding Agent SDK 使用审计

## 背景

otter-buddy 的 Agent 运行时建立在 `@earendil-works/pi-coding-agent@0.83.0`（Mario Zechner / earendil-works 开发的独立 Coding Agent SDK，非 Anthropic 官方 `claude-agent-sdk`）之上。本文档对该 SDK 的集成质量做严格审查：接口是否用对、能力是否发挥、是否最优。

**审计范围**：SDK 调用链全路径（session 工厂、session 恢复、工具注册、事件订阅、中断重试、model runtime）。
**审计方法**：读 SDK `dist/*.d.ts` 导出的真实 API 定义，对比实际调用代码。

## SDK 集成概览

### 依赖

| 包 | 版本 | 角色 |
|----|------|------|
| `@earendil-works/pi-coding-agent` | 0.83.0 | Agent 运行时、session 管理、工具系统、extension API |
| `@earendil-works/pi-ai` | 0.83.0 | LLM provider 路由、模型管理 |
| `@earendil-works/pi-agent-core` | 0.83.0（传递依赖） | Agent 核心抽象（Agent、AgentMessage、AgentState） |

### 架构分层

```
AgentGateway (usecases/otter)
    ↓ implements
PiSessionFactory (frameworks/agent/pi-session-factory.ts, 868 行)
    ↓ 直接调用
createAgentSession / session.prompt / session.subscribe / session.abort / session.steer / session.dispose
    ↓
@earendil-works/pi-coding-agent SDK
    ↓
@earendil-works/pi-ai → @anthropic-ai/sdk
```

### 已用到的 SDK 能力

- `createAgentSession`（核心入口）
- `SessionManager.create / open`（session 持久化）
- `parentSession`（session 链血缘元数据）
- `session.prompt / subscribe / abort / steer / dispose`
- `session.state.errorMessage`（API 错误检测）
- `session.isCompacting`（OutputGuard 兜底查询）
- `session.getSessionStats / getSessionId / getSessionFile`
- `sessionManager.getBranch()`（context token 计算）
- `ModelRuntime.create / setRuntimeApiKey / registerProvider`
- `DefaultResourceLoader`（skill 发现 + extension 注册）
- Extension API `pi.on("context", ...)`（thinking-strip）
- `calculateContextTokens / getLastAssistantUsage / getLatestCompactionEntry`（context 窗口计算）

---

## 发现的问题

### 🔴 S1：System Prompt 被当作 user message 前缀注入——注释理由是错的

#### 现状

`pi-session-factory.ts:9` 头注释 + `session-helpers.ts:143-144`：
```
系统提示作为消息前缀注入（SDK 的 _systemPromptOverride 为 private，无公开 setter）
```

`buildUserMessagePrefix()`（`pi-session-factory.ts:538-550`）在**每次 invoke** 都把 `otterPrompt`（含 systemPrompt + reminders）拼到用户消息前面：

```typescript
private async buildUserMessagePrefix(otterId, otterType, otterPromptConfig, isFirstInvoke) {
  const otterPrompt = buildOtterPrompt(otterPromptConfig);
  if (!isFirstInvoke) return otterPrompt;  // ← 非 first invoke 仍然返回 otterPrompt！
  const identityPrefix = await this.buildIdentityPrefix(otterId, otterType);
  return [identityPrefix, otterPrompt].filter(Boolean).join("\n\n");
}
```

然后在 `_executeWithSession`：
```typescript
const fullMessage = buildMessageWithContext(
  await this.buildUserMessagePrefix(...),  // ← system prompt 内容
  message,                                  // ← 真正的用户消息
  options?.dynamicContext,
);
await session.prompt(fullMessage);  // 全部作为一条 user message 发给 LLM
```

#### 后果

1. **上下文 token 虚耗**：otterPrompt（systemPrompt + reminders）每轮重复进入 user message，累积膨胀上下文
2. **角色语义混乱**：system 指令出现在 user role 里，LLM 可能将其视为用户输入而非系统指令
3. **与 SDK compaction 机制冲突**：SDK 的 compaction 算法对 system/user 消息有不同权重，user-role 的 system prompt 会被当作普通对话历史压缩

#### 注释理由是错的

注释声称 "SDK 的 `_systemPromptOverride` 为 private，无公开 setter"。事实是 `_systemPromptOverride` 在 `AgentSession` 上确实 private，但 SDK 提供了**三条正规路径**注入 system prompt：

| 路径 | 位置 | 适用场景 |
|------|------|----------|
| `DefaultResourceLoader({ systemPrompt })` | `resource-loader.d.ts:82` | 全局静态 system prompt（替换默认） |
| `DefaultResourceLoader({ appendSystemPrompt: string[] })` | `resource-loader.d.ts:83` | 追加到默认 system prompt 后 |
| `DefaultResourceLoader({ systemPromptOverride: (base) => string })` | `resource-loader.d.ts:117` | 动态覆盖 |
| Extension `beforeAgentStart` 事件返回 `{ systemPrompt }` | `agent-session.js:882-900` | **per-turn 动态覆盖** |

SDK 源码证据（`agent-session.js:882-900`）：
```js
const result = await this._extensionRunner.emitBeforeAgentStart(
  expandedText, currentImages, this._baseSystemPrompt, this._baseSystemPromptOptions
);
if (result?.systemPrompt !== undefined) {
    this._systemPromptOverride = result.systemPrompt;
    this.agent.state.systemPrompt = result.systemPrompt;
}
```

`beforeAgentStart` 是 extension 事件，每次 prompt 前触发，返回值可以包含 `systemPrompt` 字段覆盖当轮 system prompt。这正是 otter-buddy 需要的 per-otter、per-turn 动态注入点。

#### 初步设计方案

**方案 A（推荐）**：用 extension `beforeAgentStart` 事件注入

现有 `thinking-strip` extension 骨架（`pi-session-factory.ts:272-281`）已注册在 `DefaultResourceLoader` 上，只需扩展同一个 extension factory：

```typescript
factory: (pi: any) => {
  // 现有：strip 历史 thinking
  pi.on("context", (event) => ({
    messages: stripHistoricalThinking(event.messages),
  }));
  // 新增：注入 per-otter system prompt
  pi.on("beforeAgentStart", (event) => ({
    systemPrompt: buildFullSystemPrompt(otterPromptConfig, identityContext),
  }));
}
```

**问题**：extension factory 在 `ensurePiCodingAgent()` 时创建（进程级单例），但 `otterPromptConfig` 是 per-otter、per-invoke 的。需要把当前 otter 的 prompt config 存到可访问的位置（例如 `activeSessions` Map 里），extension handler 从中读取。

**方案 B（备选）**：每次 invoke 创建新 ResourceLoader

`createAgentSession` 的 `resourceLoader` 参数可以传入不同实例。每次 invoke 创建带 per-otter `systemPrompt` 的 `DefaultResourceLoader`。代价：skill 重新发现（可接受，skill 列表稳定）。

**方案对比**：

| 维度 | 方案 A（extension） | 方案 B（per-otter ResourceLoader） |
|------|--------------------|------------------------------------|
| 改动范围 | 小（扩展现有 extension） | 中（session 创建流程改） |
| per-otter 隔离 | 需要额外状态传递 | 天然隔离 |
| 性能 | 无额外开销 | 每次重建 ResourceLoader |
| 语义清晰度 | beforeAgentStart 语义匹配 | ResourceLoader 本意是静态资源 |

---

### 🔴 S2：AgentSession 每次 invoke 重建 + dispose——R17 冷启动问题仍在

#### 现状

`_executeWithSession`（`pi-session-factory.ts:611-651`）：

```typescript
const { session, sessionKey } = await this._createSessionWithTools(...);  // 每次创建
// ...
try {
  await session.prompt(fullMessage);
  // ...
} finally {
  session.dispose();  // 每次销毁
}
```

每次 invoke：
- `createAgentSession` 全流程跑一遍（工具注册、extension 绑定、system prompt 重建、AgentSession 构造）
- 熔断器 / OutputGuard / 事件订阅器全部重新挂载
- session 完成后 dispose

记忆 `project_session_design_issue.md`（PR #79, R17）早在 19 天前就标记了这个问题，至今未修。

#### 后果

- 每次 invoke 的冷启动开销（createAgentSession 不是零成本）
- 工具闭包每次重建（当前设计需要——工具通过闭包绑定 messageId）
- extension 状态无法跨 invoke 维护

#### 为什么现在是这样

历史原因：工具通过闭包绑定 `messageId`（`buildCustomTools` 接收 messageId 参数），所以必须每次 invoke 重建工具，进而必须重建 session。

#### 初步设计方案

**关键洞察**：AgentSession 可以跨 invoke 复用。SessionManager 指向持久化文件，AgentSession 只是内存 wrapper。只要 SessionManager 不变，同一个 AgentSession 可以多次 `prompt()`。

**方案**：
1. **缓存 AgentSession**：按 otterId 缓存 AgentSession 实例，跨 invoke 复用
2. **工具 messageId 动态化**：不再用闭包绑定 messageId，改为从 ToolContext 动态读取（维护一个 `currentMessageId` 引用，invoke 时设置）
3. **dispose 时机后移**：只在 otter destroy / reset 时 dispose

**改动点**：
- `PiSessionFactory` 新增 `cachedSessions: Map<otterId, AgentSession>`
- `buildCustomTools` 改为接收 `() => string` getter 而非 `messageId` 字符串
- `_executeWithSession` 先查缓存，miss 时创建
- `destroy / _resetInternal` 时 dispose 缓存的 session

**风险**：
- AgentSession 跨 invoke 复用时，steer/followUp 队列是否有残留？（SDK 文档：`clearQueue()` 可清理）
- 多 otter 并发时，缓存的 AgentSession 数量 = 活跃 otter 数，需要确认内存可控

---

### 🔴 S3：`as never` / `as any` 绕过类型检查

#### 现状

`pi-session-factory.ts:707-714`：
```typescript
const { session } = await piCodingAgent.createAgentSession({
  model: resolvedModel as never,
  customTools: customTools as never,
  modelRuntime: this.modelRuntime as any,
});
```

#### 问题

理由 "pi-coding-agent 是 ESM-only，无法直接导入类型" **不成立**：
- SDK 的 `dist/index.d.ts` 导出了所有类型（`Model`、`ToolDefinition`、`ModelRuntime`）
- `import type` 是编译时擦除，不受 ESM-only 运行时约束

真正的原因可能是 `Model` 类型来自 `@earendil-works/pi-ai/compat`，而 `models-factory.ts` 构建的 model 对象字段不完全匹配 SDK 期望的类型签名。`as never` 掩盖了真实的类型不匹配。

#### 初步设计方案

1. 从 `@earendil-works/pi-ai/compat` 正确 import `Model` 类型
2. `models-factory.ts` 产出的对象对齐 `Model<ProviderConfig>` 类型
3. `customTools` 的 `execute` 签名补全（见 M1）
4. `modelRuntime` 直接用 SDK 导出的 `ModelRuntime` 类型

---

### 🟡 M1：自定义工具 execute 签名截断——丢失 abort / progress 能力

#### 现状

SDK `ToolDefinition.execute` 签名（`extensions/types.d.ts:371`）：
```typescript
execute(
  toolCallId: string,
  params: Static<TParams>,
  signal: AbortSignal | undefined,           // ← 中断信号
  onUpdate: AgentToolUpdateCallback | undefined,  // ← 进度回调
  ctx: ExtensionContext                       // ← 扩展上下文
): Promise<AgentToolResult<TDetails>>;
```

Otter 实现（`pi-session-factory.ts:840-843`）：
```typescript
execute: async (toolCallId, params) => {
  const result = await t.execute(toolCallId, params);
  return truncateToolResult(result);
}
```

只接收前 2 个参数，丢弃 `signal` / `onUpdate` / `ctx`。

#### 后果

- 用户 abort 时，Otter 工具无法响应中断（长耗时工具如 `workspace_*` 操作大文件会阻塞到自然结束）
- 无法向 UI 推送工具执行进度
- ~~返回类型是 truncated string，不是 `AgentToolResult`~~ **（对抗审视修正：误判）**——`truncateToolResult` 返回的是 `ToolResponse` 对象（`{ content, details, terminate? }`），与 SDK 的 `AgentToolResult<T>` 结构兼容。类型上可用 `as never` 绕过正是因为结构兼容

#### 初步设计方案

1. `AgentTool` 接口扩展：execute 签名加入可选的 `signal` 参数
2. `buildCustomTools` 适配器透传 `signal`
3. 长耗时工具（workspace_*）检查 `signal.aborted` 并提前返回

---

### 🟡 M2：双层重试可能冲突

#### 现状

- **SDK 内置**：`autoRetryEnabled` / `isRetrying` / `auto_retry_start|end` 事件，处理 transient API errors（429/overloaded）
- **Otter 自建**：`AgentInvoker`（788 行）的 `routeApiError()` / `handleAutoRetry()` 也处理 `LLM API error:` 开头的错误

OutputGuard 监听了 `auto_retry_start/end` 做 pause/resume。AgentInvoker 的 `_checkSessionError` 在 SDK 自动重试耗尽后才抛。

#### 分析

- 逻辑上没死锁：SDK 重试成功 → Otter 层不介入；SDK 重试失败 → Otter 层再重试一次
- 但**重复造轮子**：SDK 的 retry 已经有 backoff + maxAttempts 配置（`SettingsManager.retry`），Otter 层的重试逻辑与之平行存在
- 风险：如果两层都触发，实际重试次数 = SDK_max + Otter_max，可能放大 rate limit 问题

#### 初步设计方案

评估是否可以移除 Otter 层的 API error 重试，完全依赖 SDK 内置重试。保留 Otter 层的 guard_abort 重试（degenerate / no_speak），因为 SDK 不管这些。

---

### 🟡 M3：`_checkSessionError` 依赖未文档化的 `session.state.errorMessage`

#### 现状

`pi-session-factory.ts:654-659`：
```typescript
private _checkSessionError(session: { state: { errorMessage?: string } }, otterId) {
  const errorMessage = session.state.errorMessage;
  if (errorMessage) throw new Error(`LLM API error: ${errorMessage}`);
}
```

SDK `prompt()` 在某些 API 错误时不抛异常，而是把错误写到 `state.errorMessage`。**对抗审视修正**：该行为实际已在 `pi-agent-core/dist/types.d.ts:307` 文档化——`AgentState.errorMessage?: string`，注释为 "Error message from the most recent failed or aborted assistant turn, if any."。之前判断"未文档化"有误。

#### 风险

SDK 升级后可能改变此行为（例如改为始终抛异常），导致 `_checkSessionError` 静默失效。

#### 初步设计方案

- 升级 SDK 后验证此行为是否仍然存在
- 如果 SDK 新版本改为抛异常，移除 `_checkSessionError`
- 如果仍然 silent fail，考虑向 SDK 作者反馈文档化需求

---

### 🟢 未用能力清单

| SDK 能力 | 状态 | 备注 |
|----------|------|------|
| `thinkingLevel` | 未配置 | 默认 'medium'，mimo 等模型可调优 |
| `getContextUsage()` | 未用 | 自行用 `calculateContextTokens` 算（功能重复） |
| `beforeAgentStart` 事件 | 未用 | 应该用来注入 system prompt（见 S1） |
| `followUp()` | 未用 | 只有 `steer()` 被熔断器用 |
| `excludeTools` | 未用 | 只用 `tools` 白名单 |
| `sendCustomMessage` | 未用 | — |
| `ToolDefinition.promptSnippet` / `promptGuidelines` | 未用 | 可让自定义工具在 system prompt 里有使用提示 |
| `prepareArguments` | 未用 | 可做参数兼容/迁移 |
| Extension `context` 事件 handler | 用了 `any` | SDK 有 `ContextEvent` 类型可用 |

---

## 做得好的部分

- **Extension API 用对了**：`thinking-strip` extension 通过 `context` 事件 strip 历史 thinking，正规用法
- **`session.steer()` 用对了**：熔断器 steer 注入纠正提示，且正确排除了 `speak` 工具（speak 是回合出口，steer 有害）
- **`parentSession` 语义理解正确**：记忆 `system_pi_sdk_parent_session.md` 记录的"仅血缘元数据"结论在代码注释中正确体现
- **熔断器设计扎实**：per-toolCallId 计时器支持并行工具调用，梯度介入（warn→steer→terminate）
- **Session 持久化映射**：otter_id ↔ pi_session_id ↔ session_file 三表映射清晰

---

## 初步修复优先级（对抗审视后修订）

| 优先级 | 问题 | 投入产出比 | 改动范围 | 备注 |
|--------|------|-----------|----------|------|
| P0 | S1 System prompt 注入 | 最高 | AsyncLocalStorage + 全局 extension `before_agent_start` handler；移除 user-prefix | 方案已验证可行，与 S2 不冲突 |
| P1 | S3 类型安全 | 高 | models-factory + pi-session-factory | 跟随 S1，补全 execute 签名后类型自然对齐 |
| P1.5 | 遗漏 1：subscribe 事件类型弱化 | 高 | pi-session-factory + 下游消费方 | 架构师补充发现 |
| P2 | M1 工具 execute signal | 中 | AgentTool 接口 + 适配器 + workspace_* abort 检查点 | 跟随 S3 |
| P3 | S2 Session 复用（降级） | 中 | 工具定义模板复用，不做激进 session 复用 | 原激进方案与 S1 互斥 |
| P4 | M2 双层重试 | 中低 | 需先做用户体验评估 | — |
| P5 | M3 errorMessage 依赖 | 低 | 已确认是文档化 API，风险降级 | — |

---

## 对抗审视记录

**审视方**：独立架构师 agent（Plan 类型），对所有发现逐条交叉验证 SDK 源码 + 类型定义。
**报告整体可信度**：7.5/10——核心发现真实，方向正确；主要扣分在 S1/S2 方案互斥性未识别、M1/M3 有事实误判、遗漏 subscribe 事件类型弱化。

### 逐条审视结论

#### S1（system prompt 注入）—— ✅ 真实，但方案需改

**验证**：
- `pi-session-factory.ts:546` `if (!isFirstInvoke) return otterPrompt` 确实每轮返回 otterPrompt ✅
- `resource-loader.d.ts:82,83,117` 确认 `systemPrompt` / `appendSystemPrompt` / `systemPromptOverride` 三选项存在 ✅
- `agent-session.js:882-900` 确认 `beforeAgentStart` 返回的 `systemPrompt` 覆盖 `agent.state.systemPrompt` ✅
- `extensions/types.d.ts:800-804` 确认 `BeforeAgentStartEventResult.systemPrompt?: string`，注释 "Replace the system prompt for this turn" ✅

**原方案的问题**：
- 方案 A（extension `beforeAgentStart`）原描述"存到可访问位置"引入全局可变状态，多 otter 并发下有竞态风险
- 方案 B（per-invoke ResourceLoader）每次 `await reload()` 读文件系统，开销不可接受

**架构师初版方案（已被 SDK 深度探查推翻）**：

> ~~当前架构下每次 invoke 都新建 AgentSession，每次 `createAgentSession` 会创建新的 extension runner。因此 extension factory 闭包可以安全捕获当前 otter 的 prompt config。~~

**SDK 深度探查结论（推翻初版方案）**：

对 SDK 源码逐步追踪后发现初版方案对 extension 注册时机判断有误：

1. **factory 在 `resourceLoader.reload()` 时执行**（`loader.js:385-392` `loadExtensionFromFactory`），**不在 `createAgentSession` 调用栈内**。每次 invoke 新建 session 时，extension runner 是从 `resourceLoader.getExtensions()` 读**已 load 的 extension**（`agent-session.js:2031-2037` `_buildRuntime`）。factory 不会每次 invoke 重新执行。

2. **`DefaultResourceLoader.extensionFactories` 构造时固定**，无运行时变更 API。`extendResources()` 只加 skill/prompt/theme 路径，不加 extension。`extensionsOverride` 也是构造时传的回调。

3. **直接设 `session.agent.state.systemPrompt` 不行**——虽然 `AgentState.systemPrompt` 是可写字段（`pi-agent-core/types.d.ts:285`），但 prompt 流程（`agent-session.js:898-905`）在没 extension 处理 `beforeAgentStart` 时会执行 `this.agent.state.systemPrompt = this._baseSystemPrompt`，覆盖 otter 设的值。

4. **直接设 `(session as any)._systemPromptOverride` 也不行**——同一分支会执行 `_systemPromptOverride = undefined`，同样覆盖。

**结论：唯一不被覆盖的路径是 extension handler 在 `before_agent_start` 返回 `{ systemPrompt }`**。核心难题变成：全局单例 ResourceLoader 的 factory 在 reload 时注册 handler，handler 闭包固定，如何让它在 prompt 时读到 per-otter 数据？

**最终确定方案：AsyncLocalStorage + 全局 extension factory**

核心洞察：handler 在 `prompt()` 调用栈内执行（`emitBeforeAgentStart` → `await handler(event, ctx)`）。如果整个 `createAgentSession + prompt` 包在 `AsyncLocalStorage.run()` 内，handler 可以读到 store。

验证链：
- `pi-agent-core/types.d.ts:285` `AgentState.systemPrompt: string`（可写）✅
- `agent-session.js:898-900` `if (result?.systemPrompt !== undefined) { this.agent.state.systemPrompt = result.systemPrompt }` ✅
- `extensions/types.d.ts:800-804` `BeforeAgentStartEventResult.systemPrompt?: string` ✅
- `loader.js:389` `await factory(api)` 在 reload 时执行（注册 handler）✅
- `runner.js:847-856` `await handler(event, ctx)` 在 prompt 时执行 ✅
- Node.js AsyncLocalStorage 在 async 调用链自动传播 ✅

代码结构（最终方案）：

```typescript
// pi-session-factory.ts 顶部
import { AsyncLocalStorage } from 'node:async_hooks';

interface OtterInvokeContext {
  otterId: string;
  otterPromptConfig: string | OtterPromptConfig | undefined;
  identityPrefix: string;  // 首次 invoke 才有
  isFirstInvoke: boolean;
}
const otterInvokeStorage = new AsyncLocalStorage<OtterInvokeContext>();

// ensurePiCodingAgent 里，extensionFactories 不变（全局单例，reload 时 factory 注册一次 handler）
extensionFactories: [{
  name: "thinking-strip",
  hidden: true,
  factory: (pi: any) => {
    pi.on("context", (event: { messages: any[] }) => ({
      messages: stripHistoricalThinking(event.messages),
    }));
    // 新增：otter system prompt 注入——handler 在 prompt 时从 ALS 读上下文
    pi.on("before_agent_start", () => {
      const ctx = otterInvokeStorage.getStore();
      if (!ctx?.otterPromptConfig) return;
      return { systemPrompt: buildOtterSystemPrompt(ctx) };
    });
  },
}],

// _executeWithSession 里，整个 createAgentSession + prompt 包在 ALS scope 内
private async _executeWithSession(otterId, message, options, sessionManager, otterConfig) {
  const identityPrefix = options?.isFirstInvoke
    ? await this.buildIdentityPrefix(otterId, otterConfig.otterType) : "";

  return await otterInvokeStorage.run(
    { otterId, otterPromptConfig: otterConfig.systemPrompt, identityPrefix, isFirstInvoke: !!options?.isFirstInvoke },
    async () => {
      const { session, sessionKey } = await this._createSessionWithTools(...);
      // ... guards attach ...
      const fullMessage = message;  // ← 不再拼 user-prefix！纯用户消息
      await session.prompt(fullMessage);
      // ...
    },
  );
}
```

**并发安全分析**：
- `otterInvokeStorage.run(ctx, fn)` 按 async 调用链隔离上下文
- 两个 otter 并发 invoke，各自 ALS scope 独立
- handler 执行时读到的是各自 scope 的 store
- `PiSessionFactory.lockManager`（per-otterId 锁）不阻止不同 otter 并发，但 ALS 天然隔离——**无竞态**

**移除的内容**：
- `buildUserMessagePrefix()` 整个方法可删（identity + otterPrompt 不再拼到 user message）
- `buildMessageWithContext()` 的 `staticPrompt` 参数不再使用（只保留 dynamicContext 拼接）
- `buildOtterPrompt()` 的调用点从 user-message 路径移到 system-prompt 路径
- `_executeWithSession:631` 的 `buildMessageWithContext(await this.buildUserMessagePrefix(...), message, ...)` 改为 `buildMessageWithContext("", message, dynamicContext)` 或直接传 message

**新的 `buildOtterSystemPrompt(ctx)` 函数职责**：
- 合并 SDK base system prompt（tools 描述等）+ otter 专属 prompt
- 但 SDK 的 base 由 `_baseSystemPrompt` 构建（含工具描述），otter 拿不到完整的 base
- **关键问题**：handler 返回的 `systemPrompt` 会**替换**整个 system prompt（`agent-session.js:862-863` `currentSystemPrompt = result.systemPrompt`），不是追加
- 所以 `buildOtterSystemPrompt` 必须**包含 SDK base + otter 专属内容**

**如何拿到 SDK base system prompt**：handler 的 event 参数含 `systemPrompt`（`runner.js:853` `systemPrompt: currentSystemPrompt`），这是 SDK 构建的 base。handler 返回值应在此基础上追加：

```typescript
pi.on("before_agent_start", (event: { systemPrompt: string }) => {
  const ctx = otterInvokeStorage.getStore();
  if (!ctx) return;
  const otterPart = buildOtterPromptSection(ctx);  // identity + otterPrompt + reminders
  return { systemPrompt: event.systemPrompt + "\n\n" + otterPart };
});
```

**风险点（需实现时验证）**：
1. SDK base system prompt 的格式（是否有特定 marker 可插入，还是只能字符串拼接）
2. `before_agent_start` 的 handler 返回值是**链式覆盖**（`runner.js:843-866` 遍历所有 extension，`currentSystemPrompt` 会被最后一个返回 systemPrompt 的 handler 覆盖）。如果 ResourceLoader 自带其他 extension 也改 systemPrompt，执行顺序影响结果。当前 otter 只有 `thinking-strip` 一个 extension，无冲突。

#### S2（AgentSession 每次 invoke 重建）—— ✅ 真实，但方案有盲点

**验证**：
- `pi-session-factory.ts:624,649` 确认每次 invoke create + dispose ✅
- `agent-session.d.ts:364` 确认 `prompt()` 支持多次调用 ✅

**原方案的问题**：
- 工具 messageId 闭包与 session 复用冲突——SDK `ToolDefinition.execute` 签名固定，getter 注入需要可变引用
- AgentSession 内部状态（steer/followUp 队列、retry、compaction、extension bindings、tool registry）跨 invoke 复用可能状态泄漏
- 缓存 session 后每个 session 含完整 agent state messages，内存占用累积

**架构师建议（采纳）**：**S2 暂不做激进改造**。改为务实优化——保持每次 invoke 创建 session 的架构（隔离性好），但：
- 缓存 ResourceLoader + ModelRuntime（已做）
- 把工具注册从"每次重建工具定义对象"优化为"复用工具定义模板，只更新 messageId 引用"
- 这样在不改变 session 生命周期管理的前提下减少冷启动开销

**关键结论**：**S2 的激进方案与 S1 方案 A（extension 闭包捕获）互斥**。如果 session 被缓存复用，extension 只在首次创建时绑定，无法再 per-invoke 捕获新 prompt config。因此**本轮只做 S1 + 保守优化 S2，不做 session 复用**。

#### S3（类型安全）—— ⚠️ 部分真实

**验证**：
- `pi-session-factory.ts:708,711,713` 三处 cast 确实存在 ✅
- `import type` 不受 ESM-only 约束 ✅

**根因更深**：`resolvedModel` 静态类型就是 `unknown`——`models-factory.ts:189` 的 `Models` 类型是 `Awaited<ReturnType<PiAiModule["createModels"]>>`，`getModel` 返回 `unknown`。`as never` 是从 `unknown` 到 `Model<any>` 的强行转换。**正确修法是让 `models-factory.ts` 正确导入并返回 `Model<any>` 类型**。

`customTools as never`：execute 只接 2 参 vs SDK 5 参（TypeScript contravariance 允许），但返回类型 `Promise<unknown>` vs `Promise<AgentToolResult<TDetails>>` 不匹配。修法同 S1/M1——补全 execute 签名后类型自然对齐。

#### M1（工具 execute 签名截断）—— ✅ 真实，但返回类型描述有误

**修正**：报告原说"返回类型是 truncated string"**错误**。`tool-helpers.ts:20-32` 的 `truncateToolResult` 返回 `ToolResponse` 对象（`{ content, details, terminate? }`），与 SDK `AgentToolResult<T>` 结构兼容。这是 `as never` 能工作的原因。

**真正的问题**只剩 signal 透传缺失。补 signal 后，otter 的 `AgentTool` 接口需要加可选 signal 参数，长耗时工具（workspace_*）需插入 abort 检查点。

#### M2（双层重试）—— ✅ 真实，补充交互细节

**补充**：两层重试是**串行**而非叠加——SDK 重试（默认 maxRetries=3, baseDelayMs=2000, `settings-manager.js:543-558`）在 `prompt()` 返回前处理完，只有 SDK 重试耗尽后 `errorMessage` 才被设置，otter 层的 `_checkSessionError` 才会抛。最坏情况 = SDK 3 次 + otter 1 次 = 4 次 API 调用。

**建议**：可移除 otter 层 API error 重试（依赖 SDK 内置），但需评估用户体验——目前 otter 层重试会 fail 当前消息再发新消息（有过渡态），直接 fail 可能体验更差。guard_abort 重试（degenerate/no_speak）保留，SDK 不管这些。

#### M3（errorMessage 依赖）—— ✅ 真实，但"未文档化"误判已修正

见上方 M3 章节内联修正。`AgentState.errorMessage` 实际在 `pi-agent-core/dist/types.d.ts:307` 有声明。风险降级——这是文档化的公开 API，SDK 升级大概率保持稳定。

### 报告遗漏的问题（架构师补充）

#### 遗漏 1：`session.subscribe` 事件类型弱化

`pi-session-factory.ts:792-803` 的 `createEventHandler` 把所有 SDK 事件转成 `AgentEvent`（`{ type: string; delta?: unknown }`）。SDK 定义了丰富的 `AgentSessionEvent` 联合类型（`agent-session.d.ts:40-106`），包括 `auto_retry_start/end`、`compaction_start/end`、`queue_update` 等结构化事件。当前只透传 `type` 和 `delta`，**丢失了大量结构化事件数据**（如 `auto_retry_start` 的 `attempt/maxAttempts/delayMs/errorMessage`，`compaction_end` 的 `result/aborted/willRetry` 等）。

影响：下游（OutputGuard、AgentInvoker、前端 SSE）拿不到 SDK 事件的全量字段，部分逻辑靠逆向猜参数。

#### 遗漏 2：`_registerRuntimeModel` 参数正确性待验证

`pi-session-factory.ts:327-343` 的 `registerProvider` 参数含 `api: "openai-responses" | "anthropic-messages"`。SDK 的 `ModelRuntime.registerProvider` 签名（`model-runtime.d.ts`）和 `ExtensionAPI.registerProvider`（`types.d.ts:999`）不同，otter 用的是前者。参数格式需对照 `model-runtime.d.ts` 确认。

#### 遗漏 3：`_checkSessionError` 的 TOCTOU 风险

`_checkSessionError` 在 `session.prompt()` 返回后立即检查 `session.state.errorMessage`。如果 SDK 内部有异步事件处理（如 auto-compaction recovery），`errorMessage` 可能还没被设置，或在 compaction recovery 后被清除。

---

## 修订后的决策

### 核心决策

1. **S1 优先做**（P0）：**AsyncLocalStorage + 全局 extension factory** 方案已确定可行（见上方 S1 审视章节的完整验证链）。用 `before_agent_start` handler 从 ALS 读 per-otter 上下文，返回 `{ systemPrompt: base + otterPart }`。整个 `createAgentSession + prompt` 包在 `otterInvokeStorage.run()` 内。停掉 user-prefix 方案。
2. **S2 暂不做激进 session 复用**（降级为 P3）：改为务实优化——工具定义模板复用。session 复用与 ALS 方案理论兼容（ALS 不依赖 session 重建），但本轮聚焦 S1，不扩范围。
3. **S3 跟随 S1 做**（P1）：补全 execute 签名后类型自然对齐，再清理 `as never`。
4. **M1 跟随 S3 做**（P2）：补 signal 透传，长耗时工具加 abort 检查点。
5. **新增遗漏 1**（P1.5）：`session.subscribe` 事件类型从 `AgentEvent` 升级为 SDK 的 `AgentSessionEvent` 联合类型，恢复结构化事件数据透传。
6. **M2 暂不动**（P4）：需先做用户体验评估（直接 fail vs 过渡态）。
7. **M3 风险降级**（P5）：已确认是文档化 API，稳定。

### 待用户拍板的问题

1. ~~**S1 extension 注入路径**~~：**已确定**——AsyncLocalStorage + 全局 extension factory，无需 per-invoke 重建 ResourceLoader。
2. **M2 是否移除 otter 层 API 重试**：需要用户体验评估（直接 fail 是否可接受）
3. **遗漏 1（事件类型弱化）是否纳入本轮**：改动范围会波及 OutputGuard / AgentInvoker / 前端 SSE
4. **S1 实现细节**：handler 返回的 `systemPrompt` 是替换 SDK base 还是追加？当前设计是 `event.systemPrompt + otterPart`（追加），需确认 SDK base 的格式不会让追加产生格式断裂

### S1 实施步骤（方案确定后的落地清单）

1. `pi-session-factory.ts` 顶部新增 `AsyncLocalStorage` 实例 + `OtterInvokeContext` 接口
2. `ensurePiCodingAgent` 的 extension factory 里新增 `before_agent_start` handler（从 ALS 读上下文，返回追加后的 systemPrompt）
3. `_executeWithSession` 用 `otterInvokeStorage.run(ctx, async () => {...})` 包裹 createAgentSession + prompt 全流程
4. 新增 `buildOtterSystemPrompt(baseSystemPrompt, ctx)` 函数（合并 SDK base + otter 专属内容）
5. 移除 `buildUserMessagePrefix()` 调用，`session.prompt(message)` 传纯用户消息
6. `buildMessageWithContext` 的 `staticPrompt` 参数置空或移除
7. 验证：日志确认 system prompt 进了 system role（而非 user role），context token 消耗下降

---

## 实施验证结果

### 已完成（本轮 worktree pi-sdk-audit）

| 项 | 状态 | 验证 |
|----|------|------|
| **S1** system prompt 注入 | ✅ 实施 | tsc 通过 + 143 agent 测试全过 |
| **M2** 重试层调整 | ✅ 实施 | tsc 通过 + agent-invoker 测试更新（API error 直接 fail） |
| **遗漏 1** 事件类型 + SSE 映射 | ✅ 实施 | tsc 通过 + 全量 1036 测试通过 |
| **S3** 类型安全（`as never` 清理） | ✅ 实施 | tsc 通过 + 全量 1036 测试通过 |
| **M1** 工具 execute signal 透传 | ✅ 实施 | tsc 通过 + 全量 1036 测试通过 |

#### S1 实施细节

- `pi-session-factory.ts`：新增 `AsyncLocalStorage<OtterInvokeContext>` + `OtterInvokeContext` 接口
- extension factory（重命名 `thinking-strip` → `otter-hooks`）新增 `before_agent_start` handler：从 ALS store 读 `otterPromptConfig` + `identityPrefix`，在 SDK base systemPrompt 基础上追加 otter 专属内容
- `_executeWithSession`：整个 createAgentSession + prompt 包在 `otterInvokeStorage.run()` scope 内
- 身份前缀在 ALS scope 外构建（含 DB 查询），结果字符串传入 scope
- 移除了 `buildUserMessagePrefix()` 方法（无调用者）
- `buildMessageWithContext` 的 `staticPrompt` 传空串（dynamicContext 仍拼在 user message）
- **未单独建 `buildOtterSystemPrompt` 函数**——handler 内联拼接（逻辑简单，三个 part join）

#### M2 实施细节

- `pi-session-factory.ts`：`ensurePiCodingAgent` 创建 `SettingsManager.create(cwd)` + `applyOverrides({ retry: { enabled: true, maxRetries: 4 } })`，缓存并传给 `createAgentSession({ settingsManager })`
- `agent-invoker.ts`：`routeApiError` 移除 retry 分支，直接 `failTerminal`；删除 `isRetryableApiError` 方法
- `handleAutoRetry` 保留——guard_abort 重试（degenerate/no_speak）仍需要
- 测试 `agent-invoker.test.ts`：`LLM API error triggers auto-retry` 更新为 `LLM API error fails directly`

#### 遗漏 1 实施细节

- `agent-invoke-port.ts`：移除 `AgentStreamEvent.delta` 死字段；re-export SDK `AgentSessionEvent` 供精确 narrowing
- `pi-session-factory.ts`：`AgentEvent` 改为 `type AgentEvent = AgentStreamEvent`（类型别名对齐）
- `agent-invoker.ts` 的 `mapToSSEEvent`：新增 `auto_retry_start/end` → `agent.retry_start/end`、`compaction_start/end` → `agent.compaction_start/end` SSE 事件映射，透传 attempt/maxAttempts/delayMs/reason/aborted 等结构化字段
- **保持弱类型 + 索引签名**：强类型 `AgentSessionEvent & { [key: string]: unknown }` 破坏测试 mock（AgentMessage 要求完整 api/provider/usage 字段），故只 re-export 不替换

#### S3 实施细节

- `model-pool.ts`：`ModelEntry.model` / `defaultModel` / `getModel()` / `getDefaultModel()` / `getAllEntries()` / `buildModelPool` 参数——全部从 `unknown` 改为 `Model<Api>`
- `models-factory.ts`：`loadCustomProvider` / `loadProvider` 返回 `Provider`（非 unknown）；`initModelPool` / `initModels` / `initFauxModels` 返回 `model: Model<Api>`；`models.setProvider(providerModule)` 去掉 `as never`
- `bootstrap/database.ts` + `bootstrap/platforms.ts` + `app.ts`：model 字段从 `unknown` 改为 `Model<Api>`
- `pi-session-factory.ts`：
  - `AgentSessionFactoryConfig.model` / constructor `cfg.model` / `_registerRuntimeModel(model)` 参数：`Model<Api>`
  - `_registerRuntimeModel` 移除 inline cast `model as { id, name?, ... }`——直接访问 `model.xxx`（SDK 类型精确声明）
  - `createAgentSession` 的 `model: resolvedModel`（去掉 `as never`）、`customTools`（去掉 `as never`）、`modelRuntime: this.modelRuntime ?? undefined`（去掉 `as any`）、`settingsManager: this.settingsManager ?? undefined`（去掉 `as any`）
  - `modelRuntime` / `settingsManager` 字段类型改为 SDK 的 `ModelRuntime` / `SettingsManager` class
  - `ensurePiCodingAgent` 创建逻辑去掉 `(piCodingAgent as unknown as {...}).ModelRuntime` / `.SettingsManager`——直接 `piCodingAgent.ModelRuntime.create()` / `piCodingAgent.SettingsManager.create()`
  - `_buildInvokeResult` 的 `(this.cfg.model as Record<string, unknown>)?.contextWindow` → `this.cfg.model.contextWindow`
  - `DefaultResourceLoader` / `getAgentDir` 去掉 `as unknown as {...}`——直接解构 `piCodingAgent`
  - **保留的 cast**：extension factory 的 `(pi: any)`——SDK 的 `ExtensionAPI.on()` overload 不包含 "context"/"before_agent_start"，类型定义限制，合理保留
- 测试 mock：`model-pool.test.ts` 的 `makeModel()` 返回值加 `as unknown as Model<Api>`；`identity-prefix.test.ts` 的 `model: null as never`；其他测试 mock 用 `as never`——测试简化对象的合理 cast

#### M1 实施细节

- `tool-factory.ts`：`AgentTool.execute` 签名加可选 `signal?: AbortSignal` 第三参数
- `pi-session-factory.ts`：`buildCustomTools` 适配器的 execute 签名加 `signal?: AbortSignal`，透传 `await t.execute(toolCallId, params, signal)`
- `buildCustomTools` 返回类型 execute 从 `Promise<unknown>` 改为 `Promise<ToolResponse>`（结构兼容 SDK `AgentToolResult`，去掉 `customTools as never`）

### 待跟进（后续 PR）

| 项 | 优先级 | 备注 |
|----|--------|------|
| ~~S3 类型安全~~ | ✅ 已完成 | 本轮实施 |
| ~~M1 工具 execute signal 透传~~ | ✅ 已完成 | 本轮实施 |
| **S2** Session 复用（保守优化） | P3 | 工具定义模板复用，减少每次 invoke 的工具重建开销 |
| **M1 后续**：长耗时工具 abort 检查点 | P3 | signal 已透传，但 workspace_* 等工具内部还需插入 `signal.aborted` 检查 |
