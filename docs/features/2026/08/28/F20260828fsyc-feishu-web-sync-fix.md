---
id: F20260828fsyc
title: Web/飞书双向消息同步修复：广播链路空内容段 + 出站身份标签
status: development
summary: send() 返回的内存对象 segments 恒空导致 Web 首推空气泡/飞书显示「(空消息)」（存量 bug）；出站标签硬编码「用户」未接身份机制。回填 segments + 三级身份回退
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
change_type: fix
tags: [feishu, sync, broadcast, identity, sse]
modules:
  - src/usecases/conversation/send-message.ts
  - src/usecases/im/feishu-message-channel.ts
  - src/bootstrap/platforms.ts
  - src/app.ts
created: 2026-08-28
created_in_conversation: 08a924c4-9c68-43b4-9360-56f9b251e84f
from: [F20260826fuid, F20260826fpbd]
---

# Web/飞书双向消息同步修复

## 背景

搭档报告三问题（2026-08-28 09:07，原话）：

> 「1.我在web发言，然后看到飞书侧 机器人的发言是《[用户]
(空消息)》 。名字不对、内容也无了，但其实我是有发言内容的，感觉是消息没同步好。2.飞书侧有人发言，然后我看到web上实时渲染的消息内容也是为空。 3.web侧展示的发言人名字都是"飞书用户"，而不是具体的名字」

排查结论（重启前 session 完成侦察，代码+DB 双向核实）：

- **问题①②同根因（A，本 PR 修复）**：`send()` 落库与内存对象脱节——`persistUserMessage` 先 `createCompletedMessage(message)`（segments:[]）再 `appendSegment` 只写 DB。返回的内存对象永远 `segments: []`。两条广播链路直接消费该返回值：
  - 问题①链路：Web 发消息 → `message-controller.sendMessage` → `broadcastUserMessage(userMessage)` → 飞书出站 `aggregateBody([]) || "(空消息)"` → 显示「(空消息)」
  - 问题②链路：飞书消息 → `message-processor.process` → `sendMessage.send()` 返回值直接 `broadcast(message)` → Web SSE `toMessageDTO` content=null → 空气泡；后续轮询 `getMessagesAfter`（带 `attachSegments`）才补上真内容——与搭档描述「实时为空、后来有了」吻合
- **问题①名字「用户」**：`feishu-message-channel.resolveSenderLabel` 硬编码 user → "用户"，#488/#495 的身份机制（快照名/全局名）没接出入站方向
- **问题③（B，非本 PR）**：`contact:user.base:readonly` 权限未开通（#488 遗留运维待办），姓名快照全空 → Web 走 #495 设计的降级中性标签「飞书成员」。权限开通后新消息自动带真名，历史消息不回填（#488 设计如此）。代码侧无可修

**非 #488/#495 引入**：`send()` 的脱节在拆分重构时代即存在，之前无群聊多端场景所以未暴露。

## 目标

- T1: `send()` 返回的内存 Message 对象携带完整 segments——广播链路（SSE 首推/飞书出站）拿到真实内容
- T2: 飞书出站 user 标签接入身份机制——Web 消息显示搭档全局名（`user.displayName`），不再硬编码「用户」

## 非目标

- 问题③的权限开通（运维操作，搭档侧）
- 历史消息姓名回填
- 飞书消息出站回飞书（防回环设计保留，source=feishu 在 `shouldBroadcastToFeishu` 入口拦截——因此出站标签无渠道分叉分支）

## 方案设计

### 修复 1：segments 回填（`send-message.ts`）

`persistUserMessage` 的 `appendSegment` 返回值回填内存对象：

```ts
const seg = await this._repo.appendSegment(message.id, input.body);
message.segments = [seg];
```

与同文件 `sendSystem` 的既有回填模式完全对齐（该路径一直是对的，正是对照组证明这是遗漏而非设计）。

### 修复 2：出站身份标签（`feishu-message-channel.ts`）

`resolveSenderLabel` 的 user 分支改为：

1. **快照名优先**（`message.senderName`，防御性保留——防回环下当前恒无，未来跨群转发场景可直接生效）
2. **搭档全局名**（`settingsRepo.get(USER_DISPLAY_NAME_KEY)`，新增可选注入 `Pick<SettingsRepository, "get">`）
3. **硬编码兜底「用户」**（未注入 settingsRepo 或全局名为空时，老调用方兼容）

DI 链：`app.ts createFeishuBundle` → `platforms.ts` → `FeishuMessageChannel` 构造参数追加。settingsRepo 用 `Pick` 结构类型（接口隔离，测试可轻量 stub，且通道只消费 get）。

### 语义对齐说明

飞书出站 user 标签与 Web 端渲染（`MessageList.tsx`）在「谁是这个名字」上语义一致：Web 消息 = 搭档本人（`PartnerResolver.isPartner('user')` 恒真）→ 显示全局名。飞书侧消息不出站（防回环），故无需 Web 端的「飞书成员/外部成员」中性标签分支。

## 测试

新增/修改测试（均在既有测试文件内追加）：

- `tests/usecases/conversation/send-message.test.ts`：
  - 「send 返回的内存对象携带内容段」——回归锁定：内存对象 segments 经 aggregateBody 还原正文；与 DB 读取值一致（双保险）；segment.messageId 自洽
- `tests/usecases/im/message-broadcaster-feishu.test.ts`（新增 describe「飞书出站 user 标签」4 用例 + 修正旧用例 fixture）：
  - Web user 消息 → 显示搭档全局名「chen」
  - 未设全局名 → 回退「用户」
  - 未注入 settingsRepo → 回退「用户」（老调用方兼容）
  - user 消息带快照名 → 快照优先（防御性分支）
  - 旧用例「user 消息 senderLabel 为 [用户]」补 `senderName: ''` + `source: 'web'` 覆盖（原 fixture 默认 senderName="Test Otter"，会命中快照分支）
  - 新用例 mock 需唯一 messageId（#241 广播幂等去重 LRU 会撞掉重复 id 的断言）

全量 163 文件 / 1963 用例通过（含 busboy 依赖 npm install 后恢复的两文件）。

## 影响范围

- Web → 飞书方向：消息内容实时可见（原「(空消息)」）+ 标签显示搭档名（原「用户」）
- 飞书 → Web 方向：SSE 首推即带真内容（原空气泡等轮询补）
- `send()` 返回对象语义增强：所有调用方（message-controller/message-processor/其他）拿到即完整，无需各自 attachSegments
- 不影响 agent 派发链路（dispatchChainEngine 走 repo 读 DB，本就正确）

## 取舍

- **回填 vs createCompletedMessage 直接收 segments**：选回填——改动面最小（一处），不动 repository 接口签名，不触碰 attachment 链路的入库顺序约束（组装点③ appendSegment 前 linkMessageAttachments 的 FTS JOIN 时序）
- **出站标签不引入 PartnerResolver**：出站语义是「显示什么名」而非「是否搭档」（门禁语义）。Web 消息恒为搭档本人，全局名即正解；引入 resolver 反而是过度设计
- **问题③不在本 PR**：权限开通是根因，代码无可修；中性标签「飞书成员」已是 #495 设计的正确降级

## 验证

- [x] 单元：send-message / message-broadcaster-feishu 全过
- [x] 全量 vitest 163 files / 1963 tests
- [x] tsc --noEmit 干净（busboy 预存类型问题与本次无关，npm install 后消除）
- [x] eslint 干净（max-params 按项目约定 disable 注释）
- [ ] 搭档验收：web 发消息 → 飞书显示「[chen] 正文」；飞书发消息 → Web 实时显示正文 + 真名（权限开通后）
