---
id: F20260824snrs
title: sender name 单一真相源架构重构
summary: |
  发言名字显示 "Otter" 五次回归的架构级根治方案。核心：Message 实体持久化 senderName（创建时解析一次），
  收敛层 resolveSpeakerName() 统一所有运行时解析，前端 resolveDisplayName() 消费本地 name + '我'/'系统'。
  三层各自唯一负责，otter 行不存在时 fallback 到 senderId（永不落入 'Otter'）。
change_type: refactor
status: draft
capability_test: "n/a: 纯代码/数据模型改动（A 类），无 LLM 参与行为"
created_in_conversation: 0d2efc85-ee7b-49aa-bd05-c114ba9fe817
---

# sender name 单一真相源架构重构

## 背景

> 搭档原话（意图锚）：「今天我又看到Otter问题了！！！！！见对话《重启一直在重复的Bug》中《Otter 2026-08-24 15:12:31 · 129.8s》发言！！！你拉上glm和kimi再来排查清楚！要从本质上解决！不要打补丁！」

"发言名字显示 Otter" 已回归 5 次。8/21《sender name fallback 统一修复》文档明确记录了当时的决策：「**不抽取 resolveOtterName 函数——4 处改动足够止血，架构层面的统一抽取留后续（后续如再回归再做）**」。本次第 5 次回归恰好触发该预留条件。

### 五次回归史

| # | 时间 | PR/文档 | 修的路径 | 遗漏 |
|---|---|---|---|---|
| 1 | ~7/24 | F20260724regd | invocation hang 修复附带 sender-name 修复 | 别的路径 |
| 2-3 | 8 月初 | PR #325 | speak.intermediate 添加 otterName | fallback 仍不一致 |
| 4 | 8/21 | fallback 统一修复 | 5 事件 fallback 对齐 + 前端保留 sn | 自重启循环期间 otter 查询结果异常 |
| 5 | 8/24 15:12 | PR #387（晚 9 分钟合入） | 自重启循环本身 | display 层 'Otter' fallback 仍在 |

### 根因（架构层）

sender name 没有单一真相源，8+ 个路径各自解析、各自 fallback：

**后端运行时（SSE 事件，11 处解析点）**：
- `agent-invoker.ts:132` message.start：`otter?.name ?? otterId`
- `agent-invoker.ts:381` speak.intermediate：`otterName ?? otterId`
- `orchestrator.ts:201/263` message.complete（2 处）：`otter?.name ?? input.otterId`
- `orchestrator.ts:382/431/493/542/560` message.failed（5 处）：`otter?.name ?? ctx.input.otterId`
- `orchestrator.ts:464` retry 的 message.start：`otter?.name ?? ctx.input.otterId`
- 每处事件前还要重新 `await getOtterById(otterId)` 查一次库

**后端 API 路径（3 处）**：
- `message-controller.ts:30` resolveSenderNames()（批量，list/getById/listAfter/expand 复用）
- `message-controller.ts:86-98` subscribe() callback（单条；user→"我"，system→"系统"，otter 无 fallback）
- `feishu-message-channel.ts:117`（飞书路径，独立 resolve，`otter?.name ?? message.senderId`）

**前端（3 个 SSE handler + 2 个收敛路径 + 1 个显示层）**：
- `index.tsx:415/686/965` 三个 handler 的 message.start 各自创建 sn
- `index.tsx:283/915` refreshMessages / stopStream 用 serverMsg 覆盖（8/21 修过：保留本地 sn）
- `MessageList.tsx:396` 最终显示：`const name = isUser ? userDisplayName : (m.sn || otter?.name || 'Otter')`

每修一个点，另一个点在 otter 查询失败/缓存未热时落进 `'Otter'`。**问题不是哪一条链路漏了，而是"名字"根本不是消息的一等公民字段——它是 8+ 个消费点各自查询的事后拼装。**

## 目标

- T1: sender name 有单一真相源（单一来源原则）
- T2: 新增 SSE 事件或前端 handler 时，结构上不可能遗漏 sn（加事件/handler 不需要记得带名字）
- T2a: 新增消息创建路径时默认携带 senderName，无需每处手写 fallback
- T3: restart/circuit-break/自重启场景 name 不丢失
- T4: 历史消息（刷新、分页）name 正确
- T5: 显示层永不落入 'Otter' 字面量——所有路径的 fallback 终点是 senderId（可追溯、可修复）

## 非目标

