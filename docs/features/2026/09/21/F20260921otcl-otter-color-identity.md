---
id: F20260921otcl
title: 海獭颜色身份：出生属性化
doc_type: feature

# 记忆索引
summary: |
  海獭颜色身份治本：颜色成为小獭的出生属性（otters.color 列，创建时挑对话内未占用色），
  大獭恒定品牌棕由 type 判定。SSE/entries/participants 三条契约补 otterType+otterColor，
  前端视觉解析收敛单一入口，删除「按到达顺序发色」的模块级动态色池与 BIG_OTTER_IDS 历史兜底。
  起因：SPA 化（#1057）后切对话不再整页刷新，大獭 UUID 依次进池各领一色——实时渲染颜色漂移，
  刷新后「错得一致」。

# 因果链路
causal_links:
  from: [F20260920spag, F20260826avtr]

# 元数据
change_type: feature
capability_test: "n/a: 无 LLM 参与行为；逻辑验证走 web/服务端单测（色分配、回填迁移、视觉解析三态）"
created_in_conversation: 24c3cbfb-fb63-43d8-a3bf-791dd522e445
tags: [web-ui, otter-identity, api-contract, database-migration]
modules: [src/entities/otter/, src/usecases/otter/, src/interface-adapters/http/, src/frameworks/db/, api-contract/, web/src]
---

# 海獭颜色身份：出生属性化

## 背景

搭档报告（意图锚，原话引用）：

> 「我就说今天咋感觉有点奇怪，大獭的配色咋在变化？实时渲染是一个颜色（啥色都有），然后我刷新后又变成统一色（这才对）」
>
> 「等等，不能是type吧，颜色是否应该作为一獭出生就带有的属性，否则，多只小獭如何保持住自己的颜色呢？」
>
> 「创建小獭本来就要耗时，在创建小獭过程中，查一下当前对话中仍存活的海獭用了哪些颜色，然后挑个未用过的，我不觉得这非常复杂，也不需要跨进程锁」
>
> 「ok，这才对啊！不要把简单问题复杂化、也不要把复杂问题想简单了！解决的核心是抓住核心点！」

**排查结论**（troubleshooting 阶段，本对话 2026-09-21）：

- 设计意图：视觉身份是身份的纯函数——大獭恒定品牌棕，小獭按 ID 区分，同一只獭任何路径任何时刻一致。
- 实际实现不存在该纯函数：① 消息区/左栏/输入框调 `getOtterColor` 不传 type（MessageList.tsx:560、LeftPanel.tsx:270、MessageInput.tsx:161）；② 色池按**到达顺序**发色（otter-colors.ts 模块级 `nextColorIndex`，非确定性）；③ SSE 事件不带 type（api-contract/sse/events.ts），名册未到时前端占位硬编码 `type:'small'`（conversation/index.tsx:203）；④ `BIG_OTTER_IDS` 历史兜底（`o1`/`big-otter`）对生产 UUID 大獭永久失效。
- 显形机制：大獭是每对话一行独立 otter（200+ 行 `type='big'`，各挂一个对话）。MPA 时代切对话=整页刷新=色池计数器清零，单页面只有一个大獭 UUID 恒拿首色，「错得稳定」；9/20 SPA 化（#1057）后模块状态跨对话存活，多个大獭 UUID 依次进池各领一色——「实时啥色都有，刷新后统一（但仍非品牌棕）」。
- 附带发现：现有色板 8 项中仅 5 个不同色相（caramel×3、teal×2、lavender×2 重复）。

## 目标

- T1: 大獭视觉恒定品牌棕——消息区/左栏/输入框/右栏/弹窗，实时、刷新、历史三路径一致
- T2: 小獭颜色成为出生属性：创建时从色板挑「本对话内存活小獭未占用的色」，落 `otters.color`，终生稳定
- T3: 视觉解析收敛单一入口：前端一个 `resolveOtterVisual` 函数承接全部取色/取头像，删除动态色池与 `BIG_OTTER_IDS` 兜底
- T4: 色板去重至 8 个真正可分的色相
- T5: 存量小獭（active 54 + dissolved 808）一次性回填 color

