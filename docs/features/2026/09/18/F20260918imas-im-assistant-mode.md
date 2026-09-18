---
id: F20260918imas
title: IM 助理模式：免绑定自动开户 + 助理对话（bot=海獭）
summary: IM 接入定位从「系统遥控器」转为「海獭助理栖息地」——微信私聊与飞书 p2p 首条消息自动开专属助理对话（免 /in 绑定），窗口=线程，软轮换带收篇摘要；命令体系降级为搭档 power mode；群聊维持共享上下文现状。
change_type: feature
capability_test: "n/a: 本阶段为方案文档，无代码改动；实现 PR 时补充 capability 用例"
created_in_conversation: b11cf010-f20d-4f92-88e6-ecc6414017a6
doc_type: feature
tags: [im, weixin, feishu, assistant, auto-provision, session-rotation, product]
modules: [src/interface-adapters/weixin/, src/interface-adapters/feishu/, src/usecases/im/, src/frameworks/feishu/, docs/user-guide/]
---

# IM 助理模式：免绑定自动开户 + 助理对话（bot=海獭）

## 背景

> 搭档原话（意图锚，2026-09-18 对话）：
>
> 「咱们海獭系统的im接入，到底是作为一个什么样的功能定位来思考设计的。……之前觉得就是im接入，然后支持几个slash命令、然后可以切换进入不同的对话中。那im的定位就是 通过某一个im软件来操作本系统」
>
> 「workbuddy……是将此当作一个"im通讯录中的一个ai助理"……本质是im接入一个固定的session……更类似于现在业界toC主流的ai chat。现在我就在思考，那咱们到底要的是什么，用户是我和我的家人朋友们，既有我这种软件研发人员，也有其他行业的。」
>
> 「我还是倾向于 飞书侧的一个bot就是海獭，就是咱们新版的海獭助理，一个机器人就一个海獭实例（一个thread）。」
>
> 「用户使用应该是 我、我家人 每一个人都用自己的微信扫码，然后在海獭系统上就会有多个 助理对话（一个微信对应一个）」
>
> 「（群聊）不需要过度设计，不需要考虑"每人问各的、互不串台"，这个本来就是伪命题，都拉进群了，为什么还要互不串台。」

对照产品愿景（F20260709x7k3 原文）：「用户始终与一个大獭对话，大獭基于记忆系统理解用户上下文」——愿景本就是人↔獭锚点，当前 IM 实现走的是会话锚点（先 /in 绑定才能聊），与愿景偏移。本特性把 IM 的默认形态对齐到愿景：**IM 是大獭的栖息地，web 是工作台**。

### 需求结晶五问（已逐项经搭档确认，2026-09-18）

| 问 | 答案 |
|---|---|
| C1 为谁解决什么 | 家人朋友（非研发用户）用自己的微信/飞书直接和海獭聊；搭档本人保留工作态（命令 + web 工作台） |
| C2 现状怎么应付、代价 | 必须先 /list + /in 绑定对话才能聊；未绑定即拒聊（「请先使用 /in 进入对话」）。对非研发用户是一堵墙 |
| C3 成功长什么样 | 扫码/加好友即聊，零命令暴露；隔天回来獭还认得用户（收篇摘要）；搭档仍可 /in 进工作对话 |
| C4 明确不做什么 | 群聊人级隔离（搭档裁决：伪命题）；飞书 ISV 应用商店上架；全通道单线程（微信线与飞书线各开各的助理对话） |
| C5 最小可交付 | 第一刀：免绑定自动开户（本特性）；第二刀：软轮换+收篇摘要（本特性范围内）；远期：主动触达（不进本特性） |

## 目标

