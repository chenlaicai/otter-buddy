---
id: F20260909smsp
title: speak 消息模型重构：一次 invoke 多次 speak 落多条 message（时间序真实呈现）
doc_type: feature

summary: |
  搭档 9/9 拍板纳入 F20260908rlcp 本 PR（「本pr做完整！」）。现状：一次 invoke 的
  多次 speak 全部 append 为同一 message 的 segments，UI 按 message.created_at
  排序——运行期 steer/用户插话在视觉上永远排在大獭整条消息之后，时间序失真。
  改造：每次 speak 创建独立 message（senderType=otter，status=speaking，
  segments=[本次 body]），时间序由 message.created_at/sequence_num 自然承载；
  invoke 内的 message 链（首个 + N 个 speak 消息）通过 invoke_group_id 逻辑归组，
  UI 平铺展示（视觉归组后置）。speak 幂等终结语义不变（熔断护栏沿用）。

causal_links:
  from:
    - F20260908rlcp   # 信号机制收敛母方案（搭档 9/9 拍板本改造纳入同 PR）
    - F20260818sgmt   # speak-yield 拆分（speak=纯输出语义的前身）
    - F20260821spcm   # speak 通信模型（segments 子表的前身）
  supersedes: []

status: draft
change_type: refactor
tags: [message-model, speak, segments, ui-timeline, architecture]
modules:
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/usecases/conversation/send-message.ts
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - src/frameworks/db/conversation/sqlite-conversation-repository.ts
  - web/src/pages/conversation/
created_in_conversation: c97f3b93-1ef8-419f-8997-b64ac33be16e
capability_test: "忙时插话场景：大獭 speak(A) → 用户发言 → 大獭 speak(B) → UI 按 A→用户→B 时间序平铺"
intent:
  problem: "一次 invoke 多次 speak 落同一 message 的 segments，UI 按 message 创建时间排序导致 steer/插话时间序失真"
  expected_effect: "每次 speak 独立 message，UI 时间序与实际发言序一致（speak A → 用户插话 → speak B 按序平铺）"
  verify_by:
    type: behavior_check
---

# F20260909smsp: speak 消息模型重构——一次 invoke 多次 speak 落多条 message

## 背景

搭档 9/9 12:57 反馈（msg140）：
> 大獭说话A进行中，然后我说一句话，然后大獭的发言还在继续并且收到我的发言，但是从 ui 消息从上到下，很怪：大獭的发言 > 我的发言 > 小獭的发言；但其实按照时间顺序其实是：大獭的发言 > 我的发言 > 大獭的发言。所以我感觉，steer 应该拆分两条 message 吧。

9/9 16:44 拍板（msg 本pr做完整）：本改造纳入 F20260908rlcp 同 PR。

### 根因

- `agent-invoker.invokeConversationInner` 在 invoke 开始时调 `sendMessage.start()`
  创建**一个** streaming message（`currentMessageId`）
- invoke 内每次 speak 调 `appendSegment(currentMessageId, body)` 追加 segment
- UI 按 `message.created_at`（首条 segment 创建时刻）排序整条 message
- 结果：运行期到达的用户插话/小獭消息（独立 message，created_at 更晚）
  在视觉上永远排在大獭整条消息**之后**——即使大獭的 segment 2 实际发言时间
  晚于插话

### 目标态（搭档语义）

消息流按**实际发言时间**平铺：
```
speak A (t1) → 用户插话 (t2) → speak B (t3) → yield
```
UI 上三条独立气泡，时间序 = 视觉序。

## 非目标

- **视觉归组 UI**（同一 invoke 的多条 speak 消息加共享边框/折叠）——后置，
  本轮纯时间平铺
- segments 子表退役——保留（单条 message 的内容载体，speak 消息恒 1 条 segment；
  系统消息/retry 等多 segment 场景不受影响）
- turn 概念改动——invoke 与 turn 的关系不变
- resume/恢复语义改动——恢复路径按新模型适配，语义不变

## 方案设计

### 概念表

| 概念 | 定义 |
|------|------|
| invoke 消息链 | 一次 invoke 产出的全部 message：首个 streaming message + N 个 speak message |
| 首个 message | invoke 开始创建（streaming→speaking→completed/failed/aborted），
  承载 yield 的 tsp；body 可空（speak 拆分后内容归 speak message） |
