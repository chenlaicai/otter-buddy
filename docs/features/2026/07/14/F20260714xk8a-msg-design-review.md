---
id: F20260714xk8a
title: msg-design-review
from_ids: [F20260714jaup, F20260713e8n4, F20260713c7p2, F20260713o4t8, F20260714zjmk]
tags: [architecture, design-review, conversation, message, agent, snail-comparison]
modules: [src/entities/, src/usecases/]
doc_kind: spec
status: locked
created_at: 2026-07-14
---

# F20260714xk8a [msg-design-review] 对话/消息/Agent 实例设计对照 Snail Shell 审视

## [design-time]

> 本文档记录对照 Snail Shell 消息/对话/Agent 实例设计，审视 Otter Buddy 当前设计的欠缺与修正方案。
>
> 审视过程：架构师-1 产出草稿分析 -> 架构师-2 对抗审视 -> 双方达成共识 -> 产出本文档。

## 背景 [required]

### 问题

用户要求对照 Snail Shell 的对话、消息、Agent 实例设计，审视 Otter Buddy 是否有欠缺。

### Snail Shell 的核心设计

Snail Shell 平台的消息模型采用两层设计：

| 概念 | Snail Shell 实现 |
|------|-----------------|
| 消息生命周期 | streaming -> set_final_body -> 结束 |
| 流式内容 | 中间分析过程（tool calls、reasoning），设置 final body 后被折叠 |
| 最终答复 | `set_final_body(text, message_id, stage_id, from_speaker, to_speakers)` -- 终端操作，完成时设置路由目标 |
| 说话者模型 | `from_speaker` + `to_speakers`（路由目标，完成时决定） |
| 层级 | Issue > Stage > Message |
| Stage 推进 | Gate 机制（request_stage_transition + signal_type） |

**核心洞察**：Snail 的 `to_speakers` 在 `set_final_body` 时设置 -- Agent 在完成分析后才决定路由目标，而非消息创建时。

### 已有设计

- F20260714jaup：entities 层实现（含 Turn + 发言石 + Session 链式）
- F20260713e8n4：消息流式模型（两层消息 + 事件持久化）
- F20260713c7p2：对话领域模块（CRUD + 消息 + 关键信息）
- F20260713o4t8：Otter 领域模块（Agent 生命周期管理）
- F20260714zjmk：整洁架构重构（4 层 + 依赖规则）

### 约束输入

- F20260714jaup UA-7/UA-8/UA-9：发言石必填非空、轮次模型
- F20260713e8n4：消息两层模型（streaming -> completed/failed）
- F20260714zjmk D36：entities 层含类型 + 不变量规则函数
- F20260714zjmk D42：Greenfield 实现，旧代码仅作参考

## 用户意图锚 [required]

| ID | 来源 | 用户原话（逐字引用） | 关键修饰语 | 架构师解读 |
|---|------|---------------------|-----------|-----------|
| UA-1 | 当前讨论 | 对照snail看看otter的对话、消息、agent实例的设计是否还有欠缺？ | 对象：otter 的对话、消息、agent 实例设计；参照：snail；目标：是否有欠缺 | 需对照 Snail Shell 的消息/对话/Agent 模型，审视 Otter 当前设计是否存在欠缺 |

## 目标 [required]

### P1 - 识别并修正设计欠缺

对照 Snail Shell 的核心设计模式，审视 Otter 的对话/消息/Agent 实例设计，识别欠缺并产出修正方案。

### P2 - 产出修正规格

- entities 层修正：`talkingStonePassedTo` 可空性 + 不变量函数更新
- Turn 生命周期行为规格
- 输入类型设计规格（供 usecases 层实现参考）
- DDL 缺口记录（供 frameworks 层实现参考）

## 非目标 [required]

- 不实现 usecases 层代码（后续 Issue）
- 不实现 frameworks 层代码（后续 Issue）
- 不修改已合入的 F20260714jaup 文档（创建新文档记录修正）
- 不改变 Snail Shell 平台自身的设计
- 不实现前端 UI

