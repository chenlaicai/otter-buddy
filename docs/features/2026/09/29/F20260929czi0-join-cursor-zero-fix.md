---
id: F20260929czi0
title: 进场游标零点修正——新獭进场/换世不再有「全历史未读」
summary: 修正 F20260913ctlv 引入的语义混淆：进场游标 last_read_seq=0 把「对话全历史」当成了新獭的「未读」，导致新獭首请求与换世首轮注入量随对话长度无界增长（kimi-256k 首请求 400 拒答）。修正为：加入已有对话的獭游标=进场时刻 max(seq)，未读只含进场后新消息；进场前背景由派工简报/检索工具承载。
change_type: fix
capability_test: "n/a: 语义修正由仓储层测试 + dispatch 注入断言覆盖（bugfix 类，失败证据链见 Verification）"
created_in_conversation: efcdddae-6817-4153-addc-7c242c5fc953
intent:
  problem: "F20260913ctlv 拍板「进场游标=0=读全部历史」把「未读」零点从进场点挪到对话起点——新獭/换世首请求注入量随对话长度无界增长，kimi-256k 在 2301 条对话首请求即 400 爆窗；生产实测 37 只 active 零游标参与者锁死在「爆窗→不推进→永远全量未读」循环。"
  why_now: "搭档 2026-09-29 原话：「新獭进场本来就不应该从seq0开始注入未读消息的！……不管是重启獭生还是拉新獭，根本都没有 未读 这个东西的啊！」「开工！」——定性为语义错误而非缺护栏，明确否决注入侧预算补丁路线。"
  expected_effect: "「未读」回归小集合（进场后新消息）；新獭首请求体量与对话历史长度解耦；37 只存量零游标獭经一次性迁移解除锁死；新对话初始化行为不变。"
  verify_by:
    type: static_only
    reason: "仓储/域层测试静态断言游标语义（进场后可见、进场前不可见、迁移后为空）；端到端爆窗复现依赖大对话+特定模型，留 alpha 冒烟不入 golden。"
causal_links:
  - F20260913ctlv  # 引入 last_read_seq=0 拍板口径的源头特性
  - F20260922ctxi  # 首轮情报包/未读 delta 注入管道（本修正的消费方）
tags: [conversation, read-cursor, context-injection]
modules: [conversation, agent-runtime]
created_at: 2026-09-29
---

# 进场游标零点修正

## 背景

搭档原话（意图锚，2026-09-29 本对话）：

> 「不对！之前没有这些问题！你不要打补丁！你要从功能的设计上去思考，为什么会有这几个问题！新獭进场本来就不应该从seq0开始注入未读消息的！这是哪里引入的？！不管是 重启獭生还是拉新獭，根本都没有 未读 这个东西的啊！」

事故现象：kimi-256k 小獭被拉进《三省吾身》对话（2301 条 entries）首请求即 400：`Your request exceeded k3-256k model token limit: 262144`；《issue处理》对话大獭换世切 kimi-256k 同样爆窗（同对话 glm 大窗口模型无症状——注入量落在两窗口之间，窗口越小越先死）。

引入点（git 实锤）：commit `b1d11c5f`（PR #886，F20260913ctlv）子提交「F20260910ctlv 小獭进场游标漏读历史」——当时 test15 实测「小獭进场后读不到大獭进场前提的问题」，拍板口径「进场游标与进场 system entry 一致」，落地为 `createParticipant`/`createParticipants` 显式写 `last_read_seq=0`（src/frameworks/db/conversation/conversation-repository-mixins.ts:110-139）。该口径把「未读」的零点从「进场点」挪到了「对话起点」——新獭天生背上全对话的未读债。小对话无害（几十条），大对话 + 小窗口模型才把语义错误物化。

## 目标

T1: 「未读」语义回归——獭的未读集合 = 自其进场点之后、尚未消化的发言；进场点之前的对话历史对「未读注入」不可见
T2: 新獭首请求注入量与对话历史长度解耦——首请求体量只由系统提示 + 工具定义 + 派工简报 + 进场后消息决定
T3: 换世（restart）不再通过「未读回放」重复注入已由 handoff 档案承载的历史
T4: 不破坏「新对话初始化」场景——对话开场白对首批在场獭仍可读（游标=0 在空对话是天然正确值）

## 非目标

- 不做注入面的 token 预算编排器（身份/档案/未读/简报统一裁剪）——那是治本后的加固层，本修正先把「未读」变回小集合，预算编排器失去紧迫性，另立项评估
- 不改 handoff 档案生成逻辑（保留段 20K 预算已存在且工作正常）
- 不改 getUnreadEntries 的查询形态（消费方不动，动的是写入侧的初始值与存量数据）