- 不改 otter 改名（rename）的实时推送机制——改名后历史消息名称不回填，见「设计取舍 #4」
- 不动 message events / segments 机制
- 不做用户自定义昵称体系
- 不修飞书通道同名问题（feishu-message-channel.ts:117 同模式，列入迁移清单但不阻塞本方案）
- 不解决非消息气泡场景的 "Otter" 显示（若有，同样受益但不在验证范围）

## 方案设计（推荐方案 D：三层单一真相源）

### 核心思想

让"名字"成为消息的持久属性，而不是 8+ 个消费点的查询拼装。三层结构：

```
层 1（真相源）：Message 实体 + messages 表
  senderName 持久化（创建时解析一次，事实发生时间快照）
  兜底：senderId（永不空、永不 'Otter'）

层 2（收敛）：后端单一解析函数 resolveSpeakerName() + 事件统一携带
  所有 SSE 事件 / DTO 输出前统一走这一个函数

层 3（显示）：前端单一 resolver resolveDisplayName()
  消费已解析的名字；'我'/'系统' 字面量只在此层出现
```

### 层 1：Message 实体持久化 senderName（方案 A）

**数据模型变更**：

```
messages 表新增列：sender_name TEXT NOT NULL DEFAULT ''
```

**实体变更**（`src/entities/conversation/message.ts`）：

```ts
export interface Message {
  // ...既有字段
  /** 发送者显示名快照（事实发生时间解析）。空串 = 未解析（历史行），读取时走层 2 实时解析。 */
  senderName: string;
}
```

**解析时机**：创建消息时解析一次并持久化（fact-time snapshot）。自重启场景重启的是 session 而非 otter 行，创建时解析不会失败；即使 otters 表异常，持久化 senderId 作为快照。

**规则**：

| ID | 规则 |
|---|---|
| R1-1 | 创建时若无法解析（otter 查不到且非 user/system），持久化 senderId 本身 |
| R1-2 | 读取时 senderName 为空串（历史行）→ 走层 2 实时解析 |
| R1-3 | otter 改名后不回填历史（讨论记录是事实快照） |

**迁移**：`migration.ts` 加 `ALTER TABLE messages ADD COLUMN sender_name TEXT NOT NULL DEFAULT ''`（幂等，参照既有 source 字段迁移模式 migration.ts:24-29）。旧消息空串 → 读取时实时解析（otter 行 dissolve 不删，永远可解析，与 resolveSenderNames 注释一致）。

**创建路径统一**：`SendMessage.start()`（send-message.ts:166）解析并写入 senderName。所有 otter 消息创建必经此处（invoker 首次、orchestrator retry、自重启循环的新消息），是天然收口点。**这是 T2a 的关键——未来新增消息创建路径默认继承保障**。

用户/系统消息：`SendMessage` 另有 user/system 创建入口（execute/系统消息路径），同样在此处写入 "我"/"系统"？——不。"我" 是前端概念（后端不知道 userName），user 消息 senderName 留空串由前端层 3 处理；system 消息已有专用渲染分支（MessageList.tsx:380-388），无需名字。层 1 只为 otter 消息服务。

### 层 2：后端统一解析函数（方案 B）

新增 `src/usecases/conversation/speaker-resolver.ts`：

```ts
import type { SenderType } from "@entities/conversation/message";

/**
 * 发送者显示名统一解析（层 2 收敛点）。
 * - otter：优先已解析名（持久化快照或查询结果），fallback 终点是 senderId
 * - user/system：返回 null——显示名是前端概念，交层 3
 */
export function resolveSpeakerName(
  senderType: SenderType,
  senderId: string,
  otterName?: string | null,
): string | null {
  if (senderType !== "otter") return null;
  return (otterName ?? "").trim() || senderId;
}
```

**收敛点（11 处 SSE 解析替换）**：

| # | 位置 | 现状 | 改为 |
|---|---|---|---|
| 1 | agent-invoker.ts:132 | `otter?.name ?? otterId` | `message.senderName`（快照直读） |
| 2 | agent-invoker.ts:381 | `otterName ?? otterId` | `resolveSpeakerName("otter", otterId, otterName) ?? otterId` |
| 3-4 | orchestrator.ts:201/263 | `otter?.name ?? input.otterId` | `message.senderName` |
| 5-9 | orchestrator.ts:382/431/493/542/560 | `otter?.name ?? ctx.input.otterId` | `resolveSpeakerName("otter", otterId, otter?.name) ?? otterId`（保留单次查询，删重复 fallback 表达式） |
| 10 | orchestrator.ts:464 | retry message.start | `newMsg.senderName` |
| 11 | feishu-message-channel.ts:117-118 | `otter?.name ?? message.senderId` | `resolveSpeakerName(...)` |