## 设计 [required]

### 1. 对照分析结果

#### 1.1 已对齐 Snail 的设计（无欠缺）

| Snail 概念 | Otter 实现 | 评估 |
|---|---|---|
| 两层消息模型（流式事件 + 最终 body） | Message + MessageEvent（F20260713e8n4） | 完全对齐 |
| 消息生命周期（streaming -> final） | streaming -> completed/failed | 对齐 + 改进（显式 failed 状态） |
| 结构化事件持久化 | message_events 表（typed + payload） | 改进（Snail 是隐式折叠，Otter 是结构化事件表） |
| 消息不可变性 | body 一旦设置不可修改（D18 扩展） | 对齐 |
| Agent 实例管理 | AgentRegistry（create/destroy/reset/get） | 对齐 |
| Session/上下文重置 | archiveSession -> AgentRegistry.reset | 对齐 |
| Session 链式关系 | previousSessionId（F20260714jaup UA-11） | 对齐 + 改进（显式链表） |
| 消息上下文展开 | expandMessage（before/after/both） | 对齐（Snail 的 get_message_window） |
| 消息历史查询 | getMessages（分页 + status 过滤） | 对齐（Snail 的 list_messages） |
| 消息终态不可逆 | completed/failed 不可转换 | 对齐（Snail 的 set_final_body 终端操作） |

#### 1.2 Otter 的改进（优于 Snail）

| 维度 | Snail | Otter | 改进点 |
|---|---|---|---|
| 事件类型化 | 无显式分类（隐式折叠） | text_delta / tool_call / tool_result / error | 支持程序化查询和差异化处理 |
| 失败处理 | 无显式 failed 状态 | streaming -> failed（body 保持 NULL，事件保留） | 保留失败消息和事件用于调试 |
| 多 Agent 协调 | to_speakers + stage gates | talkingStonePassedTo + Turn 轮次模型 | 显式发言权传递 + 轮次管理 |
| 事件存储 | 折叠保留（平台管理） | 独立表 message_events（append-only） | 支持索引查询 |
| 附件 | 无 | attachments（type + url + name） | 支持多媒体内容 |

#### 1.3 Agent 实例设计对比

| 维度 | Snail | Otter | 评估 |
|---|---|---|---|
| Agent 标识 | Snail Key + Name + Role + Role Instance | Otter id + name + type + role | 不同场景，各自合理 |
| Agent 生命周期 | 平台管理 | AgentRegistry 管理 | 对齐 |
| Agent 执行 | 平台调度 | AgentHandle.run/stream | 对齐 |
| Agent 重置 | Stage transition（自动） | archiveSession -> reset（显式） | 对齐 |
| 工具管理 | Skills（系统级） | registerTool/unregisterTool | 对齐 |
| 模型指定 | Per-snail model | 统一 LLMGateway.getModel() | 未来迭代事项 |
| 上下文管理 | 自动压缩 | reset() 清空 | 未来迭代事项 |
| Agent 配置 | systemPrompt + context | systemPrompt + context | 对齐 |

**Agent 实例结论**：当前设计已对齐 Snail 的核心模式。per-otter model 和上下文压缩是未来迭代事项，不影响当前架构。

---

### 2. entities 层修正：`talkingStonePassedTo` 可空性

#### 2.1 问题

F20260714jaup 定义的 Message 实体：
```typescript
interface Message {
  talkingStonePassedTo: string[]; // 必填，非空
  body: string | null;            // streaming 时为 null
}
```

`talkingStonePassedTo` 必填非空，但 streaming 阶段的 Otter 消息不可能知道传给谁（Otter 在完成响应生成后才决定路由目标）。这与 `body: string | null` 的模式矛盾。

Snail Shell 的 `set_final_body(text, ..., to_speakers)` 在完成时设置 `to_speakers` -- 路由决策在最终答复时做出。

#### 2.2 修正方案