## 非目标

- 不动「每对话一行大獭」的参与者模型（会话隔离是既有设计，非 bug 源）
- 不动头像分配机制（F20260826avtr 的 hash 池 + localStorage override 独立运作，本次只动颜色）
- 不做用户改色 override、跨设备头像持久化（issue #515 另议）
- 不做全局唯一颜色池（分配域=对话内，与「多小獭对话内区分」的需求对齐）

## 未决问题

- 无（SSE 发射处取 otter.type/color 的路径在实现期确认：上下文有实体则直取，仅 ID 则加一次 repo 查询/进程内缓存，属于实现细节不影响契约形状）

## 方案设计

### 1. 数据模型

`otters` 表新增 `color TEXT NULL`——存色板 key（如 `teal`），非色值。

- NULL 语义：大獭（恒品牌棕，type 判定，不参与分配）+ 未回填存量（T5 迁移后仅剩异常路径）
- **schema 字段消费方声明（⑥）**：CreateOtter（写）、启动迁移（写）、participants DTO / SSE 事件 / entries DTO（读，经 otter 行投影）、前端 `resolveOtterVisual`（最终消费）

### 2. 色板（单一事实源）

色板 key 列表与色值定义收敛到 **api-contract 层**一份模块（审视处置定稿：web 与 src 同级消费，contract 是依赖方向正确的共享层；放 entities 会造成 web 反向依赖 src 破坏分层）：

- 后端只消费 key 集合（挑色校验、回填）
- 前端消费 key→hex/gradient/nameClass（替换现 otter-colors.ts 的重复色板）
- 8 个去重色相：teal / caramel / lavender / rose / amber / sage / slate / plum（具体色值实现期按现有设计 token 就近取）

### 3. 出生分配（CreateOtter）

`create-otter.ts` 的 `execute` 内，`type='small'` 时：

1. `CreateOtterInput` 增加可选 `conversationId`（UI 弹窗与 create_otter 工具调用处均持有，控制器层注入）
2. 查询该对话 active 参与者的已用 color 集（join conversation_participants + otters，一次 SELECT）
3. 从色板挑第一个未占用 key；8 色全占用时挑占用数最少的第一个——**并列时取色板数组中 index 最小者**（确定性 tie-breaking，保证迁移回填与实时分配行为一致）
4. 大獭创建路径不分配（color=NULL）

无 conversationId 的异常路径：color 落 NULL，前端展示回退（见 §5）。

### 4. 契约变更（三条路径补身份字段）

| 路径 | 变更 |
|---|---|
| SSE 事件（entry.speak / entry.yield / entry.failed / entry.aborted / invoke.start / invoke.end） | 增加可选 `otterType`、`otterColor`（api-contract/sse/events.ts:19-57） |
| participants DTO | 已有 `otterType`，增加 `otterColor` |
| entries DTO | 已有 `senderType` 映射，增加 `senderColor`（查询时 join otters 一次） |

前端 `LocalMessage` 增加 `otterType`/`otterColor` 透传；SSE handler 与 mapEntryDTO 直接携带，不再依赖名册到达时序。

### 5. 前端收敛

