---
id: F20260724regd
title: sender-name-projection-and-chain-depth
doc_type: feature

summary: |
  修复两个反复出现/语义错误的缺陷（v2，经对抗审视后修订）：
  1. 实时过程中新创建小獭的名称显示为 "Otter"——根因是后端投影有损
     （MessageDTO 无发送者名称、ParticipantDTO 无类型），前端被迫多点各自
     补偿。方案是修复投影：MessageDTO 增加 senderName（查询时从 otters 表
     解析，dissolve 不删行故永远可解析）、ParticipantDTO 增加 otterType，
     前端删除所有补偿补丁，名称统一来自 DTO。
  2. 发言链第 5 跳后静默中断——根因是 dispatchTurnLoop 硬编码 depth < 5。
     方案是配置化为 circuitBreaker.maxChainDepth（默认 20，可选构造参数），
     触顶时显式落地（warn 日志 + system.message 交还用户），未读机制保证可续接。

causal_links:
  from:
    - F20260723mk75

status: draft
change_type: fix
tags: [sender-name, dto, projection, sse, contract, talking-stone, chain, circuit-breaker]
modules:
  - api-contract/
  - src/interface-adapters/http/
  - src/frameworks/
  - web/src/pages/conversation/
  - web/src/lib/
  - config/
  - tests/

created_at: 2026-07-24
---

# F20260724regd 发送者名称投影修复 + 发言链深度治理

> v2 修订说明：v1 方案为前端 OtterRegistry（身份注册表 + 参与关系分离）。
> 对抗审视（B1/S3 发现）结合"前端是后端状态的投影"原则将其证伪——registry
> 是在补偿有损的后端投影，且"全量 DTO 丰富条目"的路径在 API 层不存在。
> v2 改为修复投影本身，前端改动更小、无新增状态同步面，reload/已解散场景
> 自然解决。修订记录见文末。

## 术语定义

| 术语 | 定义 |
|------|------|
| **投影（Projection）** | 后端状态向前端 DTO 的映射；原则：前端是后端状态的投影，投影有损必补而非前端补偿 |
| **senderName** | MessageDTO 新增字段，otter 消息发送者的显示名，查询时从 otters 表解析 |
| **发言链 / dispatchTurnLoop** | Turn 级调度循环：派发一批 otter → 等待全部完成 → 聚合发言石 → 派发下一轮 |
| **跳（hop）** | dispatchTurnLoop 的一次迭代；一批多 otter 并行只计 1 跳；speak 重试不耗跳（同一跳内递归） |
| **maxChainDepth** | 每条用户消息允许的最大接力跳数（安全阀），归入 circuitBreaker 配置族 |
| **契约裂缝** | SSE 事件实际负载与 api-contract/sse/events.ts 类型声明不一致的字段 |

## 背景

### 问题 1：实时过程中小獭名称显示 "Otter"（复发型）

t01 对话实测：大獭通过 `create_otter` 拉入小獭后，小獭的**已完成**消息在实时过程中显示为 "Otter"，直到整个流结束才恢复。该问题此前已被报告并修复过至少一次，本次复发。

**根因（后端投影有损 + 前端多点补偿）**：

- 前端 `allOtters[convId]` 只在打开对话和流结束（onDone）时加载，流中途创建的小獭落在盲区
- 各消费方各自打补丁，修一处漏一处：

| 渲染路径 | 补偿措施 | 现状 |
|------|------|------|
| 流式气泡 StreamingMessage（MessageList.tsx:349） | `state.otterName` 兜底（上次修复） | ✅ |
| 历史气泡 MessageItem（MessageList.tsx:166） | 无兜底，只查 otters 列表 | ❌ |
| message.aborted 处理器（index.tsx:248-254） | 补丁塞 allOtters（上次修复） | ✅ |
| message.complete / message.failed 处理器 | 无补丁 | ❌ |
| 刷新后已解散小獭的历史消息 | 无（getActiveParticipants 只回 active） | ❌ 审视新发现 |