**类型修正**：
```typescript
interface Message {
  talkingStonePassedTo: string[] | null; // NULL during streaming, set at completion
  body: string | null;                    // NULL during streaming, set at completion
}
```

与 `body: string | null` 保持一致的模式：streaming 阶段未定，completed 阶段必填。

**不变量函数更新**：

保留原有函数（通用校验）：
```typescript
function isValidTalkingStonePass(recipients: string[]): boolean {
  return recipients.length > 0;
}
```

新增 completed 状态校验：
```typescript
function isValidCompletedMessageTalkingStone(recipients: string[] | null): boolean {
  return recipients !== null && recipients.length > 0;
}
```

**行为规格**：

| 消息类型 | talkingStonePassedTo | status | 说明 |
|---------|---------------------|--------|------|
| 用户消息（sendMessage） | 创建时设置 | completed | 用户明确 @ 谁 |
| Otter 消息（startMessage） | null | streaming | 生成中，未定 |
| Otter 消息完成（completeMessage） | 必须提供 | completed | 完成时决定路由 |
| 失败消息（failMessage） | 保持 null | failed | 与 body 一致 |

---

### 3. Turn 生命周期行为规格

#### 3.1 状态机

```
(无 Turn) --用户发消息--> Turn(open) --所有消息终态--> Turn(closed) --下一条消息--> Turn(open) ...
```

#### 3.2 行为条目

| # | 触发条件 | 预期行为 | 追溯 |
|---|---------|---------|------|
| B-Turn-1 | 用户发送消息时，无 open Turn | 自动创建新 Turn（turnNumber = max+1, status='open'） | ← F20260714jaup UA-8 |
| B-Turn-2 | Turn 内所有消息到达终态（completed/failed） | 自动关闭 Turn（status='closed', closedAt 记录时间） | ← F20260714jaup UA-8 |
| B-Turn-3 | Turn 关闭后，被传石头的参与者发消息 | 自动创建新 Turn，新 Turn 的发言者为被传石头的参与者 | ← F20260714jaup UA-7, UA-8 |
| B-Turn-4 | 同一 Turn 内多个 Otter 并发发言 | 各自独立 startMessage -> completeMessage，互不阻塞。Turn 在所有消息终态后关闭 | ← F20260714jaup UA-7 |
| B-Turn-5 | Otter 消息 startMessage 时 | use case 自动查找当前 open Turn 关联，调用方不需要传入 turnId | ← F20260714jaup UA-8 |

#### 3.3 Turn 管理 Use Case 接口规格（供 usecases 层实现参考）

| 方法 | 说明 | 触发时机 |
|------|------|---------|
| `createTurn(conversationId)` | 创建新轮次，turnNumber = max+1 | 用户发消息时自动创建 |
| `closeTurn(turnId)` | 关闭轮次（status -> closed） | Turn 内所有消息终态时自动关闭 |
| `getActiveTurn(conversationId)` | 获取当前 open 轮次 | 发消息前检查当前 Turn |
| `getTurns(conversationId)` | 获取轮次列表 | 查询历史 |

**关键设计**：Turn 生命周期由 use case 层自动管理。调用方（interface-adapters/agent-runtime）不需要知道 Turn 的存在，不需要显式创建/关闭 Turn。这与 Snail 的 Stage 自动推进机制类似（系统管理，不由 agent 显式创建）。

---

### 4. 输入类型设计规格（供 usecases 层实现参考）

| 输入类型 | 字段 | 说明 |
|---------|------|------|
| `MessageInput`（用户消息） | senderId, body, talkingStonePassedTo, attachments? | 完整消息，创建即 completed。talkingStonePassedTo 在创建时设置 |
| `StartMessageInput`（Otter 开始） | senderId, attachments? | 无 body, 无 talkingStonePassedTo, 无 turnId |
| `CompleteMessageInput`（Otter 完成） | body, talkingStonePassedTo, attachments? | 必须提供 talkingStonePassedTo（对齐 Snail 的 to_speakers 模式） |
| `MessageEventInput` | eventType, payload | 不变 |
| `CreateTurnInput` | conversationId | 自动计算 turnNumber |