- T1: **免绑定自动开户**——微信私聊、飞书 p2p 首条消息自动创建专属助理对话并绑定该 connection，删掉拒聊分支（「请先使用 /in 进入对话」墙对普通用户消失）
- T2: **飞书 p2p/群聊分流**——ingress 按消息事件 `chat_type` 字段（p2p/group）分流：p2p 走助理态（自动开户），group 维持现状（显式 /in 绑定 + 共享上下文）
- T3: **助理对话可识别**——自动创建的对话带来源标识（IM 助理态 + 通道 + 对端名称），在 web 端对话列表可辨认，不打扰普通工作对话的呈现
- T4: **搭档保留工作态（power mode）**——命令体系 /list /in /out /history /help 行为不变，门禁语义不变（配置 partnerResolver 后仅搭档可用；现状代码已满足，本特性零改动，写入文档作边界声明）
- T5: **软轮换 + 收篇摘要**——助理对话满足轮换条件时翻篇（新开助理对话 + 旧对话收篇），收篇摘要沉淀进记忆系统，跨篇连续感由记忆承载

## 非目标

- 不做群聊人级上下文隔离（搭档原话裁决：伪命题）
- 不做人级记忆隔离（检视发现 2 处置：显式声明，见设计取舍「记忆隔离」行）
- 不做飞书应用商店 ISV 上架模式（扫码安装应用级体验，企业认证+审核过重）
- 不做主动触达（定时任务/提醒推 IM——scheduled task 底座已有，将来独立特性）
- 不做全通道单线程（微信线与飞书线各自开助理对话，不合并）
- 不改 Connection 数据模型的外部形状（connection 仍是 externalId=聊天窗口/好友 的路由实体；变化在绑定策略层）
- 本期不实现自然语言会话切换（「看看装修那个对话」→ 检索切换，远期）

## 方案设计

### 核心概念：三层分离

```
海獭身份（bot = 大獭，用户感知的唯一实体）
  └─ 助理对话（conversation，窗口=线程：每个聊天窗口自动一条线）
       └─ Connection（路由实体：externalId = 微信好友/飞书 chatId，纯内部管道，用户不感知）
```

用户面只有「海獭助理」一个概念；chatId/connection 降级为内部实现细节。

### 分通道设计

**微信（一人一号，天然窗口=线程）**

现状：`ensureConnection(fromUserId, fromUserId, "weixin")`（weixin/message-processor.ts:81）已按好友建 connection，只缺自动开户。

改动（handleInbound 主链）：
```
getCurrentConversation(connectionId) 为空时
  → 命令分支照旧（搭档 power mode）
  → 非命令消息：不再回复「请先 /in」
    → 创建助理对话（title = 「微信助理 · <好友备注/昵称>」，带来源标识）
    → enterConversation(connectionId, 新对话)（复用现有事务，与 /in 同一入口）
    → 消息照常入库 + dispatch
```

细节：
- 若该 connection 曾有历史会话（被 /out 释放后），自动开户**新开对话**还是**回绑最近一篇**？→ 首版：新开。决策理由（检视发现 6）：新开语义最简单且回避「回绑时旧篇上下文是否仍适用」的判断；孤儿对话由归档策略兜底（见风险 #7）。另注：/out 是搭档工具，家人用户不会使用——此路径实际触发方主要是搭档自己
- 自动开户对话也进入 /list（搭档可见、可 /in 接管——同窗口独占互斥保护现有事务语义）。/list 呈现规则（检视发现 5）：title 前缀「微信助理 ·」「飞书助理 ·」自然可辨认，本期 /list 平铺返回不做分组/过滤——分组 UI 属后续 web 侧小特性；家人不需要知道自己助理对话的 UUID，需要搭档接管时由搭档在 web 端或 /list 中按前缀辨认

**飞书（私聊/群聊混合，按 chat_type 分流）**

现状：`ensureConnection(chatId, chatId)`（feishu/message-processor.ts:67），不区分 p2p/group，统一走 /in 绑定。消息事件已携带 `chat_type` 字段（frameworks/feishu/long-connection-client.ts:37）。

改动：
1. **chat_type 贯通三层接口**（检视发现 1 修正：非「纯透传」，现有链路层层过滤了该字段）：
   - `usecases/im/feishu-long-connection-gateway.ts`：FeishuLongConnectionMessage 接口增 `chatType?: "p2p" | "group"` 字段
   - `frameworks/feishu/long-connection-client.ts`：processMessage 构造消息对象时从原始事件提取 `chat_type`（:37 已声明，:225 构造时未提取）
   - `interface-adapters/feishu/long-connection-handler.ts`：handleMessage 转发时透传 chatType（:30 现状丢弃）
   - `interface-adapters/feishu/message-processor.ts`：FeishuIncomingMessage 增字段并消费