**API 路径收敛**：

- `message-controller.ts:30 resolveSenderNames()`：内部改用 `resolveSpeakerName`（批量逻辑保留，fallback 统一）
- `message-controller.ts:86-98 subscribe()`：otter 分支改用 `resolveSpeakerName`；user/system 分支删除字面量（返回 undefined，DTO 不带 sn，层 3 处理）
- `toMessageDTO`（message-dto.ts:41）：优先取 `msg.senderName`，为空串再取参数 senderName——新旧数据统一

**SSE 契约不变**（api-contract/sse/events.ts）：事件仍携带 otterName 字段，但语义从「各路径自行拼装」变为「层 2 统一输出」。契约文件加注释标注来源为 resolveSpeakerName。

### 层 3：前端统一 resolver（方案 C）

新增 `web/src/pages/conversation/display-name.ts`：

```ts
/** 显示名统一解析（层 3）。'Otter' 字面量在此终结。 */
export function resolveDisplayName(
  m: Pick<LocalMessage, 'sn' | 'si' | 'st'>,
  otters: Array<{ id: string; name?: string }>,
): string {
  if (m.st === 'user') return '';           // 调用方用 userDisplayName（userName 来自用户设置）
  if (m.st === 'system') return '';          // system 有专用渲染分支
  const sn = (m.sn || '').trim();
  if (sn) return sn;
  const cached = otters.find(o => o.id === m.si)?.name;
  return (cached && cached.trim()) ? cached : m.si;  // fallback 终点：senderId，永不 'Otter'
}
```

**消费点收敛（3 handler + 2 收敛 + 1 显示）**：

| # | 位置 | 改动 |
|---|---|---|
| 1 | MessageList.tsx:396 | `m.sn \|\| otter?.name \|\| 'Otter'` → `resolveDisplayName(m, otters)` |
| 2-4 | index.tsx:415/686/965 三 handler | message.start 的 sn 直接存 `otterName`（后端已保证非空，仍防御 `otterName || otterId`） |
| 5-6 | index.tsx:283/915 | `sn: serverMsg.sn \|\| m.sn` 保留（8/21 修复成果，兼容） |

**结构保障（T2）**：显示层只有一个 name 解析函数。新 handler 忘记设 sn 时，resolver 落到 otters 缓存或 senderId——**漏掉 sn 不再等于显示 'Otter'**。

### 组合逻辑（为什么是 D 不是单独 A/B/C）

| 方案 | 解决 | 单独用为什么不够 |
|---|---|---|
| A 持久化 | T1/T4（历史消息）、T2a（新创建路径） | 运行时 SSE 事件仍各自拼装，新事件仍会漏 |
| B 后端收敛 | T2（新事件）、T3（自重启场景统一查询点） | 历史消息行没有快照，API/前端仍多路径 |
| C 前端 resolver | T5（永不 'Otter'）、T2（新 handler 防漏） | 后端仍乱，DTO 质量不稳定，前端 fallback 链仍长 |

三层缺一不可：A 保证"名字跟着消息走"，B 保证"运行时输出来自一个函数"，C 保证"显示只有一个入口"。

## 影响范围

| 模块 | 影响 | 风险 |
|---|---|---|
| DB schema | messages 表加列 | 低：幂等迁移，默认空串 |
| Message 实体 | 加必填字段 | 中：所有 Message 构造点需补字段（编译器兜底）；约 15 处（含测试） |
| SendMessage.start | 解析并写入 senderName | 低：加一个参数/一次查询 |
| agent-invoker / orchestrator | 11 处表达式替换 | 低：行为等价（fallback 同为 otterId） |
| message-controller | 3 处收敛 | 低：DTO 输出兼容 |
| feishu-message-channel | 1 处 | 低 |
| 前端 index.tsx | handler sn 初始化 | 低：不改逻辑只统一 |
| MessageList.tsx | name 解析换函数 | 低：显示行为仅在「原本显示 Otter」的异常场景变为显示 senderId |
| SSE 契约 | 无 breaking（otterName 语义收敛） | 无 |

## 风险与约束

- **R-1 字段膨胀**：senderName 冗余存储（可用 join 取得）。约束：单字段 TEXT，消息表本就带 senderId 冗余，可接受；换来的是 dissolve/改名场景的确定性。
- **R-2 迁移窗口**：旧消息空串依赖实时解析，若 otter 行真被物理删除则显示 senderId（现状显示 'Otter'，反而更好）。
- **R-3 前端旧缓存**：刷新前的 LocalMessage 无 sn → resolver 落 otters 缓存/senderId，不劣于现状。
- **R-4 测试面**：Message 构造点需批量补字段，防止测试假数据误触发层 2 解析路径。

