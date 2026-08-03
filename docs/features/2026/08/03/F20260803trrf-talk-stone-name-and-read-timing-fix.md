---
id: F20260803trrf
title: talk-stone-name-and-read-timing-fix
doc_type: feature

# 记忆索引
summary: |
  对话《test003》暴露两个发言石路由残留问题，合并为一个特性交付：
  Part A - speak 路由目标从 otterId 改为 otterName：F20260724tsrr 注入了
    名册（name + otterId），但 LLM 仍不复制 UUID，倾向 fallback 到 'user'。
    根治方案是让 LLM 填名字（body 与参数同表征空间），系统侧做 name->id
    resolve，名册去掉 otterId。
  Part B - markBatchRead 时序修复：markBatchRead 在 sendMessage.complete()
    关闭 turn 之后才执行，getActiveTurn 返回 null，last_read_turn_number
    永远不更新。getUnreadMessages 从初始 turn 起算，注入历史越积越多。
    改为用 msg.turnId 反查 turn_number，不依赖 active turn 状态。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260724tsrr   # 问题1在其之上：tsrr 注入名册+目标校验未根治，LLM 仍不复制 UUID
    - F20260723mk75   # 问题2的 getUnreadMessages / updateLastReadTurnNumber 由 mk75 引入

# 元数据
status: draft
change_type: fix
tags: [talking-stone, routing, speak, roster, read-receipt, turn, unread, timing]
modules:
  - src/interface-adapters/agent-runtime/tools/
  - src/usecases/conversation/
  - src/frameworks/db/conversation/
  - tests/

# 时间
created_at: 2026-08-03
---

# F20260803trrf 发言石路由残留修复：目标填名 + 已读推进时序

## 背景 [required]

对话《test003》（conversation `d3e0c469-019e-4d2a-91a2-4c5e48a1fa5a`）暴露两个问题。两者都是 F20260724tsrr「发言石路由可靠性」未根治的残留：tsrr 注入了名册让 LLM 能看到 otterId，但 LLM 行为未随之改变；tsrr 引入的 markBatchRead 机制存在时序缺陷，从未生效。

### 问题 1（Part A）：文文 body 喊大獭，talkingStonePassedTo 却传 'user'

**test003 实测**（消息 sequence 10，文文发言）：

- body 末尾：「好啦，看你们谁能接"话"字~ 大獭要不要也来秀一个？🦦🎯」--明确邀请大獭
- `talking_stone_passed_to = ["user"]`--实际交还搭档
- 文文复盘（seq 12）自认："嘴上喊的是大獭，传的却是搭档""在'让AI伙伴玩'和'让人类参与'之间摇摆了一下，最后选了 user"

**这与 F20260724tsrr 记录的问题 1 是同一现象**（tsrr 文档原话："小獭声明'传给大獭'实际却传给 user"）。tsrr 的方案是：注入名册（`- 大獭 (otterId: 0d5fabed-...)`）、历史具名标注、speak 目标校验附可用名单。**这些措施已全部上线，但 test003 仍复现**，说明方案未触达根因。

**根因：body 与 talkingStonePassedTo 的表征空间不一致。**

- body 里文文用**名字**"大獭"表达意图（自然语言表征）
- talkingStonePassedTo 要 **otterId**（`tool-factory.ts:54`："必须用 otterId 或 'user'"）
- 名册（`dispatch-chain-engine.ts:159`）同时给了 name 和 otterId，LLM 理论上能拿到 id
- 但 UUID 对 LLM 是**不可读 token**：复制一串 36 字符的 UUID 没有信心，且易错（一位之差即失效）
- `'user'` 是语义清晰、低风险、零复制成本的 fallback--摇摆时 LLM 选它

tsrr 的假设是"给 LLM otterId，它就会用"。test003 证伪了这个假设：**问题不是"拿不到 id"，而是"id 对 LLM 不可读，它没动力精确复制"**。名字是 LLM 的自然表征，body 和参数若用同一表征空间，映射错误自然消失。

### 问题 2（Part B）：注入历史条数偏大

**test003 实测**（DB 查询 `conversation_participants.last_read_turn_number`）：

| Otter | joined_at_turn_number | last_read_turn_number |
|-------|----------------------|----------------------|
| 大獭 | 0 | 0 |
| 文文 | 5 | 5 |
| 皮皮 | 5 | 5 |