| speak message | 每次 speak 创建的独立 message（senderType=otter，status=speaking→
  completed at next-speak-or-yield），segments=[本次 body] |
| invoke_group_id | 消息元数据字段（metadata.invokeGroupId = 首个 message id），
  逻辑归组，UI 后置消费 |

### 核心改动

**1. speak 落库改独立 message（tool-factory.ts + send-message.ts）**

speak execute 内：
- 若有「当前打开的 speak message」（上一次 speak 创建、未完结）→ 先完结它
  （status→completed，completed_at=now）
- 创建新 message：senderType=otter、senderId=ctx.otterId、status=speaking、
  turnId=当前 turn、metadata.invokeGroupId=首个 message id
- appendSegment(新 message.id, cleanBody)
- 广播 speak.intermediate（带新 messageId + seq，前端按独立气泡渲染）

**2. agent-invoker 多 message 管理（agent-invoker.ts）**

- `currentMessageId` 语义收窄：仅指**首个 message**（yield/fail/abort 的目标）
- speak 创建的 message 由 send-message 内部管理（ctx 记录 lastSpeakMessageId）
- yield 时：完结当前打开的 speak message（若有）→ 首个 message startSpeaking
  （tsp 写在首个 message 上，路由点火语义不变）
- fail/abort：首个 message + 打开的 speak message 同标终态

**3. SSE 事件适配**

- `message.start`：speak message 创建时也广播（前端插入新气泡）
- `speak.intermediate`：保留（segment 落库信号），但 messageId 指向新 speak message
- `message.complete`：speak message 完结时广播

**4. 幂等与熔断护栏不变**

- speak 重复调用幂等终结（F20260810cb01 事故修复）语义保留：
  同一 body 重复 speak → 拒绝（terminate:true）
- 熔断器不对 speak 注入 steer 不变

**5. 历史兼容**

- 旧消息（多 segment 单 message）原样展示，不迁移
- 新逻辑仅影响新 invoke

### 数据模型

无 schema 变更：
- speak message 复用 messages 表（senderType=otter）
- invokeGroupId 存 metadata JSON（可选字段，旧行为 null）
- segments 恒 1 条（speak message）

## 影响范围

- agent-invoker / orchestrator / tool-factory（核心链路）
- send-message / conversation-repository（speak message 创建与完结）
- SSE 事件流（message.start/complete 广播频次增加）
- web 渲染（按独立 message 平铺，tmp 去重逻辑适配）
- resume 恢复（打开的 speak message 恢复终态化）
- 测试（speak/yield/熔断/resume/多獭场景断言更新）

## 风险与约束

| 风险 | 缓解 |
|------|------|
| yield 前 speak message 未完结的窗口状态 | yield 内联完结（同事务），无中间态外泄 |
| fail/abort 遗漏 speak message | 收尾统一遍历 invoke 消息链（invokeGroupId 查询） |
| 前端 tmp 去重错乱 | speak.intermediate 带真实 messageId，tmp 匹配按 messageId 收敛 |
| 熔断 speak 幂等判定失效 | 幂等键不变（body 内容），与新 message 创建解耦 |
| resume 恢复时多个 streaming message | 恢复按 invokeGroupId 收敛，全部终态化 |

## 验证

| 编号 | 场景 | 预期 |
|------|------|------|
| AT-1 | 单次 speak + yield | 首 message + 1 speak message，均 completed，tsp 在首 message |
| AT-2 | 多次 speak + yield | N 个 speak message 按序平铺，时间序=sequence 序 |
| AT-3 | 忙时插话 | speak A → 用户消息 → speak B 在 UI 按 A→用户→B 平铺 |
| AT-4 | speak 后无 yield 直 fail | 首 message + 打开的 speak message 同标 failed |
| AT-5 | abort 中断 | 首 message + 打开的 speak message 同标 aborted |
| AT-6 | speak 幂等 | 同 body 重复 speak 由熔断器（F20260810cb01，body 内容指纹）拦截，speak 工具层不拒绝（与拆分前一致） |
| AT-7 | resume 恢复 | 中断时打开的 speak message 恢复后终态化，无悬挂 streaming |
| AT-8 | 多獭并发 | 獭 A 的 speak 消息链不被獭 B 干扰（invokeGroupId 隔离） |
| AT-9 | 历史消息展示 | 旧多 segment 消息原样展示，无回归 |

