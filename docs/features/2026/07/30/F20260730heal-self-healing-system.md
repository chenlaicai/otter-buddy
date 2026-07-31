---
id: F20260730heal
title: self-healing-system
doc_type: feature

summary: |
  Self-Healing 系统：让 otter-buddy 在日常使用中自动发现系统问题、归因分析、在人的参与下修复。
  Agent 在 speak 时通过 <healing> 标签自报告系统问题（工具故障、检索缺失、格式异常等），
  系统在 speak tool execute 层拦截并剥离标签，结构化写入 healing_events 表（标签从未进入 message body）。
  定时任务每天将待处理问题注入 Self-Healing 对话，人和 agent 协作分析修复。
  所有海獭（大獭+小獭）都可以上报，协议在 speak tool description 中，不在 identity prompt 中。

causal_links:
  from:
    - F20260730sbrt   # speak-retry-thinking-only：困境上报机制是 self-healing 的前身
    - F20260724skch   # skill-tool-channel-consolidation：信道分层原则（协议跟着工具走）

status: final
change_type: feature
tags: [agent, healing, self-healing, feedback-loop, speak, tool, observability]
modules:
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/frameworks/agent/session-helpers.ts
  - src/frameworks/db/schema.ts
  - src/usecases/scheduler/scheduler-service.ts
  - src/entities/healing/
  - src/usecases/healing/
  - src/frameworks/db/healing/

created_at: 2026-07-30
---

# F20260730heal Self-Healing 系统

## 背景

### 问题

otter-buddy 有完善的防御性安全网（熔断器、输出守卫、speak 重试），但这些都是"出了事拉闸"，不是"出了事变好"：

```
问题发生 → 停止 → 然后呢？
                ↑ 这里是断层
```

用户（海獭和搭档）在日常使用中会遇到各种系统问题：工具报错、检索不准、格式异常等。这些问题被遇到了、被绕过了，但没有被系统性地捕获和修复。同样的问题会反复出现。

### 设计目标

形成 **"使用 → 发现 → 分析 → 修复 → 验证"** 的闭环。不追求自进化（自主改代码/prompt），先追求 self-heal（发现问题→人在回路修复）。

核心约束：
- **不增加 LLM 工具调用开销**：healing report 嵌入 speak body，不新增工具
- **标签永远不进入 message body**：在 speak execute 层拦截剥离，DB 和记忆索引天然纯净
- **人在回路**：agent 只能提议修复，不能自主修改 prompt/工具/代码
- **所有海獭都能上报**：协议在 speak tool description 中，不在 identity prompt 中

## 变更

### 1. Agent 自报告：Healing Report 协议

Agent 在 speak body 末尾附带 `<healing>` 标签报告系统问题。协议嵌在 speak tool 的 description 中（`【系统自愈】` 段），不在 BIG_OTTER.md 中。这是信道分层原则的应用——"怎么做"跟着工具走，不混入身份 prompt。

**为什么不在 identity prompt 中**：healing report 是所有海獭（大獭+小獭）都应该能做的事。如果放在 BIG_OTTER.md，小獭看不到；如果同时放两个文件，维护成本翻倍。放在 speak tool description 中，一步到位。

**为什么用标签而不是单独工具**：不增加工具调用计数（不触发熔断器）、不增加 LLM 推理负担、与 speak 的"终结发言"语义天然契合。agent 忘写标签不影响任何功能。

### 2. 系统拦截：speak execute 层剥离

在 `createSpeakTool` 的 execute 闭包中，调用 `startSpeaking()` 之前：
1. `stripHealingReport(rawBody)` → `cleanBody`（剥离标签）
2. `parseHealingReport(rawBody)` → `issues[]`（解析用 rawBody）
3. `startSpeaking(cleanBody)` → DB 中 body 无标签
4. `healingEventRepo.create(issues)` → 异步写入 healing_events

**为什么在 speak execute 中而不是 post-invocation**：message body 一旦由 `startSpeaking()` 写入 DB 就不可变。post-invocation strip 没有写回路径，且 `complete()` 内部的 `memoryIndex.indexMessage()` 会将含标签的 body 索引。在 execute 中先 strip 再写入，标签从未进入 DB，一步到位解决 body 污染、记忆污染、前端展示三个问题。

**执行顺序**：先 strip 再校验 cleanBody 非空。如果 agent 只输出 `<healing>[no_issue]</healing>` 没有实际内容，cleanBody 为空，校验拦截返回错误提示，不会写入空 body 到 DB。

### 3. 数据存储：healing_events 表

独立的新表，不与 messages 表关联外键。字段：id, message_id, conversation_id, otter_id, error_type, severity, description, suggestion, context, status, resolution, created_at, resolved_at。

**为什么独立表而不是扩展 messages**：healing events 是结构化诊断数据，需要按 type/severity/status 聚合查询。messages 表是对话数据，语义不同。

### 4. 对话式修复：Self-Healing 对话

系统启动时自动创建一个专属 "🩺 Self-Healing" 对话（存在 settings 表中记录 ID，避免重复创建）。Big Otter 在其中扮演"系统医生"角色。

**为什么是对话而不是后台任务**：对话是 otter-buddy 的核心交互范式。用户可以直接参与决策（同意/驳回/延后）。分析结果自然留存为对话历史，可追溯。