2. **message-processor 分流**：
   - `chatType === "p2p"` → 助理态：同微信的自动开户逻辑（title = 「飞书助理 · <用户名>」，resolveSenderName 已有 F20260826fuid 身份链可复用）
   - `chatType === "group"` → 维持现状：显式 /in 绑定 + 共享上下文 + 未绑定提示（群的「未绑定提示」保留——群是工作态场景，提示语维持命令引导）
3. 兼容：chat_type 缺失时按现状处理（不自动开户）——降级保守

### 助理对话的来源标识（T3）

- conversation 无 schema 变更；标识走 **title 约定 + 既有 summary 字段**（收篇摘要落 summary，兼作轮换凭证）
- web 端对话列表按 title 前缀「微信助理 ·」「飞书助理 ·」自然成组辨认；后续 web 侧要专门 UI（图标/分组）时独立小特性，本期不做
- 新增 schema 字段必须声明消费方（⑥）：本期零新增字段；若实现阶段确需 `conversation.kind` 字段，消费方 = web 对话列表分组 + IM ingress 开户判断——届时在实现 PR 中声明

### 软轮换 + 收篇摘要（T5）

- **触发条件（首版从保守开始）**：助理对话的最后一条 entry 距今超过 N 小时（默认 72h，config 可调）。不用上下文长度阈值（首版不引入，防误伤长对话）
- **阈值语义说明（检视发现 3/7 处置）**：触发锚是「最后一条 entry 距今」而非「对话开始至今」——**活跃对话天然不触发**（连续聊天时 last entry 持续刷新，永远新鲜），低频用户回归时上下文已冷、翻篇正是期望行为。该阈值自适应用户频率：热的篇不翻、冷的篇才翻。首版显式声明：不引入额外活跃度判断，仅看 last entry 距今
- **默认值 72h 的依据**：24h 对「周末型」家人用户过于激进（周五聊完周日回来即翻篇）；72h 给短间隔回归留余量。上线后按真实回归间隔数据调优
- **动作**：窗口下一条入站消息到达时发现超时 → 先对旧对话执行收篇（大獭生成收篇摘要，落 conversation.summary + 沉淀记忆条目）→ 新开助理对话绑定 → 新消息进新篇
- **沉淀方式**：收篇摘要作为 fact 类记忆条目入库（复用现有 memory 入库通道），关联 conversationId；新篇大獭的 systemPrompt 注入「前篇摘要」（拼装点在 agent 会话组装层，实现时定位）
- **失败降级**：收篇生成失败不阻塞新消息——先翻篇（旧对话 summary 置空 + healing 记录），摘要补写为待办。用户体验优先于完整性
- **补写重试策略（检视发现 8）**：翻篇后异步重试收篇 1 次；仍失败则 healing event 入台账供巡检发现，不阻塞新消息、不无限重试
- **workbuddy 对照**：其轮换=失忆（换 session 即清上下文）；本方案轮换=翻篇（摘要 + 记忆承载连续性）——这是记忆系统的产品化展示窗口

### 搭档工作态（T4，零改动声明）

现状代码已是目标语义：非搭档发命令收到「这些命令暂时不对所有人开放哦～直接聊天就行 🦦」，配置 partnerResolver 后命令仅搭档可用（feishu/message-processor.ts:106、weixin/message-processor.ts:147）。本期不改命令集、不改门禁。

注意一个新交互：搭档本人微信私聊窗口也将自动开户助理对话（搭档也是 p2p 用户）。搭档想走工作态时用 /out 释放后 /in 目标对话即可——自动开户只在「无绑定且收到非命令消息」时触发，命令路径完全不受影响。

### 配置

```yaml
# config.yaml
im:
  assistant:
    enabled: true            # 总开关（缺省 true？见设计取舍#3）
    rotation_hours: 72       # 软轮换阈值（小时，last-entry 距今）
```

## 影响范围