三者 `last_read_turn_number` 全等于初始值（joined_at_turn_number 或默认 0），**从未被更新**。

以文文 seq 12 复盘为例（user 在 seq 11 @文文提问）：
- 文文应只收到 1 条未读（seq 11，user 提问）
- 实际 `getUnreadMessages` 返回 turn ≥ 5 且 sender ≠ 文文 = seq 6/7/9/11 = **4 条**
- 对话越长，这个数字只增不减（每次文文被 invoke 都从 join 时的 turn 5 起算）

**根因：`markBatchRead` 在 turn 关闭后才执行，`getActiveTurn` 返回 null。**

时序证据链：

1. `DispatchChainEngine.executeOneHop`（`dispatch-chain-engine.ts:92-108`）调 `invokeFn` → `agent-invoker.invokeConversation`
2. `_handlePostInvocation`（`agent-invoker.ts:176-179`）当 `msg.status === "speaking"` 时调 `sendMessage.complete()`
3. `sendMessage.complete()`（`send-message.ts:252`）调 `tryCloseTurn` → turn 被关闭（单消息 turn 满足 `allTerminal`，`turn-utils.ts:18-23`）
4. `invokeFn` 返回后，`executeOneHop` 才调 `markBatchRead`（`dispatch-chain-engine.ts:111`）
5. `markBatchRead`（`dispatch-chain-engine.ts:198`）调 `getActiveTurn` → turn 已关闭，查 `status='open'`（`sqlite-conversation-repository.ts:130`）返回 null
6. `if (!currentTurn) return`（`dispatch-chain-engine.ts:199`）→ **直接返回，不更新 last_read_turn_number**

后果：`getUnreadMessages`（`conversation-repository-mixins.ts:197`）用 `t.turn_number >= last_read_turn_number`，而 `last_read` 永远是初始值，返回从 join 起的所有非己消息，越积越多。

## 用户意图锚 [required]

| ID | 用户原话 | 关键修饰语 | 架构师解读 | 来源 |
|----|---------|-----------|-----------|------|
| UA-1 | "文文最终说的内容是传递给大獭的，但是实际to user" | 传递给大獭 / to user | body 意图与路由目标偏差，非偶发 | test003 观察 |
| UA-2 | "speak要填的id，是否ai很难理解id？那是否让填名称更好？因为正常情况下，当前在场的也不会有重名的海獭" | 很难理解 id / 填名称更好 / 不会重名 | LLM 对 UUID 不可读；名字是自然表征；唯一性有保证 | 对话推测 |
| UA-3 | "最新xx条的数量不对，刚才明显偏大了，你确认下这个数字的逻辑" | 数量不对 / 偏大 / 确认逻辑 | 注入历史条数异常，需查 getUnreadMessages 计数逻辑 | test003 观察 |
| UA-4 | "本次发现的，你要放到一个pr中一起解决这两个问题，可以分为一个特性文档中的2个part" | 一个 PR / 2 个 part | 两问题合并交付，单特性文档双 part | 对话指令 |

**UA-2 的回应**：推测正确，且根因比"难理解 id"更深一层--是 body（名字表征）与参数（id 表征）的表征空间割裂。让填名字是顺势方案，系统侧做 resolve 不让 LLM 做映射。唯一性保证：`create_otter` 已校验同名（`tool-factory.ts:170-173`），在场不重名。

## 目标 [required]

### T1（Part A）- speak 路由目标改为接受 otterName

`talkingStonePassedTo` 从「otterId 或 'user'」改为「otterName 或 'user'」。LLM 填名字（与 body 同表征），系统侧 resolve name→id。名册去掉 otterId（不再服务于 LLM 决策）。

### T2（Part B）- markBatchRead 不依赖 active turn

`markBatchRead` 改用消息的 `turnId` 反查 `turn_number`，不再调 `getActiveTurn`。发言者发言后 `last_read_turn_number` 可靠推进，`getUnreadMessages` 返回真实未读。

## 方案设计

### Part A：目标填名 + name→id resolve