## 不兼容更新

无 breaking API 变更。DB 迁移向后兼容（新列默认空串，旧代码读不到新列也不受影响）。

## 设计取舍

| # | 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|---|
| 1 | 持久化 vs 实时 join | 持久化快照 | 读取时 join otters 表 | 快照不依赖 otter 行存活；rename 后历史保留旧名是「讨论记录 = 事实」的语义；join 无法覆盖 SSE 运行时路径 |
| 2 | fallback 终点 | senderId（UUID） | 'Otter'（现状）/ 空串 | UUID 可定位具体 otter（可修复、可追溯）；'Otter' 不可追溯——本次 5 次回归的排查成本正源于此 |
| 3 | user 显示名 | 前端解析 | 后端解析存库 | 后端不知道 userName（用户设置在前端）；"我" 是视角概念，多端可能不同 |
| 4 | rename 回填 | 不回填 | 触发 UPDATE messages | 事实快照语义 + 避免大批量回填写放大；如需「显示当前名」可后续加查询参数切换 |
| 5 | 改动范围 | 一次性三层落地 | 分期（先 B 后 A） | B 单独落地仍是「修路径」思路；三层互相支撑，拆开每层价值都打折。风险用「行为等价替换 + 测试」控制 |
| 6 | feishu 通道 | 本期一并收敛 | 留后续 | 同模式同函数，顺手收敛防止第 6 次回归从飞书冒出来 |

## 验证

**验收标准**：

| ID | 条件 | 验证方法 |
|---|---|---|
| AC-1 | `grep -rn "'Otter'" web/src` 仅剩注释/测试 | 代码审查 |
| AC-2 | `resolveSpeakerName` / `resolveDisplayName` 是唯一解析点（grep otterName 拼装表达式归零） | 代码审查 |
| AC-3 | 自重启循环场景：消息 name 全程正确 | 集成测试模拟 restart 循环（复用 F20260824srst 场景）+ 手工触发 |
| AC-4 | 历史消息刷新/分页 name 正确（含 dissolve 的 otter） | 单测：senderName 空串行 → 实时解析路径 |
| AC-5 | 全量测试通过 | `npx vitest run` + web 构建 |
| AC-6 | 5 个 SSE 事件的 otterName 全部来自 resolveSpeakerName 或快照 | 单测逐事件断言 |

**回归测试设计（针对性）**：
1. 单测：resolveSpeakerName 四分支（otter 有名/无名/user/system）
2. 单测：toMessageDTO 快照优先级（senderName 快照 > 参数 > 无）
3. 集成：invokeConversation 全流程中 message.start/complete/failed 的 otterName 断言
4. 迁移测试：空串行读取走实时解析

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/entities/conversation/message.ts | 改 | Message 加 senderName 字段（+注释语义） |
| src/frameworks/db/schema.ts | 改 | CREATE TABLE 加列（新装环境） |
| src/frameworks/db/migration.ts | 改 | 幂等 ALTER TABLE（存量环境） |
| src/frameworks/db/conversation/sqlite-conversation-repository.ts | 改 | INSERT/SELECT 行映射补字段（~195-240、~530） |
| src/usecases/conversation/speaker-resolver.ts | 增 | 层 2 统一函数 |
| src/usecases/conversation/send-message.ts | 改 | start() 解析写入 senderName（:166 起） |
| src/interface-adapters/agent-runtime/agent-invoker.ts | 改 | :132/:381 换快照/函数 |
| src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts | 改 | :201/263/382/431/464/493/542/560 换快照/函数 |
| src/usecases/im/feishu-message-channel.ts | 改 | :117 换函数 |
| src/interface-adapters/http/controllers/message-controller.ts | 改 | :30/:52/:86-98 收敛到统一函数 |
| src/interface-adapters/http/dto/message-dto.ts | 改 | toMessageDTO 快照优先 |
| api-contract/sse/events.ts | 改 | 注释标注 otterName 来源（无结构变更） |
| web/src/pages/conversation/display-name.ts | 增 | 层 3 统一函数 |
| web/src/pages/conversation/MessageList.tsx | 改 | :396 换 resolveDisplayName |
| web/src/pages/conversation/index.tsx | 改 | :283/:415-434/:463/:686/:744/:914-915/:965 sn 初始化统一（防御式 `otterName \|\| otterId`） |
| tests/（多处） | 改 | Message 构造点补字段 + 新增 4 组测试 |