- 微信入站主链（weixin/message-processor.ts）：未绑定分支改为自动开户
- 飞书入站主链（feishu/message-processor.ts + long-connection-client.ts）：chat_type 透传 + p2p 分流
- ManageConnection（usecases/im/manage-connection.ts）：新增「确保助理绑定」用例方法（自动开户 + enterConversation 复用）；现有方法零改动
- ManageConversation（usecases/conversation/manage-conversation.ts）：create 已支持（会为大獭建 otter + 工作区目录，助理对话复用同路径——大獭每对话一实例与「bot=海獭」身份语义一致：用户感知一个海獭，系统内每个对话自有一个大獭实例，跨对话记忆共享）
- 记忆系统：收篇摘要入库（读端无变化，新增写入方）
- /list 呈现：助理对话会出现在列表中（搭档可见；标题前缀辨认）
- 出站通道：无变化（externalType 路由既有机制）

## 风险与约束

1. **自动开户成本**：陌生人给微信账号发消息即创建对话+otter+工作区目录（有存储成本）。缓解：通道本身是私人号协议直连，能发消息的必然是好友；config 总开关可关
2. **滥用面**：飞书 bot 若被拉进陌生群，group 场景维持显式 /in，不会自动开户，风险收敛在 p2p（p2p 意味着对方能直接私聊 bot，等价于微信好友关系）
3. **轮换窗口竞态**：收篇+翻篇+新消息入库的原子性。缓解：入站主链是单窗口串行处理（现有 ensureConnection→handleInbound 顺序），首版不加锁；实现时验证
4. **收篇摘要质量**：摘要差=连续感断裂，体验劣化。缓解：首版 24h 阈值（翻篇频率低）+ summary 落库可人工核查；质量调优是运营问题不是机制问题
5. **记忆污染面**：家人对话内容进共享记忆库。缓解：收篇摘要 fact 关联 conversationId，可按对话清理；人级记忆隔离本期不做（家人体量小，先跑起来看）
6. **搭档自己的窗口**：搭档微信/飞书私聊也会自动开户（有额外对话噪音）。缓解：搭档可 /out 后不说话（自动开户仅由非命令消息触发）；后续可加「搭档窗口禁自动开户」配置
7. **轮换累积成本（检视发现 4）**：每次轮换 = 新对话 + 新 otter 实例 + 新 workspace 目录。澄清实际成本量级：otter 实例是 DB 行非常驻进程（session 按需创建，不活跃不占计算），dormant 成本 = DB 行 + 磁盘目录 + /list 管理噪音。缓解方向：轮换翻篇时旧对话自动置 completed（复用 canCompleteConversation 既有机制）；后续观察量级再决定是否做「N 天无活动自动归档」（四问答③的退役路径）

## 不兼容更新

无 schema 破坏性变更。行为变更：微信私聊+飞书 p2p 的未绑定用户从「收到拒聊提示」变为「自动开户并得到回复」——这是本特性的目的本身。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 锚点模型 | 窗口=线程（每聊天窗口自动一条助理线） | bot 全局单线程 | 单线程会让 A 的菜谱混进 B 的旅游线（上下文互相污染）；用户对「bot=海獭」的感知不变——没人知道也不需要知道线怎么分 |
| 微信线与飞书线 | 各开各的助理对话 | 合并为单用户单线（跨通道归一） | 归一需要跨通道用户身份映射（无现成机制）；「同一只獭」的连续感由记忆承载，不靠塞进一个对话 |
| 轮换触发 | 固定时长（72h，检视修正：原 24h） | 上下文长度阈值 | 长度阈值易误伤长对话且需常驻监测；时长规则可解释可预期；last-entry 距今锚天然自适应用户频率（活跃不翻、冷了才翻）；阈值 config 可调，上线后按真实数据调优 |
| 记忆隔离（检视发现 2） | 本期不做人级隔离，但显式承认风险 | 助理对话检索强制 conversationId 过滤 | 现状检索默认全局（sqlite-memory-repository.ts:162 `? IS NULL OR conversation_id = ?`，currentConversationId 仅排序加成非过滤——F20260917cvid），家人 A 的内容可被家人 B 召回，搭档工作记忆同理。不隔离的理由：家人体量小（<10 人）+ 信任模型（同一家庭，非公网多租户）；但收篇摘要 fact 落库时关联 conversationId，为将来做读取隔离留锚。实现阶段必须显式决策：助理对话的检索是否传 conversationId 过滤（影响召回家人历史 vs 全局记忆的边界），该决策点列入实现 PR 的检视清单 |
| 收篇失败 | 先翻篇后补摘要 | 阻塞等待摘要 | 用户消息不能被运营性任务阻塞；丢摘要代价 < 丢消息代价 |
| 助理对话标识 | title 前缀约定 | conversation 加 kind 字段 | 零 schema 变更即达成本期目标（web 辨认 + 人可读）；字段方案在需要 UI 分组时再上（机制预算：避免为可延后的消费方提前建字段） |
| 群聊 | 维持现状 | 群助理态（自动开户共享线） | 搭档裁决不过度设计；群是工作态场景，显式绑定语义更安全 |
| 飞书多租户边界 | 接受「自建应用仅本租户可见」 | ISV 上架 | 家人主战场是微信通道；飞书真实用户=搭档+同事圈，自建应用够用 |