| 改动点 | 位置 | 说明 |
|--------|------|------|
| 参数描述 | `tool-factory.ts:51-55` | `talkingStonePassedTo` description 改为"传该 Otter 的**名字**（不是 otterId）或 'user'，见在场成员名册" |
| 名册格式 | `dispatch-chain-engine.ts:155-163` | `- 大獭` / `- 搭档（传 'user' 交还发言权）`，去掉 `(otterId: …)` |
| speak execute resolve | `tool-factory.ts:59-87` | 收到名字数组 → 查 `getActiveParticipants` → 按 `otterName` 精确匹配 → otterId；'user' 保留不匹配 |
| 自校验 | `tool-factory.ts:70` | `recipients.includes(ctx.otterId)` 改为按当前 otter 名字校验（需 ctx 带当前 otter 名字，或查一次） |
| 错误回执 | `tool-factory.ts:76-77` | 可选名单改为纯名字：`大獭、皮皮、搭档('user')` |

**resolve 规则**：
- 精确匹配 `otterName`（区分大小写），失败返回错误附可用名单
- 'user' 是保留 token，不参与名字匹配
- 不做模糊匹配/前缀匹配--模糊匹配会让 LLM 误以为部分输入可用，反而增加不确定性
- **Unicode 归一化（防御性）**：resolve 前对名字和查询值做 NFC 归一化（处理组合字符如 e+´=é）。注意 NFC **不**统一语义相似但 codepoint 不同的字符（middle dot U+00B7/U+30FB/U+2022 经 NFC 后仍各不相同）。真正的兜底是错误回执**原样展示**可用名字--LLM 复制即用相同 codepoint，不依赖归一化

**otterName 注入方式（技术决策）**：speak execute 内从 `getActiveParticipants` 结果中按 `ctx.otterId` 找到自己的 `otterName`，不改 `ToolContext` 接口。理由：resolve 本就要查 participants，复用同一份数据零额外查询；避免 `buildCustomTools` async 化（`pi-session-factory.ts:625` 是同步方法）。

**otterId 分工（产品决策）**：
- 名册（speak 决策点）：只给名字，去掉 otterId
- `get_active_participants` 工具：**保留 otterId**，供 `invite_participant`/`dissolve_otter` 等需要 ID 的操作使用；description 明确分工："返回 otterId 和 otterName。speak 的 talkingStonePassedTo 用 otterName；invite/dissolve 用 otterId"
- `dissolve_otter`：保留 otterId 参数（低频操作，多一次 `get_active_participants` 查询是有意 friction，避免误解散）

**dissolve_otter 顺带修 participant status（预存问题）**：当前 `dissolve_otter`（`tool-factory.ts:188-208`）只调 `ctx.client.otter.dissolve`，不更新 `conversation_participants.status`。name-based 方案让 LLM 更易选中已解散 otter 的名字（名字比 UUID 更容易被选中），放大此预存风险。本特性顺带修复：`dissolve_otter` execute 内追加 `ctx.client.conversation.participant.leave`（或直接 update status='left'），保证名册和实际在场一致。

### Part B：markBatchRead 用 turnId 反查

**当前实现**（`dispatch-chain-engine.ts:194-207`）：
```ts
const currentTurn = await this.deps.sendMessage.repo.getActiveTurn(conversationId);
if (!currentTurn) return;  // ← turn 已关，永远走到这里
for (const r of results) {
  const msg = await this.deps.queryMessage.getMessageById(r.value.messageId);
  if (msg) {
    await this.deps.sendMessage.repo.updateLastReadTurnNumber(
      conversationId, msg.senderId, currentTurn.turnNumber
    );
  }
}
```

**改为**：用 msg.turnId 反查 turn_number（不依赖 active turn 状态），且 fulfilled + rejected 结果都推进已读。统一方案见下方。

**边界决策：保持 `>=`，不改 `>`**。对抗审视发现 `manage-participant.ts:99` 在 otter join 时设 `last_read = turnNumber`，意图是新加入 otter 能看到当前 turn 的所有消息（含邀请它加入的那条）。改 `>` 会让新 otter 看不到邀请消息，破坏 join 行为。同 turn 重复注入（system 消息等）量小可接受。

**rejected 也推进已读**：`markBatchRead` 当前只处理 fulfilled 结果。invoke 失败的 otter 仍收到了未读消息（`buildMessageWithContext` 已注入），若不推进 last_read，下次收到重复历史。改为 fulfilled 和 rejected 都推进：