## 改动范围（预估）

| 文件 | 操作 |
|------|------|
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | speak 改独立 message 创建 |
| src/usecases/conversation/send-message.ts | speak message 创建/完结 + invokeGroupId |
| src/interface-adapters/agent-runtime/agent-invoker.ts | currentMessageId 语义收窄 + 收尾遍历 |
| src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts | messageId 链路适配 |
| src/frameworks/db/conversation/sqlite-conversation-repository.ts | invokeGroupId 查询支持 |
| web/src/pages/conversation/ | tmp 去重 + 平铺渲染适配 |
| tests/ | 上述场景断言更新 |

## 实现要点（开发獭-smsp）

### 改动文件清单（实际）

| 文件 | 操作 | 说明 |
|------|------|------|
| src/entities/conversation/message.ts | 小改 | MessageMetadata 加 invokeGroupId 可选字段 |
| src/usecases/ports/agent-tools.ts | 小改 | ToolContext 加 lastSpeakMessageId 字段 |
| src/usecases/ports/otter-tool-client.ts | 小改 | message 命名空间加 createSpeakMessage/completeSpeakMessage/getByInvokeGroupId |
| src/usecases/conversation/conversation-repository.ts | 小改 | 接口加 createSpeakingMessage/getMessagesByInvokeGroupId |
| src/usecases/conversation/send-message.ts | 中改 | 新增 createSpeakMessage/completeSpeakMessage/getMessagesByInvokeGroupId 方法 |
| src/frameworks/db/conversation/sqlite-conversation-repository.ts | 中改 | 实现 createSpeakingMessage + getMessagesByInvokeGroupId（JSON_EXTRACT 查询） |
| src/bootstrap/clients.ts | 小改 | message client 接线 createSpeakMessage/completeSpeakMessage/getByInvokeGroupId |
| src/frameworks/agent/tool-builder.ts | 小改 | ToolContext 初始化加 lastSpeakMessageId |
| src/frameworks/agent/pi-session-factory.ts | 小改 | EMPTY_TOOL_CONTEXT_BASE 加 lastSpeakMessageId |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | **重改** | speak execute 重写（创建独立 message + 完结旧 message）+ yield execute 加完结逻辑 + validateMessageHasContent 适配 |
| src/interface-adapters/agent-runtime/agent-invoker.ts | 中改 | emitSpeakIntermediate 用 speakMessageId + 广播 message.start + TurnCallbacks 扩展 |
| src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts | 中改 | tryCompleteSpeaking 完成 invoke group + failTerminal/abortTerminal 终态化 invoke group |
| src/usecases/conversation/agent-turn-orchestrator/types.ts | 小改 | TurnCallbacks 扩展 getMessagesByInvokeGroupId/completeSpeakMessage/getMessageById 返回 metadata |
| tests/interface-adapters/speak-tool.test.ts | 小改 | mock 适配新方法 |
| tests/interface-adapters/agent-invoker.test.ts | 小改 | completeMessage 参数断言更新 |
| tests/interface-adapters/speak-message-split.test.ts | **新建** | AT-1~9 全量 + 3 个修复锁定（33 条测试） |
| tests/usecases/conversation/invoke-group-lifecycle.test.ts | **新建** | invoke group 生命周期：complete/terminate/get + skipSegmentValidation 锁定 |

### 最简实现检查

已过最简检查——无新增依赖、无新增 DB 表、invokeGroupId 存 metadata JSON；segments 子表保留复用。

### 关键设计决策

1. **ToolContext.lastSpeakMessageId**：存 ToolContext 上（invoke 级生命周期），非 send-message 内部状态（send-message 无状态用例层）
2. **speak message talkingStonePassedTo**：传 [senderId]（过终态校验，无路由语义）
3. **invokeGroupId 查询**：`JSON_EXTRACT(metadata, '$.invokeGroupId')` + 首个 message ID 匹配，覆盖两个方向
4. **前端无需改动**：speak message 走标准 message.start/speak.intermediate/message.complete 生命周期，前端按 messageId 平铺渲染