### 机制识别检查点 & 机制预算四问

检查点判定：命中「新增决策分支（其结果被记住并影响后续行为）」——自动开户创建的 conversation 是持久状态。四问：

- ① **谁需要它**：非研发的家人朋友用户（C1 角色）——他们的首条消息需要自动变成可聊的对话；以及系统入站主链（需要一个绑定目标才能路由消息）
- ② **失败后果**：自动开户失败时用户消息无法处理（回到拒聊墙）；轮换失败时旧篇摘要丢失（连续感断裂，用户隔天感知「獭失忆了」）
- ③ **后续机制**：自动开户创造的对话堆积（长期不聊的窗口留下孤儿对话+otter+workspace）→ 将来需要清理/归档策略（挂 post-merge 后续观察，不本期实现）；收篇摘要质量劣化 → 需要摘要模板/prompt 调优（运营动作）
- ④ **退役条件**：若将来对话管理演进为「用户可见的多助理对话列表 + 显式生命周期」，自动开户退化为「新建对话」的默认参数；若 IM 助理形态被验证失败（家人不用），开关关掉即退役，存量对话自然衰减

### 大版本重构判断

不属于大版本重构——入站主链、绑定模型、命令体系均不动骨架，属绑定策略层的增量改造。零基重推：若从零设计今天的 IM，「首条消息自动可聊」本来就会是默认选择（/in 绑定是给工作态准备的进阶能力，不该是唯一入口）。

## 验证

- 微信模拟好友首条消息 → 自动创建助理对话 + 消息入库 + 大獭回复（无拒聊提示）
- 飞书模拟 p2p 首条消息 → 同上；group 首条消息 → 维持「请先 /in」现状
- 命令路径回归：/list /in /out /history /help 全量回归（自动开户不得影响命令分支——搭档窗口 /out 后发命令不被自动开户劫持）
- 轮换：构造超时窗口，下一条消息触发收篇（summary 落库 + 记忆条目存在）+ 新篇开户；收篇失败注入 → 翻篇仍成功 + 异步重试 1 次 + healing 记录；活跃对话（连续消息间隔 < 阈值）不触发轮换（last-entry 锚验证）
- 搭档路径（检视发现 9 补全）：①搭档微信私聊发普通消息 → 自动开户助理对话；搭档随后 /out + /in 工作对话不受自动开户干扰 ②搭档 /out 释放助理对话后窗口再发非命令消息 → 自动新开（/out→自动开户回归路径）
- 互斥回归：助理对话被搭档 /in 接管后，原窗口自动开户不劫持（事务互斥既有测试）
- capability 用例在实现 PR 中补（本 PR 为方案文档，capability_test: n/a 已声明理由）

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| docs/features/2026/09/18/F20260918imas-im-assistant-mode.md | 新增 | 本方案文档 |
| src/interface-adapters/weixin/message-processor.ts | 改（实现 PR） | handleInbound 未绑定分支 → 自动开户 |
| src/interface-adapters/feishu/message-processor.ts | 改（实现 PR） | p2p 分流 + 自动开户 + FeishuIncomingMessage 增 chatType |
| src/interface-adapters/feishu/long-connection-handler.ts | 改（实现 PR） | handleMessage 转发 chatType（检视发现 1 补全） |
| src/usecases/im/feishu-long-connection-gateway.ts | 改（实现 PR） | FeishuLongConnectionMessage 接口增 chatType 字段（检视发现 1 补全） |
| src/frameworks/feishu/long-connection-client.ts | 改（实现 PR） | chat_type 透传 |
| src/usecases/im/manage-connection.ts | 改（实现 PR） | 新增 ensureAssistantBinding 用例方法 |
| src/frameworks/config-service.ts + config/config.yaml.example | 改（实现 PR） | im.assistant 开关 + rotation_hours |
| docs/user-guide/ | 改（实现 PR） | 使用说明更新（助理态/工作态） |