**与旧代码（F20260713e8n4）的差异**：

| 输入类型 | 旧字段 | 新增字段 | 移除字段 |
|---------|--------|---------|---------|
| `MessageInput` | senderType, senderId, body, attachments? | talkingStonePassedTo | - |
| `StartMessageInput` | senderId, attachments? | - | - |
| `CompleteMessageInput` | body, attachments? | talkingStonePassedTo（必填） | - |

---

### 5. DDL 缺口记录（供 frameworks 层实现参考）

entities 层引入了新字段和新实体，但 DDL（F20260713e8n4）未覆盖：

| 缺口 | 说明 | DDL 规格 |
|------|------|---------|
| `turns` 表 | entities 层有 Turn 实体，无对应 DDL | `CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_number INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (datetime('now')), closed_at TEXT, FOREIGN KEY (conversation_id) REFERENCES conversations(id))` |
| `messages.turn_id` 列 | entities Message 有 turnId，DDL 无 | `turn_id TEXT NOT NULL` + 外键约束 |
| `messages.talking_stone_passed_to` 列 | entities Message 有此字段，DDL 无 | `talking_stone_passed_to TEXT`（JSON array，可空） |

**索引建议**：
- `idx_turns_conversation_id ON turns(conversation_id)`
- `idx_turns_status ON turns(status)`
- `idx_messages_turn_id ON messages(turn_id)`

---

### 6. "路由" vs "发言顺序" 概念合并确认

Snail 区分了"消息路由"（`to_speakers`：谁应该接收并处理消息）和"处理顺序"（stage gates：谁在什么时候处理）。Otter 的 `talkingStonePassedTo` 将两者合并为"下一轮发言者"。

**结论**：对于 Otter 的使用场景（用户 + 多 Otter 对话），合并是合理的。所有参与者都能看到所有消息，发言石已经表达了"谁应该回应"的语义。当前不需要私有通信场景。如果未来需要，可通过新增 `visibleTo: string[] | null` 字段扩展。

---

### 7. 偏差记录

#### D-Review-1: `talkingStonePassedTo` 可空性修正

**偏差对象**：F20260714jaup entities 层 Message 类型定义 + 不变量函数

| 项目 | F20260714jaup | 本设计 |
|------|---------------|--------|
| `talkingStonePassedTo` 类型 | `string[]`（必填非空） | `string[] \| null`（可空） |
| 不变量函数 | `isValidTalkingStonePass(recipients: string[]): boolean` | 保留 + 新增 `isValidCompletedMessageTalkingStone(recipients: string[] \| null): boolean` |
| streaming 阶段 | 必须设置 talkingStonePassedTo | talkingStonePassedTo = null |
| completeMessage | 不涉及此字段 | 必须提供 talkingStonePassedTo |

**依据**：Snail Shell 的 `set_final_body(to_speakers)` 模式 -- 路由决策在最终答复时做出。Otter 消息在 streaming 阶段不可能知道传给谁，与 `body: string | null` 的模式应保持一致。

#### D-Review-2: CompleteMessageInput 新增 talkingStonePassedTo

**偏差对象**：F20260713e8n4 CompleteMessageInput

| 项目 | F20260713e8n4 | 本设计 |
|------|---------------|--------|
| CompleteMessageInput 字段 | body, attachments? | body, talkingStonePassedTo（必填）, attachments? |

**依据**：对齐 Snail 的 `set_final_body(to_speakers)` 模式。Otter 在完成消息时设置发言石传递目标。

#### D-Review-3: Turn 自动管理

**偏差对象**：无（F20260714jaup 仅定义 Turn 实体，未定义生命周期管理）

| 项目 | 本设计 |
|------|--------|
| Turn 创建 | use case 层自动创建（用户发消息时） |
| Turn 关闭 | use case 层自动关闭（所有消息终态时） |
| 调用方感知 | 调用方不需要知道 Turn 的存在 |