### 5. 定时分析：SchedulerService 动态注入

定时任务 body 为 `[self-healing-analysis]` 标记。`triggerTask` 识别标记后，查询 healing_events 表，将待处理问题动态拼接到 prompt 中，同时注入到 `createSystemMessage` 和 `invokeAgentWithTimeout`。无 open events 时静默跳过，不产生噪音消息。

**为什么系统侧注入而不是 agent 工具查询**：更简单可靠，无额外工具调用，数据在 prompt 中直接可见。

### 6. 管理工具：manage_healing_events

供 agent 在 Self-Healing 对话中查询和管理 healing events（query/resolve/dismiss）。只分配给 Big Otter（在 `getOtterToolNamesForType` 白名单中）。

## 设计决策

1. **healing report 协议放在 speak tool description，不在 identity prompt**：遵循信道分层原则（F20260724skch）——"怎么做"是工具层的事，"你是谁"是身份层的事。所有海獭都有 speak 工具，所以上报能力天然覆盖所有海獭。

2. **先 strip 再校验，而非先校验再 strip**：如果先校验 rawBody 非空再 strip，当 agent 只输出 `<healing>[no_issue]</healing>` 时 rawBody 非空通过校验，但 strip 后 cleanBody 为空，`startSpeaking("")` 写入 DB，后续 `complete()` 校验 body 非空会抛错，消息卡在 speaking 状态。

3. **解析器鲁棒性防御**：LLM 输出格式偏差是客观存在的。解析器做 6 层防御：normalize（去转义、统一大小写）→ 白名单校验（type/severity fallback）→ 多行支持 → 长度截断（500 字）→ 绝对长度误解析防护（5000 字）→ 数量上限（10 条）。

4. **createTools 签名扩展而非纯闭包**：纯闭包无法将 healingRepo 传入 `createTools` 内部的 `createSpeakTool`。必须扩展签名为 3 参数（ctx, healingRepo?, logger?），`pi-session-factory.ts` 同步修改。向后兼容（可选参数）。

5. **ensureHealingConversation 通过 otterRepo 验证 type === 'big'**：`ConversationParticipant` 实体没有 type 字段，直接取第一个 active 参与者不保证是 big otter。注入 `otterRepo.getById()` 逐个验证。

6. **resolve/dismiss 用 Promise.allSettled**：单个 ID 失败不应阻塞其他 ID 的操作。返回成功/失败计数，agent 可以据此决定重试。

7. **无 open events 时静默跳过**：`buildHealingAnalysisBody` 返回 null，`triggerTask` 检测到 null 后直接 return，不创建系统消息、不触发 agent。避免每天"没事"的噪音消息。

8. **autoStaleDismiss 用独立 try-catch**：清理过期事件是辅助操作，DB 异常不应导致定时任务被禁用（连续失败 3 次后任务会进入 error 状态）。

9. **不需要 feature flag**：healingRepo 可选注入，不传则所有 healing 逻辑跳过。BIG_OTTER.md 不再有 healing 内容，无需回滚 prompt。healing_events 是新表，不影响现有表。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src/entities/healing/healing-event.ts` | 新增：HealingEvent 实体 + 类型定义 |
| `src/usecases/healing/healing-event-repository.ts` | 新增：Repo 接口 |
| `src/usecases/healing/healing-report-parser.ts` | 新增：parseHealingReport + stripHealingReport |
| `src/usecases/healing/ensure-healing-conversation.ts` | 新增：启动时创建 Self-Healing 对话 |
| `src/usecases/healing/ensure-healing-scheduler.ts` | 新增：启动时创建定时任务 |
| `src/frameworks/db/healing/healing-event-mapper.ts` | 新增：DB Row ↔ Entity 映射 |
| `src/frameworks/db/healing/sqlite-healing-event-repository.ts` | 新增：SQLite 实现 |
| `src/frameworks/db/schema.ts` | 新增 healing_events 表 + 索引 |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | createSpeakTool 加 healing 拦截 + createManageHealingEventsTool + createTools 签名扩展 + speak description 追加协议 |
| `src/frameworks/agent/pi-session-factory.ts` | createTools 类型扩展 + healingRepo 注入 |
| `src/frameworks/agent/session-helpers.ts` | allToolNames 添加 manage_healing_events |
| `src/usecases/scheduler/scheduler-service.ts` | triggerTask 动态注入 healing 数据 + healingRepo 依赖 + 方法合并为可选 body 参数 |
| `src/main.ts` | DI 装配 + 启动初始化 |
| `prompts/identity/BIG_OTTER.md` | 无变更（协议在 speak tool 中，不在 identity 中） |

## 测试

- `npm run lint` — 无报错
- `npm test` — 717/717 通过
- 新增 19 个 healing-report-parser 单元测试：
  - 基本功能 4 个（no_issue、无标签、单 issue、多 issue）
  - LLM 偏差鲁棒性 5 个（大小写、markdown 转义、backtick 包裹、标签不闭合、未知枚举值 fallback）
  - 防误解析 4 个（5000 字阈值、10 条上限、500 字截断、空格变体）
  - stripHealingReport 4 个（剥离、保留前后文、多余空行折叠、无标签透传）