- 新 `web/src/lib/otter-visual.ts`：`resolveOtterVisual(otterId, identity?)` → `{ color, avatar }`。identity 含 type+color 时走库值；缺失时展示回退：type 缺失按 small、color 缺失按 fnv1a(otterId) 落色板（纯展示兜底，不落库、不与主路径竞争）
- `otter-colors.ts`：删除 `smallOtterColorMap`/`nextColorIndex` 动态分配与 `BIG_OTTER_IDS`；`getOtterColor` 收敛进 otter-visual.ts 并私有化（不再导出，调用点不可能绕过）
- `otter-avatars.ts`：删除 `BIG_OTTER_IDS` 兜底（type 已处处可得）
- `conversation/index.tsx` 占位 upsert：使用事件携带的 otterType/otterColor，删除硬编码 `type:'small'`
- 调用点改造：MessageList（消息自带 identity 优先）、LeftPanel、MessageInput（otters 列表项自带）
- `OtterAvatar.tsx`（审视发现 1 补入，第四条渲染路径）：内部改调 `resolveOtterVisual`，签名增加可选 `color` prop——父组件持有库色（消息事件色 / otters 列表色）时传入，不传时内部按 identity 兜底。调用方清单（爆炸半径，grep 实测 6 处）：MessageList.tsx:579、Modals.tsx:129/562、RightPanel.tsx:400、SessionModal.tsx:203、OtterProfileCard.tsx:37——均因签名向后兼容（可选 prop）零强制改动

### 6. 存量回填（启动迁移）

迁移逻辑：按 conversation 分组，组内小獭按 createdAt 升序依次挑未占用色写 `otters.color`。active 与 dissolved 全量回填（历史消息含已解散獭；「历史正确答案不存在，任何稳定分配均成立」）。行数 862，毫秒级。

**幂等策略**（审视处置补入）：fill-only 续算——重跑仅处理 `color IS NULL` 的小獭，占用集 = 同对话已填色。因算法本身是「顺序挑未占用」，中断后续算结果与一次跑完一致（真幂等），无需「先清后填」。

## 审视与处置记录（第 1 轮，2026-09-21）

检视獭：色案检视獭（mimo，异模型）。报告合规（焦点声明/分级/锚点/门控三问齐全），锚点抽查 3 处无造假（行号偏差 2-7 行内，逻辑正确）。

| # | 发现 | 级别 | 决策树判断 | 处置 |
|---|---|---|---|---|
| 1 | OtterAvatar.tsx 是遗漏的第四条渲染路径（直接 import getOtterColor，删池即编译错） | 🔴 严重 | 改了更好（grep 复核属实，作者清单盲区） | 接受并修复：改动范围表补入，改造策略见 §5 |
| 2 | >8 獭撞色 tie-breaking 未定义 | 🟡 建议 | 改了更好（一行字消除实现歧义） | 接受并修复：§3 补「并列取色板 index 最小者」 |
| 3 | 迁移幂等声明与算法不匹配 | 🟡 建议 | 改了更好（fill-only 续算真幂等，优于含糊声明） | 接受并修复：§6 补幂等策略 |
| 4 | 色板归属 api-contract vs entities 未定 | 🟡 建议 | 改了更好（依赖方向：web/src 同级共享归 contract） | 接受并修复：§2 定 api-contract |
| 5 | OtterAvatar 改签名的调用方清单未枚举 | 🟡 建议 | 改了更好（爆炸半径先见） | 接受并修复：§5 枚举 6 处调用方 + 可选 prop 向后兼容策略 |

**重对抗门结论**：确认治本（检视獭三问核验：四问齐全 + 删除失效机制 + 数据模型层解决 + 单一入口消除调用点纪律依赖）。

处置方式说明：五条全走决策树均判「改了更好」，无反驳项——每条经作者独立复核（发现 1 的 import 在作者 grep 输出中原始存在，非检视者误读；2-4 为规格缺口事实成立），非照单全收。

## 影响范围

- 消息区/左栏/输入框/右栏/弹窗的海獭视觉（全量，行为变更=颜色来源切换）
- 小獭创建流程（多一次 SELECT，创建耗时增加可忽略——搭档已确认此判断）
- SSE 消费端（新增可选字段，向后兼容；本地单进程同仓同发，无灰度问题）
- 老对话历史消息颜色将变化（原为按到达顺序的错误色，回填后为稳定色）——预期内

## 风险与约束

- SSE 发射处（agent-runtime）若仅有 otterId 无实体，需补查询/缓存——实现期确认，量级可控
- >8 小獭同对话时必撞色（挑最少占用）——现状数据最多 3 獭/对话，接受
- 回填为一次性启动迁移，失败需幂等重跑（迁移框架保证）