**依据**：对齐 Snail 的 Stage 自动推进机制。减少调用方复杂度。

## 不兼容更新 [required]

| 变更 | 说明 |
|------|------|
| `talkingStonePassedTo` 类型从 `string[]` 改为 `string[] \| null` | 不兼容类型变更，需修改 entities 层代码 |
| `CompleteMessageInput` 新增必填字段 `talkingStonePassedTo` | 不兼容接口变更，影响 usecases 层实现 |

> 以上不兼容变更在 entities 层代码修改时直接生效（代码仓完美状态原则）。DDL 变更在 frameworks 层 Issue 处理。

## 硬约束 [required]

- `talkingStonePassedTo` 在 streaming 阶段为 null，completed 阶段必须非 null 且非空
- `body` 和 `talkingStonePassedTo` 的可空性模式必须一致（streaming 时 null，completed 时非空）
- `CompleteMessageInput.talkingStonePassedTo` 为必填字段
- `StartMessageInput` 不含 `talkingStonePassedTo`、不含 `turnId`
- Turn 生命周期由 use case 层自动管理，调用方不需要显式创建/关闭
- failed 消息的 `talkingStonePassedTo` 保持 null（与 body 一致）
- 所有表使用 `CREATE TABLE IF NOT EXISTS`，禁止 ALTER TABLE
- entities 层不依赖任何外层（usecases/interface-adapters/frameworks）

## 设计取舍 [required]

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| talkingStonePassedTo 可空性 | `string[] \| null`（与 body 一致） | 保持 `string[]` 必填 | streaming 阶段无法知道传给谁，必填导致类型矛盾 |
| talkingStonePassedTo 设置时机 | completeMessage 时设置（对齐 Snail） | startMessage 时设置 | Otter 在完成生成后才决定路由目标 |
| Turn 管理 | use case 层自动管理 | 调用方显式管理 | 减少调用方复杂度，对齐 Snail Stage 自动推进 |
| 路由 vs 发言顺序 | 合并为 talkingStonePassedTo | 分离为两个字段 | Otter 场景所有消息对所有参与者可见，不需要私有通信 |
| StartMessageInput 不含 turnId | use case 自动查找 open Turn | 调用方传入 turnId | 减少调用方复杂度，Turn 是内部管理概念 |

## 关键决策记录

### KDR-1：talkingStonePassedTo 可空性修正

- **决策点**：`talkingStonePassedTo` 应该是必填还是可空？
- **正方论点（架构师-2）**：streaming 阶段的 Otter 消息不可能知道传给谁，与 `body: string | null` 模式矛盾。类型应改为 `string[] | null`
- **反方论点（F20260714jaup 原设计）**：必填非空确保发言石始终被传递
- **最终决策**：改为 `string[] | null`，streaming 时 null，completed 时必须非空
- **决策依据**：对齐 Snail 的 `set_final_body(to_speakers)` 模式。Otter 在完成生成后才决定路由目标。必填导致 streaming 阶段类型矛盾
- **参与者**：架构师-1、架构师-2

### KDR-2：Turn 自动管理

- **决策点**：Turn 生命周期由调用方显式管理还是 use case 自动管理？
- **正方论点（架构师-2）**：对齐 Snail 的 Stage 自动推进。减少调用方复杂度
- **反方论点**：显式管理更灵活，调用方可以控制 Turn 创建/关闭时机
- **最终决策**：use case 层自动管理
- **决策依据**：Turn 是内部协调机制，调用方（agent-runtime）不需要知道 Turn 的存在。自动管理减少出错可能
- **参与者**：架构师-1、架构师-2

### KDR-3：路由与发言顺序合并

- **决策点**：是否需要分离"消息路由"和"发言顺序"？
- **正方论点**：Snail 分离了 to_speakers（路由）和 stage gates（顺序）
- **反方论点**：Otter 场景所有消息对所有参与者可见，不需要私有通信
- **最终决策**：合并为 `talkingStonePassedTo`
- **决策依据**：Otter 的使用场景不需要私有通信。合并简化模型。未来需要可通过 `visibleTo` 字段扩展
- **参与者**：架构师-1、架构师-2