**为什么反复**：N 个故障点，每次修 1 个。前端在补偿一个有损投影——MessageDTO 不携带发送者名称，迫使每个渲染点自行解析。

**关键事实**（决定方案选型）：`dissolve` 只标记状态不删除 otter 行（dissolve-otter.ts:45，deleteOtter 仅用于创建失败的补偿路径），因此**发送者名称在查询时永远可从 otters 表解析**，包括已解散的小獭。

**伴随的契约裂缝**（4 处，审视 S2 补全）：

| 事件 | 实际在发在用 | 契约缺失字段 |
|------|------|------|
| message.start | agent-invoker.ts:143 发、index.tsx:166 用 | `otterName` |
| message.complete | agent-invoker.ts:271-281 发、index.tsx:219-222 用 | `body`、`turnId` |
| message.failed | agent-invoker.ts:355,380 发、index.tsx:275 用 | `body` |
| message.aborted | agent-invoker.ts:317 发、index.tsx:258 用 | `body` |

### 问题 2：发言链第 5 跳后静默中断

"成语接龙六轮"实测：depth 1-5 依次为大獭→小獭→大獭→小獭→大獭，第 5 跳正常完成后循环静默退出，第 6 轮永不派发。无日志、无事件、无用户反馈。

**根因**：`message-controller.ts:114` 硬编码 `depth < 5`。由 88c7185（adversarial review 修复）引入，初衷是**防 agent 互相接力失控的安全阀**（与 circuitBreaker 同源直觉），但实现有三层混淆：

1. **语义越权**：发言链有天然终止语义（发言石传回用户/目标为空）；depth=5 嵌入了"每条用户消息合法接力 ≤ 5 跳"的语义假设——六轮接龙、辩论、多轮评审流都会击穿
2. **不可观测**：触顶静默退出，与故障无法区分
3. **边界如实记录**（审视 A2/A3）：depth 每条用户消息重置，失控链可以 20 跳为单位无限续命；一批 N 只 otter 并行只计 1 跳，扇出不受阀限制；speak 重试在同一跳内递归（agent-invoker.ts:363-367），每跳最多 2 次完整 agent 调用。它是"每跳数"阀，不是成本阀

**结论**：直觉正确（接力必须有界），实现错误（魔法数字、硬编码、静默、语义越权）。

## 方案设计

### 问题 1：修复后端投影，前端删除补偿

**1. MessageDTO 增加 senderName**（api-contract/api/message.ts）

- 字段名 `sn`（遵循现有 st/si/ts/dur/seq/tsp 短键约定），otter 消息为显示名；user/system 消息省略
- 解析点：`message-controller.ts` 的 `list()` 与 `getById()`——收集消息中唯一 otter senderId，经 `queryOtter.getById` 批量解析（Promise.all；list 上限 50 条，量级可接受），注入 `toMessageDTO(msg, senderName)`
- MessageController 构造器新增 `queryOtter` 依赖（main.ts:199 已有实例，装配传入）
- dissolve 不删行 → 历史消息（含已解散小獭）名称永远正确，**reload 盲区随之消除**

**2. ParticipantDTO 增加 otterType / roleName**（api-contract/api/conversation.ts）

- conversation-controller.ts:96-97 处 otter 实体现成（participantsWithOtter），零额外查询
- 前端 index.tsx:109 构建参与者条目时填入真实 type/role——顺带修复 RightPanel.tsx:203,214 依赖 `o.type`/`o.role?.name` 的既有 latent bug（当前参与者条目无 type，大獭可能误渲染）

**3. 前端：删除补偿，统一从 DTO 取名称**