## 未决问题

无。

## 方案设计

### 核心概念区分：两种「进场」

| 场景 | 当前调用方 | 对话状态 | 正确游标 |
|---|---|---|---|
| A. 新对话初始化 | manage-conversation.ts:83、web-assistant-provisioner.ts:86、ensure-recruiting-conversation.ts:101 | 空对话或即将写开场白 | **0**（天然正确——对话的全部历史就是獭该看的） |
| B. 加入已有对话 | manage-participant.join（bootstrap/clients.ts:142 ← create_otter 工具） | 已有 N 条 entries | **进场时刻的 max(seq)**（进场前历史不是未读） |

现行实现把 A/B 都写成 0——A 恰好正确，B 是事故源。修正 = 让 B 走自己的初始化值，不动 A。

### 改动点（两处）

**① 仓储层：createParticipant 支持显式游标初值**（conversation-repository-mixins.ts:107-139）

- `createParticipant`/`createParticipants` 接受可选 `lastReadSeq?: number` 参数（ConversationParticipant 实体加可选字段，usecases/conversation/conversation-repository.ts 的接口签名同步）
- 缺省保持 0（场景 A 的调用方零改动、行为不变）
- 注释更新：删除「进场游标与进场 system entry 一致 = 读全部历史」的 F20260910ctlv 口径，替换为本特性的语义说明（口径被取代，git 历史保留原始决策）

**② 域层：manage-participant.join 计算进场点游标**（manage-participant.ts:48-78）

- join 在创建参与记录前读 `getMaxEntrySeq(conversationId)`（mixin 已存在，conversation-repository-mixins.ts:198）
- 构造 participant 时带 `lastReadSeq = maxSeq`——游标零点 = 进场点
- 时序安全：seq 由 createEntryAtomic 单调原子分配，join 顺序为「先读 maxSeq=M → 写 participant(游标=M)」——读数之后并发落库的消息 seq 恒 > M = 游标，**对新獭恒可见，无漏读窗口**；seq ≤ M 的都是进场前历史，本就该不可见。故无并发风险、无需加锁
- 进场 system entry（`xx 加入了对话`，senderId = 新獭自己）**对新獭不可见**——getUnreadEntries 的 SQL `AND sender_id != ?`（sqlite-entry-repository.ts:300-315）排除自己的 entry；该 entry 是写给其他在场獭看的仪式性消息。本特性不改变此既有语义，验证用例按现实断言

### 换世（T3）为什么自动痊愈 + 存量地雷迁移

restart 换世 = 同一獭的新 session 首轮。现行路径：首轮走 `buildMessageWithContext` 未读注入（dispatch-chain-engine.ts:798 起），未读 = `seq > last_read_seq` 的全部条目。本修正不改变换世的游标推进逻辑（updateLastReadSeq 每轮推进 batchMaxSeq 不变）——换世首轮之所以曾经爆，是因为**该獭的游标在进场时被写成 0**，首轮未读 = 全历史。修正后任何獭的游标从出生起就 ≥ 进场点，此后每轮推进，换世时未读只含「自上次推进后的新消息」（通常 0~几条）。handoff 档案（保留段 20K 预算）与未读回放不再双重承载全历史。

**存量地雷（检视发现 S1，生产实测）**：37 只 active × active 对话的参与者 last_read_seq=0（含「遗留pr处理」153 条 would_inject、「sleep使用要求」「特性标题优化」两只 kimi-256k 大獭）。它们多为换世后新 session 从未成功启动消费历史——pi-session-factory.ts:929-945 pushCursorOnStartup **只在启动成功时推进游标**（注释明言「启动失败不推进——消息保持未读，下轮自然重注入」），爆窗 400 → 不推进 → 永远全量未读，锁死循环。仅改新进场初始化不救存量，故随本特性做**一次性迁移**（对齐 backfillLastReadSeq 先例，conversation-repository-mixins.ts:169-184）：`active 参与者 × active 对话 × last_read_seq=0 → max(seq)`。语义依据：这些獭的事实状态就是「读到最新」（它们从未成功消化过任何历史消息，把全历史灌给它们的每次尝试都已失败）；空对话里 max(seq)=0，迁移前后等价，幂等天然安全；回滚面 = 迁移值与旧列独立。迁移随启动路径执行，一次性。

### 进场前背景的正当承载面（语义修正的配套约定）

9/13 拍板要解决的问题「新獭读不到任务背景」仍然存在，但承载面归位：