> 本 PR 仅含方案文档；标注「实现 PR」的行属于后续 code-implementation 阶段。

## 对抗审视记录

### 第一轮（2026-09-18，检视獭：mimo 异模型）

结论：需要修改——4 严重 + 5 建议 + 重对抗门「疑似治标」。处置（按 author-response-protocol 决策树）：

| # | 发现 | 严重度 | 处置 | 说明 |
|---|---|---|---|---|
| 1 | chat_type「纯透传」断言不实（三层接口无字段） | 🔴 | 接受并修订 | 核实属实：gateway.ts/handler.ts/FeishuIncomingMessage 均无 chatType。改为三层贯通描述 + 改动范围补 2 文件 |
| 2 | 记忆无隔离模型，家人内容可交叉召回 | 🔴 | 接受并修订 | 核实属实：检索默认全局（sqlite-memory-repository.ts:162），currentConversationId 仅 boost 非过滤。新增设计取舍行 + 非目标声明 + 实现阶段显式决策点 |
| 3 | 24h 轮换与低频场景不匹配 | 🔴 | 部分接受 | 默认值 24h→72h + 补充 last-entry 锚自适应语义论证；「每次回归都轮换」的成本面归发现 4 处置 |
| 4 | 轮换累积 otter/workspace 成本未评估 | 🔴 | 部分接受 | 风险节新增 #7：澄清 dormant otter = DB 行无常驻计算 + 翻篇自动置 completed + 归档策略方向 |
| 5 | /list 呈现规则未定义 | 🟡 | 接受并修订 | 搭档工作态节补呈现规则（前缀辨认，本期平铺不分组） |
| 6 | /out 回归路径决策理由缺失 | 🟡 | 接受并修订 | 补决策理由（新开简单 + 归档兜底 + /out 实际是搭档工具） |
| 7 | 活跃窗口轮换豁免未声明 | 🟡 | 反驳（附证据）+ 顺手补声明 | 方案原文即「最后一条 entry 距今」——连续聊天时 last entry 持续刷新，活跃对话永远不满足触发条件，不存在「中断活跃对话」问题。检视者误读了触发锚；已在轮换节补显式声明消除歧义 |
| 8 | 收篇摘要重试策略空白 | 🟡 | 接受并修订 | 补：异步重试 1 次 + healing event 入台账，不无限重试 |
| 9 | 验证节缺搭档路径用例 | 🟡 | 接受并修订 | 补 2 条用例（搭档自动开户 + /out 回归路径） |

重对抗门：检视獭判「疑似治标」（自动开户是绑定架构上的补丁，治本需重构 conversation 生命周期模型）。作者立场（带证据反驳）：本特性边界内是治本——自动开户消灭的是「绑定为唯一入口」这个错误默认（产品语义层），数据模型层零补丁（复用 Conversation/ConnectionSession 既有实体与事务，enterConversation 同一入口）；conversation 可见性重构属更大产品演进（检视獭也认为不该与本特性耦合）。按规则呈搭档裁决，附双方立场。

### 第二轮：Delta 复核（2026-09-18）

结论：**通过**——9 条发现全部核实修订到位（发现 2 的 SQL 链接点由检视獭独立复核属实）；发现 7 反驳被接受（检视獭自认误读触发锚，反驳成立）；重对抗门修正为「本特性范围内确认治本，conversation 可见性重构属独立演进阶段」（检视獭接受作者反驳：将不属于本特性范围的长期演进当作治标反证在逻辑上不成立）。方案定稿，呈搭档终审。