## 改动范围 [required]

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/entities/conversation/message.ts` | 修改 | `talkingStonePassedTo` 类型改为 `string[] \| null` + 新增不变量函数 |
| `docs/features/2026/07/14/F20260714xk8a-msg-design-review.md` | 新增 | 本文档 |

> usecases 层和 frameworks 层的改动在后续 Issue 中处理，本文档仅记录设计规格。

## 验证 [required]

### 验收标准

- [ ] `tsc --noEmit` 通过（entities 层类型修改后）
- [ ] `eslint src/entities/` 无违规
- [ ] `src/entities/conversation/message.ts` 中 `talkingStonePassedTo` 类型为 `string[] | null`
- [ ] `src/entities/conversation/message.ts` 中新增 `isValidCompletedMessageTalkingStone` 函数
- [ ] `src/entities/conversation/message.ts` 中保留 `isValidTalkingStonePass` 函数
- [ ] 无 entities/ -> 外层引用

### 测试设计

| 测试用例 | 验证点 |
|---------|--------|
| `isValidTalkingStonePass(["otter-A"])` | 返回 true |
| `isValidTalkingStonePass([])` | 返回 false |
| `isValidCompletedMessageTalkingStone(["otter-A"])` | 返回 true |
| `isValidCompletedMessageTalkingStone(null)` | 返回 false |
| `isValidCompletedMessageTalkingStone([])` | 返回 false |

## 关联 [required]

- **entities 层实现**：[F20260714jaup](./F20260714jaup-entities-layer-implementation.md)（被修正的文档）
- **消息流式模型**：[F20260713e8n4](../13/F20260713e8n4-message-streaming-model.md)（消息两层模型设计）
- **对话领域模块**：[F20260713c7p2](../13/F20260713c7p2-domain-conversation.md)（ConversationPort 接口）
- **Otter 领域模块**：[F20260713o4t8](../13/F20260713o4t8-domain-otter.md)（Agent 生命周期管理）
- **整洁架构重构**：[F20260714zjmk](./F20260714zjmk-clean-architecture-restructuring.md)（4 层架构 + 依赖规则）

## 核心业务行为 [required]

| # | 触发条件 | 预期行为 | 追溯 |
|---|---------|---------|------|
| B-Review-1 | 用户发送消息时 | `talkingStonePassedTo` 在创建时设置，status='completed' | ← UA-1, F20260714jaup UA-7 |
| B-Review-2 | Otter 消息 startMessage 时 | `talkingStonePassedTo` = null，status='streaming' | ← UA-1 |
| B-Review-3 | Otter 消息 completeMessage 时 | 必须提供 `talkingStonePassedTo`（非空数组），status='completed' | ← UA-1 |
| B-Review-4 | Otter 消息 failMessage 时 | `talkingStonePassedTo` 保持 null，status='failed' | ← UA-1 |
| B-Review-5 | completed 状态的 Message | `talkingStonePassedTo` 必须非 null 且非空（`isValidCompletedMessageTalkingStone` 校验） | ← UA-1 |
| B-Review-6 | 用户发送消息时无 open Turn | 自动创建新 Turn（turnNumber = max+1, status='open'） | ← UA-1, F20260714jaup UA-8 |
| B-Review-7 | Turn 内所有消息到达终态 | 自动关闭 Turn（status='closed', closedAt 记录时间） | ← UA-1, F20260714jaup UA-8 |
| B-Review-8 | Otter 消息 startMessage 时 | use case 自动查找当前 open Turn 关联，调用方不需要传入 turnId | ← UA-1, F20260714jaup UA-8 |
| B-Review-9 | 同一 Turn 内多个 Otter 并发发言 | 各自独立 startMessage -> completeMessage，Turn 在所有消息终态后关闭 | ← UA-1, F20260714jaup UA-7 |