- **派工简报**：大獭 create_otter 时写的 systemPrompt/任务描述——任务背景的**第一责任承载面**（otter-summon skill 已要求写清任务，本次在 skill 中补一句「新獭默认看不到进场前对话历史，背景必须写进派工简报或指引其 search_messages」）
- **检索工具**：search_messages/list_messages 对小獭开放——需要挖进场前历史时主动查（按需供给，替代按存在灌入）

## 影响范围

- **行为变化（有意的语义修正）**：新进场獭不再自动收到进场前的对话历史。受影响入口只有 create_otter 工具（manage-participant.join）。Web 助手开场、招聘对话、manage-conversation 建新对话——行为不变（游标=0 缺省）
- **派工质量依赖**：大獭派工时若以前依赖「小獭自己能翻到历史」而简报写得潦草，修正后会暴露简报质量问题——这是把隐式依赖显式化，方向正确
- **阅读面**：query-message.ts / listWithMeta 的未读计数对新獭将显示 0 未读而非全历史——语义更正确。注意口径差异（既有现象，非本特性引入）：计数子查询只含 `entry_type IN ('speak','system')`（sqlite-conversation-repository.ts:227），不含 user，而注入路径含 user——两条路径口径本就不一致，本特性不对齐它们，实现者不得以注入口径去「修」计数口径
- **既有在场獭**：游标被一次性迁移推进者，行为变化 = 不再被全历史灌爆（这是修复目的本身）；其余不动

## 风险与约束

- **风险：派工简报欠写的任务，新獭开场会问「背景是什么」**——缓解：otter-summon skill 补约定（见上）；大獭模型侧 prompt 无需改（skill 文档是真相源）
- **风险：test15 场景的原始症状（小獭问「问题是什么」）可能被误判为回归**——区别：当年是「游标 NULL 导致连简报/触发消息都读不到」的管道 bug；本修正后触发消息与进场后消息必然可见，缺的只是进场前闲聊，且检索工具可补
- **风险：存量迁移把「爆窗锁死中」的獭推进后，其换世首轮只注入档案而无未读**——这正是设计目标（历史归档案/检索）；若个别獭当时正被等待回复某条历史消息，该消息实际早已随爆窗从未送达，不存在「已读未回」的状态丢失
- **约束**：不改 schema（last_read_seq 列已存在，只改写入值与存量数据）

## 不兼容更新

[Incompatible] 新进场獭的未读注入不再包含进场前的对话历史（语义修正）。依赖「小獭自动通读全对话」的派工方式失效，背景供给责任移回派工简报。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 游标零点放在哪 | 进场点 max(seq) | ①保持 0+注入侧 token 预算裁剪 ②游标=0 但只回放缓 N 条 | ①②都是把语义错误留在数据层、在消费侧打补丁——搭档明确否决（「不要打补丁」）；零点=进场点让「未读」回归小集合，补丁层失去存在理由 |
| 存量零游标獭怎么办 | 一次性迁移推进到 max(seq) | 只改新进场，存量不动 | 检视 S1：37 只存量獭处于「爆窗→不推进→永远全量未读」锁死循环，不迁移则事故复发；backfillLastReadSeq 有先例，语义上「0 且从未启动成功」的事实状态就是「读到最新」 |
| 场景 A（新对话）怎么办 | 缺省 0，调用方零改动 | 所有调用方显式传值 | 空对话里 0 与 max(seq)=0 等价，缺省值天然正确；强迫调用方传值是 churn |
| join 并发时序 | 无风险窗口（先读 maxSeq 后写 participant，后到的消息 seq 恒 > 游标、恒可见） | 事务内锁定 entries 写入 | seq 原子单调分配下该顺序天然不漏，锁是多余复杂度（检视 R1 确认原「漏读 1-2 条」顾虑为伪风险） |
| 换世是否额外豁免未读注入 | 不豁免——修正后未读天然是小集合 | 换世首轮跳过未读回放（原排查建议 3） | 豁免是补丁；修正游标语义后换世未读≈0，豁免失去对象。且「封存后新进的」消息本应送达 |
| 机制识别检查点 | **不涉及净新增机制**（逐项核对：无新配置/状态生命周期/定时任务/信号类型/持久化表/被记住的决策分支/跨模块调用路径——只改一个既有字段的初始化值） | — | 跳过机制预算四问与重对抗门，判定留痕供检视核对 |

## 验证

### 实现记录（F20260929czi0，2026-09-29）