## 不兼容更新

- [Incompatible] `otters` 表加列（nullable，旧代码可读写，无锁表）
- [Incompatible] web 端 `getOtterColor`/`getOtterAvatar` 导出面变化（前端内部 API，PR 内同步改完，无外部消费者）

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 颜色锚定方式 | 出生属性落库 | fnv1a hash 派生（头像同款） | 对话内不撞色需要「出生时看一眼同伴」，hash 做不到；落库语义直观（搭档拍板：「颜色应该作为一獭出生就带有的属性」） |
| 分配域 | 对话内 | 全局唯一 | 需求是「多只小獭在对话内可区分」；全局池 8 色远不够用 |
| 撞色兜底 | ≥8 獭时挑最少占用 | 扩色板 | 现状最多 3 獭/对话；扩色板损伤色彩可辨识度 |
| NULL 展示 | fnv1a 派生回退（纯展示） | 强制迁移后不允许 NULL | 数据缺失时「必须有颜色可画」的鲁棒性；回退不落库不污染主路径 |
| 大獭识别 | type 判定（契约已带） | 保留 BIG_OTTER_IDS 兜底 | 生产 ID 为 UUID，兜底永久失效=死代码；type 三路契约补齐后处处可得 |

**机制识别检查点**：命中「新增持久化字段」「新增决策分支（出生分配）」——按流程答机制预算四问：

- ① **谁需要它**：用户——同一只獭颜色稳定的视觉预期；多小獭对话内区分发言者。间接消费方：四条渲染路径（消息区/左栏/输入框/右栏）
- ② **失败后果**：用户可感知（颜色漂移、误认发言者——本次事故本身）；无数据损害、无内部指标异常
- ③ **后续机制**：color 列可能出错的状态——NULL（未回填/异常创建）→ 前端展示回退承接；对话内撞色（>8 獭或极端并发创建）→ 无自动修复，用户可感知，接受（罕见）；修改色需手动 UPDATE 或重开獭
- ④ **退役条件**：引入「用户自选颜色」需求时本列改为 override 基线；前端视觉全量后端 token 化时被吸收

**修法排序声明**：本特性非 bug 修复路径，属治本性重构——把「视觉=现场拼装」改为「视觉=身份属性投影」，删除动态色池机制（净删除一项）同时新增 color 列（净新增一项）。按 worktree-isolation 规范，commit 声明 `Modification-Class: mechanism-addition`（含新增字段，从严声明）。

**重对抗门**：与方案对抗审视合并执行（检视獭同轮审查门控三问），结论留痕于审视报告。

## 验证

**失败用例先行**（bugfix 硬规则，修复前红）：

1. web 单测：`大獭消息颜色 === 品牌棕`（构造 senderId=UUID + type='big' 的消息，断言 resolveOtterVisual 输出）——修复前失败（现状走动态色池）
2. web 单测：`同 otterId 跨多次实例化颜色一致`（模拟两个对话先后到达的两个大獭 UUID 各自渲染，断言互不影响且各自稳定）——修复前失败（顺序分配互相挤占）

**新增覆盖**：

- 服务端单测：色分配（空对话取首色 / 占用集跳过 / 8 色用尽最少占用 / 大獭不分配）
- 迁移单测：分组回填不撞色（同对话 ≤8 獭互异）、幂等重跑
- web 单测：resolveOtterVisual 三态（identity 完整 / color 为 NULL / identity 缺失）