```ts
for (let i = 0; i < results.length; i++) {
  const r = results[i];
  let messageId: string | undefined;
  if (r.status === 'fulfilled') {
    messageId = r.value.messageId;
  } else {
    /** rejected：invokeFn 抛错（罕见，agent-invoker.invokeConversation 已 catch 大部分）。
     *  用 targets[i] 反查该 otter 在本 conversation 的最新消息（发言已 start 但 invoke 失败） */
    const lastMsg = await this.deps.queryMessage.getLastMessageBySender(conversationId, targets[i]);
    messageId = lastMsg?.id;
  }
  if (!messageId) continue;
  const msg = await this.deps.queryMessage.getMessageById(messageId);
  if (!msg) continue;
  const turn = await this.deps.sendMessage.repo.getTurnById(msg.turnId);  // 新增 repo 方法
  if (!turn) continue;
  await this.deps.sendMessage.repo.updateLastReadTurnNumber(
    conversationId, msg.senderId, turn.turnNumber
  );
}
```

需新增 `ConversationRepository.getTurnById(turnId)` 和 `QueryMessage.getLastMessageBySender(conversationId, senderId)`（或复用现有 `getMessages` + 过滤）。`getActiveTurn` 调用及其 null 短路删除。

## 改动清单

### Part A
| 文件 | 改动 |
|------|------|
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | speak 参数描述改"传名字"、execute 加 name->id resolve + NFC 归一化、自校验按名字、错误回执纯名字；`get_active_participants` description 说明 otterId/otterName 分工；`dissolve_otter` execute 追加 participant status 更新 |
| `src/usecases/conversation/dispatch-chain-engine.ts` | `buildRoster` 去掉 otterId，格式 `- 大獭` / `- 搭档（传 'user' 交还发言权）` |
| `tests/interface-adapters/speak-tool.test.ts` | 用例从 otterId 改为 otterName |
| `tests/interface-adapters/http/dispatch-turn-loop.test.ts` | 名册断言去掉 otterId，断言含名字 |
| `tests/interface-adapters/create-otter-tool.test.ts` | 确认 ctx 构建不依赖 otterName 字段（不改 ToolContext） |

### Part B
| 文件 | 改动 |
|------|------|
| `src/usecases/conversation/conversation-repository.ts` | 接口加 `getTurnById(turnId)`、`getLastMessageBySender(conversationId, senderId)` |
| `src/frameworks/db/conversation/sqlite-conversation-repository.ts` | 实现上述两个方法 |
| `src/usecases/conversation/query-message.ts` | 暴露 `getLastMessageBySender`（markBatchRead rejected 路径用） |
| `src/usecases/conversation/dispatch-chain-engine.ts` | `markBatchRead` 改用 `getTurnById` 反查；fulfilled + rejected 都推进；删除 `getActiveTurn` 调用 |
| `tests/frameworks/db/conversation/sqlite-conversation-repository.test.ts` | `getUnreadMessages` 用例补充"发言后 last_read 推进"真实场景 |
| `tests/usecases/conversation/dispatch-chain-engine.test.ts`（如无则新增） | markBatchRead 在 turn 关闭后仍推进；rejected 结果也推进 |

**不改**：`conversation-repository-mixins.ts` 的 `getUnreadMessages` SQL 保持 `>=`（决策见决策记录）。

## 测试策略

### Part A
- speak 传名字 -> 正确 resolve 到 otterId -> startSpeaking 收到 otterId
- speak 传 'user' -> 原样保留
- speak 传不在场的名字 -> 错误回执附可用名单（纯名字，原样展示供 LLM 复制）
- speak 传自己名字 -> 错误（不能传给自己）
- （NFC 仅处理组合字符；middle dot 变体靠错误回执原样展示兜底，不专门测试）
- 名册格式断言：含名字、不含 otterId
- dissolve_otter 后 participant status -> left，名册不再显示该 otter