- `LocalMessage` 增加 `sn?: string`；`mapMessageDTO` 映射
- SSE 完成类处理器（complete/failed/aborted）构造 finalMsg 时 `sn: streamingEntry?.otterName`——streamingEntry 来自 message.start，时序保证先于一切渲染
- `MessageItem`：`name = isUser ? '我' : (m.sn || otter?.name || 'Otter')`——otters 查询仅保留用于 ci/color
- `StreamingMessage`：维持 `otter?.name || state.otterName || 'Otter'`（审视 A1 已验证时序安全：message.start handler 内 setAllOtters + setStreamingMap 在 React 19 自动批处理下同帧提交）
- **删除** aborted 处理器特判补丁（index.tsx:248-254），替换为 message.start 单一站点：otterId 不在 `allOtters[activeId]` 时 append `{id, name, type?}`（**fill-only，永不覆盖已有条目**——防后端 `?? otterId` 兜底把 UUID 当好名字写入；全仓库无改名 API，不考虑改名场景）
- allOtters 保持 per-conv 结构不变——参与关系隔离（mk25）不受影响，无 LeftPanel/sessions 回归

**4. 契约对齐**（api-contract/sse/events.ts）：补齐上表 4 处缺失字段。同时 web 构建加入类型检查（web/package.json：`"build": "tsc --noEmit && vite build"`，web/tsconfig.json 已存在且 strict）——否则"编译期约束"在前端无执行载体（审视 S4：index.tsx:109 违反 LocalOtter 必填字段却通过构建即为实证）。

### 问题 2：depth 配置化 + 触顶显式落地

**1. 配置化**（src/frameworks/config-service.ts + config/config.yaml.example）：

```yaml
circuitBreaker:
  # 每条用户消息允许的发言链接力最大跳数（默认 20）
  # 安全阀：防 agent 互相接力失控；合法多轮协作不应触达
  # 注意：按"每条用户消息"计数，用户发新消息后重置；并行扇出不额外计跳
  # 触顶时系统向对话注入提示消息，发言石交还用户
  maxChainDepth: 20
```

默认值 20 是**安全量级而非语义假设**：覆盖已知合法场景（六轮接龙=6 跳、评审流），失控成本有界（20 跳 × 每跳最多 2 次 agent 调用 × maxToolCalls=40 工具调用）。可在 config.yaml 调优。

**2. 注入**：MessageController 构造器新增**可选**参数 `maxChainDepth = 20`（默认参数，既有 4 参实例化的测试不破——审视 B3）；main.ts 装配传入配置值。

**3. dispatchTurnLoop 触顶落地**（message-controller.ts）：

```ts
while (targets.length > 0 && depth < this.maxChainDepth) { /* 不变 */ }

if (targets.length > 0) {
  this.logger.warn('发言链达到深度上限，交还用户', { depth, pendingTargets: targets, conversationId });
  const sysMsg = await this.sendMessageUseCase.sendSystem(
    conversationId,
    `发言接力已达系统安全上限（${this.maxChainDepth} 跳），发言石交还给你。直接回复即可继续——所有参与者会看到未读消息。`,
  );
  push({ event: "system.message", data: { messageId: sysMsg.id, content: sysMsg.body } });
}
```

**续接机制（如实描述边界）**：被裁 targets 未读到上一跳消息（lastReadTurnNumber 未推进），用户下次发言时 `getUnreadMessages`（turn 维度）带回未读。**边界**：该机制依赖用户默认发送路径（handleSend 发给全部 activeOtters）；@单只獭时被裁目标本轮不续接——可接受，触顶本身是异常路径。

**sendSystem 的 turn 副作用（已验证无害，审视 A4）**：sendSystem 创建仅含系统消息的新 turn 且不调用 tryCloseTurn，该 turn 保持 open 直到下一条用户消息并入；terminal 判定与前端 system.message handler 均兼容（speak 重试路径 agent-invoker.ts:357-360 已在用同机制）。

## 决策记录