**手工验收**：两个对话看大獭同为品牌棕；同对话建 2 小獭异色；实时与刷新一致；解散獭的历史消息稳定显色。

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/db/（schema+迁移） | 改 | otters 加 color 列；存量回填迁移 |
| src/entities/otter/otter.ts | 改 | Otter 实体加 color 字段 |
| src/usecases/otter/create-otter.ts | 改 | 出生分配逻辑 + conversationId 入参 |
| src/interface-adapters/http/controllers/* | 改 | 创建入口注入 conversationId；participants/entries DTO 加 otterColor/senderColor |
| api-contract/sse/events.ts + 相关 dto | 改 | SSE 事件加 otterType/otterColor |
| api-contract 色板模块 | 新 | 8 key 色板单一事实源（归属 api-contract，审视处置定稿） |
| src/interface-adapters/agent-runtime/ | 改 | SSE 发射处携带 otterType/otterColor |
| web/src/lib/otter-visual.ts | 新 | resolveOtterVisual 单一入口 |
| web/src/lib/otter-colors.ts | 改 | 删动态池与兜底，去重色板 |
| web/src/lib/otter-avatars.ts | 改 | 删 BIG_OTTER_IDS |
| web/src/pages/conversation/index.tsx | 改 | 占位 upsert 用事件身份；SSE handler 透传 |
| web/src/pages/conversation/{MessageList,LeftPanel,MessageInput}.tsx | 改 | 调用点切到 resolveOtterVisual |
| web/src/components/OtterAvatar.tsx | 改 | 内部改调 resolveOtterVisual；签名加可选 color prop（审视发现 1 补入） |
| web/src/components/OtterProfileCard.tsx | 查证 | OtterAvatar 调用方，可选 prop 下零强制改动，实现期回归验证 |
| web/src/lib/mappers.ts | 改 | LocalMessage 加 otterType/otterColor；mapEntryDTO 投影 |

---

# 实现记录（2026-09-21，开发獭 glm）

## 实现要点与落地偏差说明

### 色板落点与算法分层（实现决策）

- 色板常量 `OTTER_PALETTE_KEYS/OTTER_PALETTE_HEX/BIG_OTTER_HEX` 落 **api-contract/api/otter-palette.ts**（value 导出，双端消费）——按审视处置定稿
- 挑色算法 `pickOtterColor(paletteKeyOrder, occupied)` 落 **entities/otter/palette-picking.ts** 纯函数——entities 不 import 契约层（本仓 entities 零 @contract import，探查确认），色板 key 数组经参数注入；CreateOtter（usecase）与迁移（frameworks）两处消费同一算法，tie-breaking 天然一致
- 前端样式映射（key→hex/gradient/nameClass）在 web/src/lib/otter-visual.ts 内部维护（不进契约——样式是前端私域）

### SSE 发射处取 otter 实体的方式（方案未决问题，实现期决策）

**决策：上下文有实体则闭包透传，无实体则终态处一次查询。** 各发射点：

| 发射点 | 方式 | 依据 |
|---|---|---|
| invoke.start / entry.speak（agent-invoker） | 闭包透传——invokeConversationInner 已查 otter 实体（308 行），经 createAttemptDriver opts 带入 | 零额外查询 |
| entry.yield（tool-factory） | 实体在手直透（yieldOtter = getById 全实体） | 零额外查询 |
| invoke.end / entry.failed（orchestrator 终态路径） | 终态处 getOtterById 一次查询（TurnCallbacks 既有回调扩 color 字段） | 终态一次，量级可控；completed/failed/aborted 各路径补齐 |
| entry.aborted | 后端无发射点（契约定义未变），前端由 invoke.end 终态收敛 | 维持现状 |

不选进程内缓存的理由：闭包透传已覆盖高频路径（speak 每条消息一次），仅终态多一次 SELECT（每 invoke 恒一次），缓存引入失效问题（dissolve 后色不变但 type 查询也失效）得不偿失。

### entries DTO 的 type 缺口（实现决策）

EntryDTO 只补 senderColor（按方案 §4）；sender 的 big/small type 不随 entry 携带——前端渲染时从 otters 名册查 id 得 type（现状已有），名册未到且 scolor=null 时走 fnv1a 回退。大獭历史消息在名册加载后恒品牌棕，加载前瞬间回退色可接受（刷新即修正）。

### 迁移 join 表修正（真启动验证发现的实现偏差）

首版迁移 join 遗留表 `conversation_otters`（219 行，几乎全大獭归属）→ 生产副本真启动显示回填 0 行。修正为 join 现行参与者表 `conversation_participants`（1077 行，含全部小獭归属）后重验：855 行回填。**这个偏差单测摸不到**——内存库自建 schema 时两张表都由测试自己 seed，join 哪张都「对」；只有生产副本的真数据形态（两张表行数悬殊）暴露了歧义。教训印证了「真启动验证」硬规则的必要性。

### 前端 OtterAvatar 调用方回归（方案改动范围表「查证」项）

6 处调用方零强制改动实测：OtterProfileCard.tsx:37 / Modals.tsx:129,562 / RightPanel.tsx:400 / SessionModal.tsx:203（不传 color，type 在手走库值或回退）；MessageList.tsx:579 升级传 color（消息事件色优先）。web tsc + 518 测试全绿佐证。

## 验证结果

### 失败用例先行（修复前红，证据：对话工作区 otcl-prefail-evidence.txt）

- 用例 1b（MessageList 实际调用形态，不传 type）：**红**——大獭 UUID 落动态色池拿 `#4A9B9B`（teal）而非品牌棕 `#8B6F47`，即搭档报告的病灶复现
- 用例 2b：留证旧顺序分配行为（任意两小獭 UUID 必不撞——无对话域概念）
- 用例 1/2（type 明确时）修复前即绿——旧代码 type 路径本就正确，病灶在「调用点不传 type」，与排查结论一致

### 测试（全绿）

- root：266 files / 3652 tests passed（含新增 otter-color-migration.test.ts 6 用例 + create-otter.test.ts 出生挑色 7 用例）
- web：58 files / 518 tests passed（含新增 otter-visual.test.ts 11 用例；otter-avatars.test.ts 1 用例随 BIG_OTTER_IDS 删除同步改写为「兜底已删」契约）
- lint：0 errors / 8 warnings——**全部 pre-existing**（git stash -u 基线对照输出同样 8 warnings 0 errors，证据在 PR Verification）

### db 迁移真启动验证（证据：对话工作区 otcl-migration-boot-evidence.txt）

- 生产副本（924MB）置于 os.tmpdir，worktree dist 完整启动：`Added color column` + `Backfilled otter colors (855 rows)` + `server running at :3999`，无 SqliteError
- 回填正确性：855 着色 / 10 NULL（全为无对话归属孤儿，符合设计）/ 大獭 0 着色 / 同对话撞色 0 组
- 幂等重跑：二次启动零回填日志、行数不变
- API 实测：participants 带 otterColor（本对话：大獭 null / 检视獭 caramel / 开发獭 lavender），entries speak 条目带 senderColor

### 最简实现检查

已过：色板三常量一文件、挑色一纯函数、前端一入口函数；未引入新依赖、未建新表、未加 settings 幂等键（fill-only 免键）；删净旧机制（动态池 27 行 + BIG_OTTER_IDS 2 处）。

### 负面向验收条目

本次变更破坏的旧契约：① web `getOtterColor` 导出删除（前端内部 API，PR 内同步改完）；② `BIG_OTTER_IDS` 历史兜底删除——type 缺省时 'o1'/'big-otter' 不再判大獭（生产 UUID 本就打不中，死代码）；③ 老对话历史消息颜色将变（原为按到达顺序的错误色，回填后为稳定色）——预期内。绕过的既有保护：无（挑色失败不阻断创建是新增容错，非绕过）。

## 提交信息

- commit：`[F20260921otcl][web][Feature Update][Incompatible] 海獭颜色身份出生属性化：otters.color 列 + 存量回填 + 三路契约补身份字段 + 前端视觉解析收敛单一入口`
- Modification-Class: mechanism-addition（方案已声明，含机制识别检查点四问答案，见上文「设计取舍」节）