### Part B
- **回归 test003 场景**：otter 发言后 `last_read_turn_number` 推进到发言所在 turn（而非停留在初始值）
- turn 已关闭时 markBatchRead 仍能推进（核心修复点）
- `getUnreadMessages` 保持 `>=`：发言后下次 invoke 返回 turn >= last_read 的消息（含同 turn 别人消息，量小可接受）
- rejected 结果（invoke 失败）：last_read 仍推进，下次不收重复历史
- 多 otter 并发同 turn：各自 last_read 独立推进

## 风险与边界

1. **Part A 名称匹配精确性**：区分大小写。Unicode 变体（middle dot 等）靠 NFC 归一化解决。错误回执原样展示可用名字供 LLM 复制。不做模糊匹配（避免部分匹配不确定性）。

2. **Part A 向后兼容**：speak 是 LLM 专用工具，无外部 API 调用方。历史 session transcript 里的 otterId 形式不影响（不回放）。

3. **Part A dissolve_otter 顺带修的范围**：只追加 participant status 更新（status='left'），不改 dissolve 的其他逻辑。dissolve_otter 仍接受 otterId（不改契约），LLM 需先调 get_active_participants 获取 ID。

4. **Part B 同 turn 重复注入**：保持 `>=` 意味着发言者下次 invoke 会收到同 turn 里别人发的消息（如 system join 消息）。量小可接受，且这些消息重复注入无害。

5. **两 part 同 PR**：Part A 改 speak 工具契约，Part B 改 dispatch 引擎已读机制，无代码依赖。同 PR 理由：同源于 test003 一次诊断、都是 tsrr 残留、用户明确要求合并（UA-4）。

6. **Part A dissolve 跨对话 participant 残留（已知限制）**：`dissolve_otter` 只更新 `ctx.conversationId` 的 participant。若 otter 参与多对话，其他对话的名册仍显示已解散 otter。根治需 `getActiveParticipants` join `otter.status='active'`（更大范围，另立）。本特性 dissolve leave 加了 try-catch 错误隔离（leave 失败不阻断 dissolve，附警告）。

7. **Part A markParticipantLeft 审计字段**：与正式 `updateParticipantLeave` 不同，`markParticipantLeft` 不记录 `leftAtTurnId`/`leftAtTurnNumber`（dissolve 场景无特定 turn，null 合理）。审计查询"dissolved otter 在哪个 turn 离开"会得到 null。

## 决策记录（对抗审视后用户拍板）

| # | 问题 | 审视发现 | 决策 | 理由 |
|---|------|---------|------|------|
| D1 | `getUnreadMessages` 的 `>=` 改 `>`？ | `manage-participant.ts:99` 在 otter join 时设 `last_read=turnNumber`，意在让新 otter 看到当前 turn 消息（含邀请它加入的）。改 `>` 破坏此行为 | **保持 `>=`** | join 行为是 feature 非 bug；同 turn 重复注入量小可接受 |
| D2 | otterId 在名册/dissolve 中如何处理？ | get_active_participants 工具仍返回 otterId，dissolve_otter 需 otterId | **名册去 otterId，dissolve 保留 otterId** | speak 用名字、invite/dissolve 用 ID，分工明确；dissolve 低频，多一次查询是有意 friction |
| D3 | dissolved otter participant 仍 active 的预存问题 | name-based 放大风险（名字比 UUID 更易被 LLM 选中） | **本特性顺带修** | dissolve_otter execute 追加 participant status='left' 更新 |
| D4 | markBatchRead rejected 路径是否推进已读？ | invoke 失败的 otter 仍收到未读消息，不推进则下次重复历史 | **处理：rejected 也推进** | 用 targets[i] 反查该 otter 最新消息的 turnId |
| D5 | otterName 注入方式？ | buildCustomTools 是同步方法，ToolContext 加字段需 async 化 | **speak execute 内查**（技术决策） | resolve 本就要查 participants，复用同一份数据零额外查询，不改 ToolContext 接口 |
| D6 | 名字 resolve 放 speak execute 还是 startSpeaking？ | 工具层更早反馈，use case 层更集中 | **speak execute（工具层）** | 更早失败、更早反馈，LLM 可同轮重试；startSpeaking 不该承担 name->id 映射 |
| D7 | markBatchRead 移到 complete() 内部？ | complete() 是消息生命周期 use case，不该知道 dispatch 已读逻辑 | **不移动，用 turnId 反查** | 改动局部、风险小；complete() 也被非 dispatch 路径调用 |