| 决策点 | 选项 | 结论 | 理由 |
|------|------|------|------|
| 名称来源 | A. 前端 OtterRegistry 缓存（v1） | **B. 后端 DTO 携带 senderName** | 前端是后端状态的投影，投影有损应修投影而非前端补偿；dissolve 不删行使查询时解析永远可行；B 无新增状态同步面，reload/解散场景自然解决；A 的"全量 DTO 丰富条目"路径在 API 层不存在（审视 B1 证伪） |
| 新獭参与关系注册 | A. complete/failed/aborted 各处理器补丁 | **B. message.start 单一站点 ensure（fill-only）** | SSE 时序保证 start 先于一切渲染；一处覆盖全路径；fill-only 防 `?? otterId` 兜底覆盖好名字（审视 S1） |
| senderName 解析位置 | A. QueryMessage usecase 改返回投影 | **B. Controller 层经 queryOtter 解析** | usecase 返回实体保持纯净；manage-participant 的投影模式是针对参与者场景的既有先例，消息场景 DTO 组装本就在 controller |
| MessageController 新依赖 | A. 全部可选参数 | **B. queryOtter 必填 + maxChainDepth 可选(默认20)** | queryOtter 是功能必需，必填防漏装配，测试同步更新；maxChainDepth 可选保持既有测试兼容（审视 B3） |
| 深度上限 | A. 删除限制 | **B. 配置化默认 20** | LLM 礼貌接力失控是真实失效模式；默认值是安全量级而非语义裁决 |
| 触顶行为 | A. 静默退出 | **B. warn 日志 + system.message 交还用户** | 与 speak 二次失败"控制权交还人类"的设计哲学一致；不可观测的安全机制与故障无法区分 |
| per-conversation 成本预算 / token 预算 | A. 本次实现 | **B. 后续增强** | 与 depth 正交；需跨消息聚合状态，另立 feature（审视 A2c/A3 记录边界即可） |

## 改动清单

| 文件 | 改动 |
|------|------|
| `api-contract/api/message.ts` | MessageDTO + `sn?: string` |
| `api-contract/api/conversation.ts` | ParticipantDTO + `otterType`、`roleName?` |
| `api-contract/sse/events.ts` | message.start + otterName；message.complete + body/turnId；message.failed + body；message.aborted + body |
| `src/interface-adapters/http/dto/message-dto.ts` | toMessageDTO(msg, senderName?) 注入 sn |
| `src/interface-adapters/http/dto/conversation-dto.ts` | toParticipantDTO 透传 otterType/roleName |
| `src/interface-adapters/http/controllers/message-controller.ts` | 构造 + queryOtter、maxChainDepth=20；list/getById 批量解析 senderName；触顶 warn + system.message |
| `src/interface-adapters/http/controllers/conversation-controller.ts` | participants 端点透传新字段 |
| `src/frameworks/config-service.ts` | circuitBreaker + maxChainDepth（默认 20） |
| `config/config.yaml.example` | maxChainDepth 注释说明（含 per-message 重置/扇出语义） |
| `src/main.ts` | 装配传入 queryOtter、maxChainDepth |
| `web/src/lib/mappers.ts` | LocalMessage + sn；mapMessageDTO 映射；参与者条目带 type/role |
| `web/src/pages/conversation/index.tsx` | message.start ensure 参与者（fill-only）；complete/failed/aborted 设 sn；删 aborted 特判；参与者映射填 type |
| `web/src/pages/conversation/MessageList.tsx` | MessageItem 名称主源改 m.sn |
| `web/package.json` | build 前置 `tsc --noEmit` |
| `tests/api/helpers.ts`、`tests/interface-adapters/controllers.test.ts` | MessageController 5 参实例化适配（审视 B3） |
| `tests/interface-adapters/http/dispatch-turn-loop.test.ts` | 新增：触顶/正常终止测试（项目 lint 禁 mock 调用断言，用闭包状态断言） |
| `tests/frameworks/config-service.test.ts`、`tests/interface-adapters/dto.test.ts` | maxChainDepth、sn、otterType/roleName、userFlagged 断言 |