- 仓储层：createParticipant/createParticipants 接受 participant.lastReadSeq 可选初值（缺省 0，实体字段定位为「写入时初值」——rowToParticipant 不回填，读取侧游标真值在 participants 行）；接口注释同步，签名不变（实体可选字段携带，调用方零改动）
- 域层：join 先读 getMaxEntrySeq 再建 participant（游标零点=进场点）；时序注释含「无漏读窗口」论证
- 迁移：advanceZeroCursorsForActiveJoin（active × active × last_read_seq=0 → max(seq)），随 postInitDatabase 启动路径执行，守卫=零游标行计数（失败仅日志不阻断启动）；函数注释含完整回滚语义（检视残留观察项落实）
- otter-summon SKILL.md 步骤 2 补「新獭默认看不到进场前历史，背景写进派工简报」约定
- 测试：旧口径测试（join-read-cursor.test.ts 锁定「进场游标=0」被取代语义）已按新语义重写；新增 cursor-zero-migration.test.ts（六用例：推进+未读为空 / 范围四不动的边界 / 幂等 / 空对话等价 / sqlite_master DDL 结构不变量 / updateLastReadSeq 功能探针——迁移三不变量覆盖）；manage-participant 域层三用例（进场前不可见+进场后可见 / 空对话开场白可见 / 进场 entry 对新獭不可见）
- 全量自检：npm test 304 文件 4271 测试全绿；eslint 0 报错；tsc --noEmit 0 错误；npm run lint:intent 0 error（verify_by: static_only 豁免 golden gate，声明写入 PR Verification 节）
- 最简实现检查：已过——直接 SQL UPDATE 复用既有列，无 schema 变更/新表/新依赖；复用 getMaxEntrySeq 既有方法与 backfillLastReadSeq 迁移模式（可选接口方法 + 启动守卫），未新建抽象层

bugfix 类失败证据链（Verification 硬规则）：

1. **修复前失败证据**（已采集，本对话排查段）：kimi-256k 首请求 400 报错原文；《三省吾身》对话 2301 entries / 762,499 body 字符实测（sqlite 直查）；conversation_participants 游标快照
2. **修复后用例**：
   - 仓储测试：createParticipant 带 lastReadSeq 写入生效；缺省 = 0
   - 域层测试：manage-participant.join 在已有 N 条 entries 的对话进场 → getUnreadEntries 只返回进场后条目（N 条历史不可见）；空对话进场 → 开场白可见
   - 进场 system entry 对新獭不可见（sender=自己，固化既有语义防回归——检视 S2 订正后的现实断言）
   - 迁移测试：构造 active × last_read_seq=0 存量行 → 迁移后 getUnreadEntries 返回空（或仅迁移后新消息）；幂等（二次执行零改动）
   - 回归：web-assistant-provisioner / ensure-recruiting-conversation 场景首批獭仍能读到开场白
3. **端到端验证（alpha 实例）**：在大对话（可复用《三省吾身》结构造数据）create_otter → 首请求注入量从 ~200K token 降到简报量级（预期 <10K）

### 自检清单逐项作答（实现后，随 PR 呈验）

**最简实现检查（必答）**：已过——两处写入点均为最小改动（实体可选字段 + INSERT 参数化 + join 先读后写），迁移为单条 SQL UPDATE 复用既有 last_read_seq 列，无 schema 变更、无新表、无新依赖；未新建任何抽象层，场景 A 调用方零改动。

**负面向验收（必答）**：本次变更破坏了什么旧契约——「新进场獭自动通读全对话历史」的隐式行为（F20260913ctlv 口径）被有意废除：新獭的未读不再含进场前历史，依赖「小獭自己翻历史」的潦草派工会直接暴露（背景供给责任显式归位派工简报/检索工具）；未绕过任何既有保护——未动 getUnreadEntries 查询形态、未动 pushCursorOnStartup 推进逻辑、未动 schema。

**pre-existing 声明**：无——全量测试 304 文件 4271 条全绿，无任何失败需要声明为 pre-existing。

**Golden Gate**：verify_by=static_only，豁免跑 gate；豁免声明写入 PR Verification 节。

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/db/conversation/conversation-repository-mixins.ts | M | createParticipant/createParticipants 支持 lastReadSeq 初值，注释口径更新；新增一次性迁移函数（active × 0 游标 → max(seq)），随启动路径执行 |
| src/usecases/conversation/conversation-repository.ts | M | 接口签名 + ConversationParticipant 可选字段 + 迁移函数接口（对齐 backfillLastReadSeq 可选方法先例） |
| src/usecases/conversation/manage-participant.ts | M | join 计算 maxSeq 作为进场游标 |
| .pi/skills/otter-summon/SKILL.md | M | 补「新獭看不到进场前历史，背景写进简报」约定 |
| tests/（仓储 + manage-participant 用例） | M/A | 上述验证节用例 |