## 实施偏差记录（tsc 门禁暴露的既有契约漂移，随本 feature 一并修复）

启用 web `tsc --noEmit` 后暴露 12 处 pre-existing 类型错误（vite 不做类型检查故长期潜伏）。除 memory 页 `userFlagged` 外均为小修；memory 属同类投影有损（实体有 layer/userFlagged 而 DTO 未投影），一并修复：

| 文件 | 修复 |
|------|------|
| `web/src/api/client.ts` | 补 MessageEventDTO 导入 |
| `web/src/lib/mappers.ts` | mapConversationDTO 兼容 ConversationDTO（otterIds 缺省） |
| `web/src/components/Modal.tsx` | isOpen 改可选（默认常开）；ModalButton + disabled |
| `web/src/pages/conversation/ExecutionHistoryModal.tsx` | size="lg" → width="640px"（Modal 无 size prop） |
| `api-contract/api/memory.ts` + `memory-dto.ts` + `search-memory.ts` | MemoryEntryDTO + layer + userFlagged（rerankAndReturn 从 MemoryWeight 带出） |
| `web/package.json` | + @types/react-syntax-highlighter |
| `message-controller.ts` | max-params 豁免注释（沿用 AgentInvoker 先例）；markBatchRead/handleChainDepthExceeded 提取（complexity ≤ 12） |

## 测试计划

**单元测试**：

- config-service：maxChainDepth 默认值 20、yaml 覆盖生效
- dispatchTurnLoop 触顶（mock agentInvoker 使发言石互传）：maxChainDepth=2 时第 3 跳不派发、sendSystem 被调用、push system.message、warn 日志；targets 自然为空时不发 system.message
- toMessageDTO：otter 消息带 sn；user/system 消息省略 sn
- toParticipantDTO：otterType/roleName 透传
- message-dto/controller：dissolved 状态 otter 的名称仍可解析（repo 桩返回 dissolved otter）

**手工验收**：

1. 重放 t01 场景：成语接龙六轮 → 六跳全部完成，小獭第 6 轮正常发言
2. 实时观察：小獭流式中、发言完成、speak 重试 failed 消息的名称全程显示 "小獭"，无 "Otter" 闪现
3. 刷新页面：历史消息名称正确；解散小獭后刷新，其历史消息名称仍正确（v1 registry 方案无法覆盖，本方案的关键增益）
4. config.yaml 临时设 maxChainDepth: 2 → 触顶出现系统消息，回复后未读消息被带入、游戏续接
5. @提及列表：小獭创建后立即可 @，无重复项
6. `npm run build`（根 + web）通过——契约类型与前后端实际负载互锁

## 验收标准

- [ ] 六轮接龙完整跑完，无静默中断
- [ ] 流式/完成/失败/刷新后/已解散五种形态的名称全部正确
- [ ] maxChainDepth 可配置，触顶有 warn 日志 + 对话内系统消息
- [ ] SSE 契约与 REST DTO 类型同实际负载一致，web `tsc --noEmit` 纳入构建
- [ ] 全部既有测试通过（含 helpers/controllers 适配），新增测试覆盖触顶与 DTO 新字段

## 修订记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1 | 2026-07-24 | 初版：前端 OtterRegistry（身份/参与关系分离）+ depth 配置化 |
| v2 | 2026-07-24 | 对抗审视后修订：B1（"全量 DTO 丰富条目"路径不存在）+ S3（reload 盲区）+ "前端是后端状态的投影"原则证伪 registry，改为修后端投影（MessageDTO.sn / ParticipantDTO.otterType）；B2 随 registry 放弃而消失；B3 maxChainDepth 改可选参数；S1 fill-only；S2 契约补全至 4 处；S4 web 构建加 tsc --noEmit；修正 mk75→mk25 归因错误；"轮"统一为"跳"；成本口径补充重试与扇出维度 |
