---
id: F20261006mtlp
title: 事情闭环机制（Matter Loop）：未完成之事从对话流升格为承诺台账
summary: 对话流是通信不是承诺——需要搭档拍板的决策会被新一轮自动消息顶走、无声过期。本方案引入 matter（用户侧命名「待办」）一等实体：per-conversation 承诺台账 + 五态状态机（含迁移矩阵守卫与等待方生命周期规则）+ 宣告权沿用决策分级轴（默认通过模式互斥不登记）+ 未闭环清单进 restart 机械供料 + 右侧栏「待办」tab 呈现 + 裁决双通道（对话直复=主路/板上按钮=兜底）。L2 简报卡被吸收为待裁决态呈现形态，未闭环扫描从文本启发式升格为确定性状态查询。
doc_type: feature
change_type: feature
intent:
  problem: "搭档国庆放假几天后回到《三省吾身》对话，海獭每日产出堆积，需要拍板的决策被新一日输出顶上去无声过期——『我看到你们海獭说了很多话，但我却已经懒得从第一句开始翻了』。对话是 append-only 的流，为最新优化；待决策是有生命周期的状态，塞进流里必然丢失。"
  why_now: "搭档 2026-10-05 明确提出『本系统是否应该引入一个待决策清单机制』并定调设计约束（不看 issue / 每对话一个视图+就地操作 / 重启绑定 / 事情处理闭环为本 / 逾期出 scope），是明确的机制设计窗口。"
  expected_effect: "每个对话一块事情板：未办完的事钉在板上（不被消息流冲刷），搭档打开对话第一眼看到待裁决事项并就地操作；獭重启后新世獭从机械供料拿到未闭环清单，session 封存不再等于事情失传；闭环必须经有资格者宣告（L2 必须搭档确认），无声过期结构性消除。"
  verify_by:
    type: human_judge
    note: "交互与视图效果由搭档日常体验判定（搭档明确要求 UI 高保真稿先行确认）；数据模型与状态机正确性由 vitest 单元测试锁定；重启供料链路由能力测试覆盖"
capability_test: "tests/capability/matter-loop/matter-loop.capability.test.ts"
created_in_conversation: e871769f-a731-4278-ae21-de3ab4c8eaf8
created_at: 2026-10-06
tags: [matter-loop, conversation-layout, ux, decision, handoff, scheduled-task]
modules: [src/frameworks/db/schema.ts, src/entities/, src/usecases/, src/interface-adapters/agent-runtime/handoff-support.ts, packages/web/, prompts/scheduled/]
causal_links:
  - F20260909debr
  - F20260917swsh
  - F20260831hndp
  - F20260826mwrd
---

# 事情闭环机制（Matter Loop）

> 修订史：2026-10-05 初稿。需求由搭档在对话 e871769f 提出，大獭（kimi）第一轮分析 + 思澜（glm）头脑风暴修正后收敛，搭档拍板「落方案」。2026-10-05 第一轮对抗审视（审视獭 mimo-pro，焦点=机制内部一致性/承诺校准/现有机制边界）：4 严重 6 建议全部本 PR 修复——补状态机迁移矩阵+等待方生命周期规则（严重 1/4）、消费方读方对账+resolved_by 字段+近期闭环区（严重 2）、R8 默认通过模式硬边界（严重 3，互斥不登记）、L0 不产生 matter、承诺半径声明、P1 含只读最小板+审计环日巡、produced 建链责任方、扫描归属与去重键、机制预算四问补遗、「回头再说」定案手动登记。2026-10-05 终审后修订（搭档追问驱动）：①落点改右侧栏第五 tab；②准入纠错为仅 L2 显式拍板 yield；③新增 §3.5 裁决双通道；④未决问题 1 定案；⑤命名定「待办」。2026-10-05 第二轮完整审视（复核獭 glm，独立焦点无清单）：5 严重 5 建议全部本 PR 修复——补 owner_otter_id 字段（打回/唤醒/重派三处路由依据）、准入判据载体=yield 打标参数+防漏报兜底如实声明、獭侧 matter 工具入改动范围表且 P1 就需要、修订涟漪清扫（summary/§1 残留旧落点）、同步 main 解 CI；矛盾裁决时序语义、日巡停滞→三省吾身提醒、卡回执同 cardId 永久关闭坑标注、分期各自验收标准、非负责獭代执行路径。①呈现落点从「对话头部横条」改为**右侧栏第五 tab**（搭档指定，保真稿 v1 头部横条废弃，v2 按 RightPanel 样式基源重做）；②准入路径 1 表述纠错——非「所有 yield」而是**仅 L2 显式拍板项**（L0/L1 不 yield 不开、L2 默认通过不开）；③新增 §3.5 裁决双通道（对话直复=主路，獭识别+复述确认迁移状态；板上按钮=兜底），修正「强制点板」漏洞；④未决问题 1 定案（回执管道核实可行）；⑤用户侧命名定「待办」，matter 留作内部代号/表名。

## 背景

搭档国庆放假后回到《三省吾身》对话的原话（意图锚）：

> 「我这几天国庆放假，然后我回来后，在对话《三省吾身》中遇到一个情况，我看到你们海獭说了很多话，但我却已经懒得从第一句开始翻了，但是我觉得每日都会跑一些动作然后应该是有一些决策是需要我来做的，但又会被新的一日给顶上去了。」

设计约束（搭档原话定调）：

> 「我肯定不去看 issue 的，所以还是本系统要有这种机制，需要我决策的，我应该能在一个地方看到（每个对话下）以及方便的操作，甚至你还要思考到，每日任务很多都会重启獭生，那新的獭如果去知道我现在的决策要回到哪一个事情上。我认为这个本质是**事情处理闭环**。现在先不要去思考逾期策略，我认为先思考好这个闭环，然后自然就不需要去思考逾期了。」

### 第一性诊断（大獭 + 思澜共识）

1. **流与状态的错配**：对话是 append-only 的流，为「最新」优化；「待决策」是有生命周期的状态（pending → resolved）。把状态塞进流里，scroll-back 是唯一检索手段，成本随时间线性增长。
2. **本系统已有同构解法**：linked resources 抽「产物」、workspace 抽「文件」、signal events 抽「协调信号」（`src/frameworks/db/schema.ts:711`）、RHI signals 抽「健康问题」——matter 是第五次同构扩展：把**「未完成之事」从通信升格为承诺**。
3. **决策不是事情，决策是事情的属性**（思澜修正大獭方案 A）：只抽「待决策点」是修症状最响的一格——搭档批完决策，事情的其余部分（进度、上下文、谁在等）仍埋在流里，半开环照旧。最小闭环单位是 matter，决策点是它的一个状态。
4. **半开环比决策积压更致命**（思澜）：积压至少有形态（獭在等，搭档知道有东西在等）；半开环完全无信号（獭说「已完成」→ 被重启 → 新獭叙事里这个尾巴根本不存在）。国庆场景里「旧决策无声过期」只是半开环的一种死法。
5. **闭环的灵魂是宣告权分权，不是逾期**（思澜修正大獭）：逾期策略预设系统当裁判；闭环模型里唯一裁判是搭档。板上可见的事情永远不会无声地死——「无声过期」变「有声等待」，逾期问题结构性消解。这印证了搭档「想清楚闭环就不需要想逾期」的直觉。

### 历史脉络

- F20260909debr 决策分级：L0 獭自治 / L1 獭拍板留痕 / L2 搭档拍板（简报卡 + 默认通过模式）——本方案宣告权分权沿用同一根轴
- F20260917swsh 三省吾身整合：5 个日任务收拢单对话，产出统一走 issue——但 issue 不被搭档消费（本次搭档原话否决），且所有产出最终落回对话流，这是本方案要补的断点
- F20260831hndp 交接叠加档案：restart 档案 = 叙事 + 机械供料——叙事会省略，状态清单一条不能省，故 pending 清单必须进机械供料层
- F20260826mwrd 獭间信号台账：signal_events 表是「瞬时协调信号」的先例——matter 表结构与其同构（per-conversation、状态字段、事件留痕），但语义不同（持续工作单元 ≠ 瞬时信号），不复用

## 目标

- T1: **承诺台账**：每个对话一张 matter 表，未完成之事以状态机登记，不被消息流冲刷
- T2: **每对话一个视图 + 就地操作**：右侧栏新增「待办」tab 常驻显示 open 事项；搭档裁决**双通道**——对话内直接回复即裁决（獭识别并复述确认后迁移状态），板上按钮是兜底通道（獭不在场/自助时用）；操作回写状态并唤醒等待中的獭
- T3: **重启绑定**：restart_otter 新世獭的机械供料含「本对话未闭环事情清单」（确定性字段，不进叙事合成）
- T4: **宣告权分权**：L0 不产生待办；L1 獭闭环留痕搭档可翻案；L2 必须搭档确认才 CLOSED
- T5: **准入收敛**：matter 只能由白名单动作产生（**L2 显式拍板项的 yield to user**（默认通过除外）/ 搭档说「回头再说」/ 跨日未收尾任务），獭不能随手开
- T6: **现有机制升格不废弃**：L2 简报卡被吸收为 matter 待裁决态呈现形态；未闭环扫描从文本启发式升格为确定性状态查询

## 非目标

- ❌ 逾期策略 / TTL / 自动关闭（搭档明确出 scope：闭环想清楚自然消解；剩余的定期清理是运维不是设计）
- ❌ 跨对话聚合面板（每对话一块板；跨对话视角由三省吾身每日扫描当派生视图）
- ❌ 外部载体（GitHub issue / 其他 App——搭档原话「我肯定不去看 issue 的」）
- ❌ 移动端 / 独立界面（现阶段呈现面就是右侧栏 tab）
- ❌ issue 勾选清单改造（短期并存；「每日开工审批 = 周期性 matter 特例」标注为开放问题，不强行统一）
- ❌ linked resources 与 signal events 的合并或替代（语义不同：产物承诺 / 瞬时协调 ≠ 过程承诺）

## 方案设计

### 1. 实体模型：matters 表

新表 `matters`（同构于 signal_events，schema.ts 新增 createMattersTable）：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | 跨 session 稳定短锚（M-xxx 人可读 + UUID）——填补空档：现在跨 session 引用只有消息 ID（在流里要翻）和 F 文档 ID（太重） |
| conversation_id | TEXT NOT NULL | namespace = 对话归属（搭档约束：每对话一个视图） |
| title | TEXT NOT NULL | 一句话事情名 |
| origin_message_id | TEXT | 发起消息锚点（溯源回流） |
| owner_otter_id | TEXT | **负责獭**——创建时写入（路径 1=发起 yield 的獭；路径 2=登记时在场獭；路径 3=任务原属獭）。WAITING_PARTNER 态下 waiting_on=partner 但 owner 保留——搭档打回迁给谁、板上裁决后唤醒谁、扫描重派给谁，三处路由统一读 owner（对照 signal_events 的 from_otter_id） |
| level | TEXT | L1 / L2（L0 不产生待办，见 §3） |
| state | TEXT | 状态机当前态（见 §2） |
| waiting_on | TEXT | 当前在等谁：partner / otter:<id> / none |
| waiting_for | TEXT | 在等什么动作（一句话，如「选 A 还是 B」「确认处置结果」） |
| payload | TEXT | 决策请求挂点内容（L2 时 = 简报卡三层结构 JSON）。**简报内容单源**：WAITING_PARTNER 期间简报内容的真相在 payload，消息流内卡片是渲染投影；修订简报 = 改 payload + 重渲染投影，不在流内改卡片原文 |
| resolution | TEXT | 裁决/闭环结果回写 |
| resolved_by | TEXT | 闭环宣告者/实际执行獭（partner / otter:<id>——N1 修订：统一记实际执行者，被代理者身份经 resolution「代搭档执行：<原话>」留痕）——宣告权分权（T4）的可审计留痕，对照 signal_events 的 resolved_by（schema.ts:721-723） |
| created_at / updated_at / closed_at | TEXT | 时间线 |

索引：(conversation_id, state)、(state)、(waiting_on)。

**消费方声明（⑥纪律，读方对账）**：matters 表的读方 = ①右侧栏「待办」tab（读 open 列表渲染；含折叠「近期闭环」区读 closed 列表，是翻案入口）②restart 机械供料（读 open 清单注入新世档案）③三省吾身未闭环扫描（读 open 清单）④獭侧 matter 工具（list/transition——獭查板、代执行迁移的读路径）。写路径 = 登记/裁决/闭环/翻案 usecase（状态迁移单入口）。逐字段读方：title/state/waiting_on/waiting_for/owner_otter_id → ①②③④；payload → ①（裁决界面渲染）；resolution/resolved_by/closed_at → ①「近期闭环」区（翻案与留档查看）；origin_message_id → 溯源回流（①条目点击跳起源消息）。无「先存了再说」字段。

状态转移日志复用既有模式：转移时向对话写一条 system 类 entry（通知性投影）+ 更新 matters 行。单一真相源纪律：**状态只在 matters 表，流内消息只是投影**。

### 2. 状态机

五个存续态 + 两个终态出口，合法迁移矩阵（from×to，含触发者与守卫）——**未列入矩阵的迁移一律非法，usecase 单入口拒绝**（验证节锁定）：

| 迁移 | 触发者 | 守卫/说明 |
|---|---|---|
| （创建）→ WAITING_PARTNER | 准入路径 1 | L2 yield to user 自动登记，生而待裁决 |
| （创建）→ OPEN | 准入路径 2/3 | 「回头再说」/ 跨日未收尾任务登记，先 OPEN |
| OPEN → WAITING_OTTER | 负责獭认领 | 登记 waiting_on=otter:<id> + waiting_for |
| OPEN → WAITING_PARTNER | 獭 | 需呈搭档拍板/确认时（附 payload 简报） |
| WAITING_OTTER → WAITING_PARTNER | 负责獭 | 獭干完需搭档裁决 |
| WAITING_OTTER → DONE_PENDING_CONFIRM | 负责獭 | 獭宣称完成（L1/L2），等闭环确认 |
| WAITING_PARTNER → DONE_PENDING_CONFIRM | 搭档裁决 | 裁决写入 resolution，獭按裁决执行后转待确认 |
| WAITING_PARTNER → WAITING_OTTER | 搭档 | 裁决为「打回/再改」时 |
| DONE_PENDING_CONFIRM → CLOSED | 见宣告权表 | L1=獭自关留痕；L2=必须搭档确认 |
| DONE_PENDING_CONFIRM → WAITING_OTTER | 搭档 | 「打回」：闭环确认不通过，退给负责獭续办 |
| CLOSED → OPEN | 搭档 | **翻案**：L1 獭自关后搭档不认可，重开（L2 闭环须搭档确认，理论上不存在翻案入口但保留迁移防误操作不可挽回） |
| OPEN/WAITING_*/DONE_PENDING_CONFIRM → SUPERSEDED | 獭（登记 superseded_by） | 被新 matter 取代（实现期修订：DPC 同样需要终态出口——獭宣称完成期间出现取代者） |
| OPEN/WAITING_*/DONE_PENDING_CONFIRM → ABANDONED | 搭档 | 明确不做（实现期修订：DPC 同样需要终态出口） |

（矩阵共 14 条存续迁移 + 创建 2 条；实现 19 entries = 创建 2 + 存续 17，含实现期补的 DONE_PENDING_CONFIRM 两条终态出口——语义上 DPC 也需要 SUPERSEDED/ABANDONED 出口，已在矩阵行内留痕修订。）

**等待方生命周期规则**（消灭无声悬挂）：①waiting_on 指向的獭被解散 → matter 自动转回 OPEN 待重派（每日扫描兜底发现），机械供料只救「重启的獭」，救不了「解散的獭」，故必须有这条；②对话归档 → 该对话 open matters 由搭档选择迁移到指定对话或 ABANDONED 留痕（F20260917swsh 有归档对话先例）；③裁决回执的唤醒目标已消亡 → 只写流内投影不投递，matter 态照常迁移，由扫描兜底重派。

闭环宣告权（出口分权，与 F20260909debr 入口分权同轴）：

| level | 闭环权 | 路径 |
|---|---|---|
| L0 | 不产生 matter | L0 是獭自治瞬态小事，不上板（准入白名单三条均产生不了 L0——见 §3；为 L0 造登记路径是纯噪音） |
| L1 | 獭闭环留痕，搭档可翻案 | 獭 → CLOSED（留痕；搭档在板上「近期闭环」区可重开为 OPEN） |
| L2 | 必须搭档确认 | DONE_PENDING_CONFIRM → 搭档确认 → CLOSED |

**与 R8 默认通过模式的关系（硬边界，审视严重发现处置）**：F20260909debr 默认通过模式（「我推荐 X，今天内无异议就开工」）自带时限语义，与「L2 必须搭档确认才 CLOSED」直接冲突——若默认通过项也入 matter 且要求显式确认，板上会堆积永不关闭的假「待裁决」。裁决：**走默认通过模式的 L2 项不登记 matter**（默认通过的语义就是「不需要搭档动作」，与「板上钉着等你」互斥），它仍受 R8 三判据约束（无不可逆后果/不涉对外承诺/否决成本 <1 天）；**携带默认通过语义的 yield 不触发准入路径 1 的自动登记**。由此默认通过的时限语义留在 R8 原地，不从后门溜进 matter 模型——matter 只装「必须等搭档显式动作」的事。这也与「逾期出 scope」非目标自洽：板上没有时限语义，只有等待时长的事实展示。

### 3. 准入白名单（生死线）

matter 只能由三种动作产生：

1. **L2 显式拍板项的 yield to user**：**判据载体 = yield 工具新增可选参数**（如 `expects_partner_decision: true`，改动范围表已列「yield 工具链路 M」——改的是这里）。獭打标即登记（防泛滥=机械：不打标不登记，板上不会多出来西）；**防漏报 = 打标纪律（prompt 层）+ 路径 3 扫描兜底**（跨日未收尾扫描同时捕获漏登记的 L2 待裁决项——同一对话有 WAITING_PARTNER 性质的 yield 超过 24h 未登记，扫描补登记并在三省吾身提醒）。承诺校准：白名单**防泛滥**不靠獭自觉（硬编码在产生路径），**防漏报**靠纪律+兜底（如实声明，不吹「全自动」）
2. **搭档说「回头再说」/「之后处理」**：搭档手动登记为主（板上「登记一件事」入口）+ 獭复述确认为辅（獭听到后说「我记到待办板上了，M-0xx」）；消息层 NLP 自动检测**不做**（漏检/误检都会腐蚀信任——漏检=照样无声死，误检=板上多出搭档没说过的事）
3. **跨日未收尾任务**：三省吾身未闭环扫描登记。**归属规则**：matter 记在被发现任务所在对话的 conversation_id（扫描跑在三省吾身，发现的是其他对话的事）；**去重键** = origin_message_id（同一消息锚点不重复登记）

獭随手不能开 matter。门槛一松，搭档从「懒得翻消息」变「懒得翻清单」，换个地方死。

### 3.5 裁决双通道（搭档 2026-10-05 追加，修正「强制点板」设计漏洞）

**对话是主路，板是兜底的网**——强制搭档点开板操作会背叛对话驱动的本质：

- **通道 A·对话直复（主路）**：搭档在对话里直接回复（「A 就 A 吧」「就这么办」）→ 收到回复的獭识别这是对某件 open matter 的裁决 → **獭代执行板上状态迁移**并复述确认（「M-032 按方案 A 处置，板上已更新」）。识别靠獭判断 + 复述确认闭环（说错了搭档当场纠正），**不做 NLP 自动判定**（误判腐蚀信任，与否掉「回头再说自动检测」同一理由）。**被唤醒獭非负责獭（owner）时同样可代执行**——迁移走 usecase 单入口（权限由守卫兜住），复述确认时注明代执行（「我代 M-032 的负责獭记上了」）
- **通道 B·板上操作（兜底）**：搭档主动点开右侧栏待办 tab 用按钮裁决——适用场景：假期回来扫积压、想不起来獭在说哪件时查锚点、獭已不在场时自助
- 两通道写同一张 matters 表，不产生分叉（单源纪律不变）。**矛盾裁决**：同一 matter 两通道先后冲突时，以时间序后者为准，迁移日志留痕前值（獭复述确认时可见冲突并告知搭档）

### 4. 重启绑定：pending 清单进机械供料

restart_otter 交接档案现状：交接意图书（自总结）+ 叙事合成 + 机械供料（谱系/文件轨迹/状态盘点/近期保留段，见 `src/interface-adapters/agent-runtime/handoff-support.ts:88` 的 context key 恢复机制）。

新增机械供料确定性字段 `handoff_open_matters`：新世獭进场档案含

```
本对话未闭环事情（N 件）：
1. [M-032] healing 信号 X 类处置方式 —— 待搭档裁决（已等 4 天），在等搭档回复
2. [M-035] 整洁架构补丁 #7 —— 獭处理中，本獭负责续办
```

关键性质：**matter 表活在 session 之外，獭生封存 ≠ 事情失传**——即使叙事合成彻底失败（机械降级），pending 清单仍在。这也回答搭档「新的獭怎么知道决策要回到哪件事上」：裁决回执对着 matter ID 操作，自动路由到等待方。

### 5. 呈现与操作：右侧栏「待办」tab（搭档 2026-10-05 指定落点，替代初稿「对话头部横条」）

**matter 不是消息**——任何以消息形态存在的东西都会被顶上去，这是搭档痛点的根因，视图不能重蹈覆辙。

- **落点**：对话页右侧栏第五个 tab（参与者 / 关键资源 / 定时任务 / 工作区 / **待办**），样式语言沿用现有 tab 体系（glass 面板、区块标题、玻璃卡条目、otter 渐变主按钮），不自造风格
- **tab 角标**：只数「等你裁决」+「待你确认闭环」（搭档欠的动作），不是全部 open 数——只有你欠的动作才配叫角标
- **条目排序**：WAITING_PARTNER 置顶（热边框高亮）→ DONE_PENDING_CONFIRM → WAITING_OTTER / OPEN（只读辅级）；折叠「近期闭环」区 = 翻案入口（低频操作藏折叠）
- **就地操作**（通道 B）：WAITING_PARTNER 条目内嵌裁决按钮（批准/否决/打回）；DONE_PENDING_CONFIRM 条目提供「确认闭环/打回」；「+」登记入口（准入路径 2）
- **裁决回写**：按钮操作 → matters 表状态迁移 + 流内通知性投影 + 唤醒等待中的獭。**回执通道已核实可行**（原未决问题 1 定案）：复用 otterCard.submit 管道（`web/src/lib/card-bridge.ts` + `useCardBridge.ts:114-155`——提交经预览闸、回执按 authorId 显式路由卡片作者，等待獭即作者），P2 实现时细化按钮挂点
- 跨对话聚合：不做独立面板；三省吾身每日扫描汇总各对话 open matters 作为派生视图

**UI 高保真稿**：已出 v2（右侧栏 tab，系统样式基源），交互确认点随本文档呈搭档（见修订史）。

### 6. 与现有机制的关系

| 机制 | 关系 |
|---|---|
| L2 简报卡 | **被吸收**：卡片是 matter 处于 WAITING_PARTNER 态的呈现形态；卡片未被批也有 matter 兜底，不再被顶走 |
| 未闭环扫描（三省吾身 7:30） | **升格**：从扫「回头再说」文本启发式 → 确定性查询 open matters，成为机制最重要的审计者 |
| linked resources | 不合并。resource = 产物承诺（存在了），matter = 过程承诺（没完）；matter 闭环产出资源时，由**闭环 usecase** 负责建链（资源登记与 matter 闭环同事务；如需记忆层溯源，闭环 usecase 同步落一条 fact 摘要并用 link_memory produced 连到该 fact——matter 是 DB 实体不是记忆条目，不能直接建 link_memory 边） |
| signal events | 不替代。objection/blocked/halt = 瞬时协调信号；matter = 持续工作单元 |
| R8 默认通过模式 | **互斥不登记**（见 §2 硬边界）：默认通过项不入 matter；板上只装「必须等搭档显式动作」的事 |
| issue 勾选清单 | 短期并存；长期看「每日开工审批」是周期性 matter 特例——开放问题，不强行统一 |

### 7. 分期（设计一次定死，实现分期——大獭立场，思澜倾向先跑数据形状试验田）

分歧记录：思澜建议先纯 prompt 滚动清单当试验田、第一次半开环造成实际损失再转正；大獭反对——试验田拖太久搭档受够了也懒得催，机制永远停在临时工状态。**搭档已拍板「落方案」，即采纳设计先行。**

实现分期建议（各期独立 PR）：
- P1：matters 表 + 状态机（含迁移矩阵守卫）+ **獭侧 matter 工具（list/transition——空窗期「獭手动迁移」的执行载体，P1 就需要，不是 P2）** + 准入挂钩（yield 打标参数 + 登记）+ 机械供料字段 + **只读最小板**（右侧栏待办 tab 只读列出 open 事项）——搭档痛点（看得见）第一期就有可感知交付；操作（裁决/闭环）在 P2。验收：搭档打开任一对话能看到板上事项（只读），獭能用工具迁移状态
- P2：待办 tab 交互层 + 就地操作（裁决/闭环/打回/翻案/登记入口）+ **通道 A 配套**（獭侧纪律：对话直复时识别裁决对象 matter、代执行迁移并复述确认——识别纪律进 system prompt 或 skill，P2 时定载体；代执行动作用 P1 已有的 matter 工具）。验收：搭档对话直复→獭代迁移+复述确认全链路通；板上按钮裁决→回执路由等待獭
- P3：未闭环扫描升格 + 简报卡吸收收尾。验收：扫描产出从文本启发式切到确定性查询，日巡发现停滞（OPEN 无人认领 / WAITING_PARTNER 积压）→ 三省吾身对话发提醒（含 matter ID 与等待时长）——审计环闭合

**空窗期说明**：P1 到 P2 之间，板上事项可见但裁决仍走对话直复（通道 A 主路——本来就不需要板），状态由獭用 P1 的 matter 工具迁移——这是刻意的过渡设计，不违反「状态只在 matters 表」（投影≠双写）。**审计环闭合**：P1 落地后，三省吾身未闭环扫描 prompt 同步小改（读 open matters 清单做日巡，不改扫描产生逻辑——升格在 P3），避免 P1/P2 期间已登记 matter 无人日巡。

## 影响范围

- 新增：matters 表（schema.ts）、matter 实体与 usecase、机械供料新字段、事情板 UI（packages/web/）、能力测试目录
- 修改：yield to user 链路（L2 自动登记挂钩）、restart 交接档案构建（handoff-package-builder）、三省吾身未闭环扫描 prompt、简报卡呈现层
- 不修改：signal events、linked resources、issue 勾选清单、决策分级定义本身

## 风险与约束

1. **产生端泛滥（最大风险）**：准入白名单执行不严 → 机制必死。缓解：白名单硬编码在产生路径（不靠獭自觉），扫描登记路径有去重
2. **状态双写**：真相只在 matters 表，流内是投影。纪律破防会出现板上开着、实际已关的分裂。缓解：所有状态迁移走 usecase 单入口
3. **工程量是这批扩展机制中最大的一次**：存储 + 展示面 + 回写唤醒 + 供料改造 + 獭侧工具五处改动。缓解：分三期落地，每期独立可交付（各期验收标准见 §7）
4. **事情板 UI 打扰性**：常驻 tab 角标若太吵会制造新的视觉噪音。缓解：角标只数「等你裁决+待确认闭环」（搭档欠的动作），保真稿阶段搭档确认

## 不兼容更新

[Incompatible] yield 工具新增可选参数 `expects_partner_decision`——可选，不破坏既有调用；但「L2 显式拍板必须打标」是新增的獭侧纪律（prompt/skill 层），既往不打标的 yield 行为不变（不登记待办）。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 闭环单位 | matter（事情容器），决策点是状态挂点 | 抽「待决策」为独立实体（大獭初案 A） | 批完决策事情其余部分仍埋流里，半开环照旧（思澜修正，大獭接受） |
| 逾期处理 | 不做——宣告权分权即闭环灵魂 | 逾期 TTL/自动关闭/升级提醒（大獭初案称其为「灵魂」） | 板上可见的事不会无声死；唯一裁判是搭档（思澜修正，搭档直觉同向） |
| 跨对话聚合 | 不做独立面板，三省吾身扫描当派生视图 | 全局待决策 inbox | 搭档约束「每个对话下」；聚合面板是新 UI 面，成本超收益 |
| 决策承载 | 本系统内机制 | GitHub issue type:decision | 搭档原话「我肯定不去看 issue 的」 |
| 简报卡 | 吸收为 WAITING_PARTNER 呈现形态 | 简报卡与 matter 并存双轨 | 双轨 = 双写分裂；卡片本身也有「被顶走」病，吸收顺带治好 |
| 设计节奏 | 设计一次定死，实现分三期 | 先纯 prompt 试验田跑数据形状（思澜） | 试验田无强制转正力，机制易停临时工状态；搭档已拍板落方案 |
| 新表 vs 复用 signal_events | 新表 matters | 复用 signal_events 加 type=matter | 语义不同（瞬时信号 vs 持续工作单元），状态机不同；同构先例但不同物（schema.ts:707 注释已有命名区分先例） |

## 未决问题

1. ~~裁决回写通道~~ **已定案**（2026-10-05 大獭核实）：复用 otterCard.submit 管道（card-bridge.ts + useCardBridge.ts:114-155，回执按 authorId 路由），P2 细化按钮挂点
2. **matter 与 issue 勾选清单的统一时机**：「每日开工审批 = 周期性 matter 特例」是否在三省吾身场景先试点？本期不统一，仅标注

（原未决 2「回头再说检测形态」已在 §3 定案：手动登记+獭复述确认，不做 NLP 自动检测）

## 机制预算四问补遗（审视建议采纳）

- **谁需要**：搭档（消费者——国庆放假 N 天回来第一眼看到全部待裁决事项，不翻消息）；獭侧所有需要拍板/续办路由的执行者（owner/代执行獭/大獭）——未闭环清单是打回/唤醒/重派三处的路由依据
- **失败后果**：matter 机制失效时，搭档可感知表现 = 板上事项停更/不更新——退化为今天的现状（决策埋流里），不是新增危害；内部异常 = 状态迁移拒绝（非法迁移被 usecase 拦截），不伤数据
- **后续机制**：§7 分期（P2 板上按钮+裁决回执通道、P3 扫描升格+简报卡吸收）；每阶段交付后走同一对抗审视+终审流程
- **退役条件**：连续 2 周板上 open 数为 0 且搭档无主动查询 = 产生端准入过严或机制无牵引力，启动退役评估（机制预算四问的反面，先软后硬）

## 验证

- 单元测试：状态机迁移合法性矩阵（非法迁移拒绝——以 §2 矩阵为测试输入）、准入白名单（非白名单路径无法创建；默认通过 yield 不登记）、宣告权分权（L2 无搭档确认不可 CLOSED、L1 可翻案重开、等待方消亡自动转 OPEN）
- 能力测试（tests/capability/matter-loop/，P1 落地时补齐）：①yield to user 的 L2 自动登记 matter ②restart 后新世獭档案含 open matters 清单字段 ③搭档裁决回执路由到等待獭（目标已消亡时只投影不投递）
- 验收：搭档日常体验判定（human_judge）——国庆场景回归：放假 N 天回来，打开对话第一眼看到全部待裁决事项，不翻消息
- UI：保真稿经搭档确认后方可进入 P2 实现

**承诺半径声明**（校准表述）：「无声过期消除」的保证范围 = **已登记事项**。准入白名单外的事项（獭没走 yield、搭档没说出口的事）不在保证面内；准入路径 3 在 P3 前依赖现有启发式扫描，P1 落地后以每日 open matters 日巡闭合审计环。

## 改动范围（P1 预估）

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/db/schema.ts | M | createMattersTable + 索引 |
| src/entities/matter/ | A | 实体与状态机 |
| src/usecases/matter/ | A | 登记/裁决/闭环/查询 usecase（状态迁移单入口） |
| src/interface-adapters/agent-runtime/handoff-support.ts | M | 机械供料加 handoff_open_matters 字段 |
| src/frameworks/agent/handoff-package-builder.ts | M | 档案构建注入 open matters |
| yield 工具链路 | M | 新增可选参数 expects_partner_decision（打标即登记的判据载体） |
| src/interface-adapters/agent-runtime/tools/ | A | 獭侧 matter 工具：list_matters / transition_matter（P1 就需要——空窗期手动迁移与机械供料查询的执行载体） |
| web/ 右侧栏 | A | 待办 tab 组件（P1 只读 / P2 交互，样式沿用现有 tab 体系；注意：卡回执「同 cardId 永久关闭」——matter 打回后二次进 WAITING_PARTNER 需獭重发新卡（新 cardId），P2 按钮挂点避开此坑，useCardBridge.ts:120-121） |
| prompts/scheduled/未闭环扫描 | M | 升格为确定性查询（P3） |
| tests/capability/matter-loop/ | A | 能力测试 |

## P1 实现记录（2026-10-05）

> 本节为实现 PR 追加，不改历史。设计内容（§1-§7）是定稿时的方案；本节记录 P1 实际落地形态与方案的偏差/落实细节。

### 落地清单（对应改动范围表）

| 方案条目 | 落点 | 状态 |
|---|---|---|
| matters 表 + 三索引 | `src/frameworks/db/schema.ts` createMattersTable（幂等 CREATE IF NOT EXISTS，schema.ts:735-767） | ✅ 字段/索引严格按 §1 字段表 |
| matter 实体与状态机 | `src/entities/matter/matter.ts`（实体+MATTER_OPEN_STATES）+ `matter-transitions.ts`（§2 矩阵 19 entries=创建2+存续17，唯一真相源，Map 索引 O(1) 查询） | ✅ |
| 迁移守卫单入口 | `src/usecases/matter/transition-matter.ts`——四层守卫：幂等短路 → 矩阵 → 触发者（any_otter 含 owner；§3.5 代执行声明 on_behalf_of 后按被代理者身份过守卫）→ 宣告权（L2 闭环必须 partner，含代执行声明）；repo.transition 条件更新（WHERE state=?）乐观锁 | ✅ 非法迁移拒绝由单测锁定（47→59 用例，审视修复后） |
| 登记 usecase（准入白名单） | `src/usecases/matter/register-matter.ts`——initialState 只接受 WAITING_PARTNER（路径 1）/ OPEN（路径 2/3）；L0 无登记路径 | ✅ |
| 獭侧工具 | `src/interface-adapters/agent-runtime/tools/matter-tools.ts` list_matters / transition_matter；经 `ctx.matterRepo` 注入（仿 signalRepo 先例），small/big 均注册（manifest system block + small fallback 白名单） | ✅ |
| yield 打标参数 | tool-factory.ts yield 工具新增可选参数 `expects_partner_decision`（仅 to 含 'user' 时有意义）；true → registerMatterOnTaggedYield 自动登记（WAITING_PARTNER/L2/owner=调用獭/origin=yield entry id）；**不打标不登记 = 机械防泛滥；默认通过模式不打标 = R8 互斥不登记** | ✅ 登记失败不阻断交棒（审计面非前置条件） |
| 等待方消亡规则① | `SqliteMatterRepository.reopenForDissolvedOwner` + DissolveOtter 新 hook `reopenMattersForDissolvedOwner`（失败仅日志——与既有 4.5/4.6/4.7 清账 hook 同模式）；WAITING_OTTER→OPEN 待重派，WAITING_PARTNER（等搭档）不受影响 | ✅ |
| 机械供料 handoff_open_matters | `agent-invoker.ts collectOpenMatters`（unifiedHandoff 原料收集并行块）→ 注入 assembleHandoffArchive / buildMechanicalArchive 的 `openMatters` 段（「### ④ 机械供料：本对话未闭环事情（matters）」）；`handoff-support.ts` restoreHandoffContext 同步加 `handoff_open_matters` key（与 handoff_file_trail 同模式——D8 后档案走 session.summary，legacy key 消费面保留对称） | ✅ matterRepo 未注入/查询失败降级空串（增强不是硬依赖） |
| 只读右侧栏 tab | `web/src/pages/conversation/MattersPanel.tsx` + `hooks/useMatters.ts`（GET /api/conversations/:id/matters，30s 轮询仿 useScheduledTasks）；RightPanel.tsx 第五 tab（ClipboardList 图标）；样式沿用现有 tab 体系（glass 面板/glass-card 条目） | ✅ P1 只读：标题/状态徽章/等待时长/owner；排序 WAITING_PARTNER 置顶（热边框）→ DONE_PENDING_CONFIRM → WAITING_OTTER/OPEN；tab 角标只数「等你裁决+待确认闭环」（搭档欠的动作） |
| 只读 API | `MatterController.listOpenByConversation` + `matter-dto.ts`（P1 只读投影字段全集） | ✅ 写路径（P2 按钮）不经 HTTP |
| 单元测试 | `tests/usecases/matter/matter-state-machine.test.ts`（矩阵全量+非法拒绝+触发者+宣告权+幂等+代执行+消亡规则，47 用例）；`tests/frameworks/db/matter/sqlite-matter-repository.test.ts`（CRUD+过滤+跨对话隔离，5 用例）；`tests/interface-adapters/agent-runtime/tools/matter-yield-registration.test.ts`（准入+代执行工具面+payload，12 用例） | ✅ 65 用例全绿（审视+N1-N4 修复后） |
| 能力测试 | `tests/capability/matter-loop/matter-loop.capability.test.ts` 三场景（③为 P2 占位显式跳过） | ✅ 无 LLM 环境 skip（同其他 capability 测试） |

### 实现期设计决策（方案未细定的部分）

1. **触发者分类序**：classifyActor 按 partner → owner → any_otter 优先级；actorAllowed 补「allowed 含 any_otter 时任意獭（含 owner）可触发」——通道 A 代执行（非 owner 獭）与 owner 自执行都走同一条矩阵行，权限粒度由矩阵行控制而非身份层级。
2. **幂等语义**：TransitionMatter 入口先做「已是目标态 → 原样返回」短路（同目标重复迁移/并发重试零副作用）；repo.transition 条件更新落空时读回当前态——已到目标态/已闭环则幂等返回，否则报 conflict 让调用方重试。与 resolve_signal 幂等防重同模式。
3. **waitingOn 三态语义**：undefined=未指定（按目标态默认——WAITING_PARTNER 默认 partner、OPEN 默认清空）、null=显式清空、字符串=指定。工具层未传参时不给值（避免 null 被误读为清空）。
4. **MatterController 是 Controller 而非 usecase 直挂**：P1 只读面薄（一行 repo 查询+DTO 映射），单建 ListMatters usecase 是过度建设——但 ListMatters 已建（獭侧工具共用），controller 直接吃 repo 是 controller 层薄模式先例（ActivityController 同模式）。P2 按钮写路径进来时再评估是否升 usecase。
5. **schema 表数日志 46→47**：initSchema 的 tables 计数随 matters 表 +1（migration-equivalence guard 的 8/5 基线快照不需要动——新表落在 DROP 差集模拟路径）。

### 负面向验收（本次变更破坏了什么旧契约）

- **无破坏性变更**：matters 是新表（幂等 CREATE IF NOT EXISTS），老库启动自动补建；yield 新参数可选（缺省 false=旧行为）；matterRepo 全链可选注入（旧 mock/装配不注入时零行为变化）；Controllers 新增 matter 必填字段——tests/api/helpers.ts mock 补 `{} as any`（唯一测试装配面改动）。
- **small 獭工具面 +2**（list_matters/transition_matter）：白名单扩张是方案内设计（P1 就需要獭侧工具），不是绕过保护。
- **未绕过任何既有保护**：登记走 RegisterMatter（准入校验 title/initialState 白名单）；迁移走 TransitionMatter（矩阵/触发者/宣告权三层）；HTTP 面无写端点。

### 最简实现检查

已过阶梯：仓库已有同构实现（signal_events 表+signal-tools+resolve_signal 幂等模式）→ 全部复用既有模式，无新框架/新依赖。matters 表与 signal_events 同构（per-conversation+状态+resolution 三件套），状态机是实体层纯 Map（20 行），守卫在 usecase（无 AOP/装饰器）。确认已最简。

### 自检结果（PR Verification）

- 全量单测：319 文件 4661 用例全绿（含本 PR 新增 matter 域 65 用例 + 存量 coding-tools 1 断言更新；唯一改动存量断言 = coding-tools.test.ts small 白名单 29→31，+list_matters/transition_matter 两条 toContain，与本变更同语义）
- web 单测：61 文件 618 用例全绿（新增 MattersPanel.test.tsx 2 用例）
- eslint src/：0 error 0 warning
- tsc --noEmit（前后端）：干净（web 侧唯一 error hast 为 pre-existing，基线对照确认）
- lint:capability：OK（68 警告 = 上限，本 PR 文档指针从 n/a 改为真实路径，未推高）
- **db 迁移类真启动验证（schema.ts 改了表结构）**：生产库（data/otter-buddy.db，1GB / 91 表）备份副本 `/tmp/matter-loop-p1-bootstrap-test.db` 上执行完整启动路径（buildApp 全装配 = initSchema 幂等补建 + migrateDatabase + 全 repo/usecase/controller 装配），12.2s 完成、无 SqliteError；matters 表 + 3 业务索引自动补建、15 字段与 §1 字段表一致；启动后 entries/otters/signal_events/conversations 行数与生产库逐一相等（33259/1317/11/258）——零数据影响。
- **UI 真机自查（RightPanel 改了）**：dev server（vite 5199，VITE_API_TARGET 指向隔离实例 3297）+ Playwright 无头浏览器真机截图 2 张，存对话工作区：
  - `data/workspaces/e871769f-a731-4278-ae21-de3ab4c8eaf8/matter-tab-0-default.png`（默认 tab 页）
  - `data/workspaces/e871769f-a731-4278-ae21-de3ab4c8eaf8/matter-tab-1-list.png`（待办 tab：4 条目 + 角标 2 + 排序/徽章/等待时长/owner 渲染正确）
- **Golden Gate 与锚点重放评审**：本 PR 触发行可重放的运行时代码 = yield 工具 description/参数面（软代码行为触发语义）+ tool-manifest.json + small fallback 白名单。**Golden Gate: n/a（verify_by=human_judge，无场景可跑——豁免按实质在认定：锚点重放评审交付物即替代交付物）**。锚点重放评审交付物：
  - yield 打标参数 description（`expects_partner_decision`）：「仅 to 包含 'user' 时有意义 true=本交棒是 L2 显式拍板项…默认通过模式与待办互斥：携带默认通过语义的 yield 不打标、不登记」——重放锚点 = 方案 §2「默认通过模式互斥不登记」+ §3 生死线准入路径 1。
  - list_matters / transition_matter description：重放锚点 = §2 迁移矩阵 + 宣告权表 + §7 P1 空窗期设计（通道 A 主路）。
  - 獭身份文件（prompts/identity/SMALL_OTTER.md / BIG_OTTER.md）未改——行为指引经工具 description 注入，不改身份文案（与方案 §6 獭侧纪律 P2 分期一致）。
- **pre-existing 声明**：web tsc hast error（基线 1 error，未引入）；lint:capability 68 警告为存量过渡期上限（未推高）。

### P1 审视修复记录（2026-10-06，代码审獭 mimo-pro 对抗审视后）

审视结论「需要修改」（4 严重 + 6 建议）。处置：4 严重全部本 PR 修复 + 6 建议全部采纳修复，无驳回。

**S1 通道 A 代执行物理断路（头号严重）**：transition_matter 工具加 `on_behalf_of` 代执行声明参数（'partner' | ownerOtterId）——声明后 TransitionMatter 按被代理者身份过守卫（矩阵 + 触发者 + 宣告权三层不变），partner 专属迁移（裁决/翻案/不做）由獭代搭档执行是空窗期主路（§3.5 对话直复 → 獭落账 → 复述确认）；代执行裁决类迁移必须填 resolution 留痕（工具参数校验强制）。未声明 = 獭以自己身份（守卫照旧）。工具文案 GOTCHA 重写消除自相矛盾。测试锁定：usecase 层 5 用例（声明放行/越矩阵仍拒/越宣告权仍拒）+ 工具层 4 用例（无声明拒绝/声明放行/缺 resolution 拒绝/payload 写入）。

**S2 dissolve hook 判定键偏离**：reopenForDissolvedOwner SQL 改「waiting_on 指向的獭」为判定主键（方案 §2 规则①原文），owner 键仅在 waiting_on 为 NULL 时兜底——非 owner 等待方消亡回 OPEN（消灭悬挂），owner 消亡但 waiting_on 指向健在獭不误重开。补「OPEN→WAITING_OTTER 默认写 waiting_on=otter:<认领獭>」（§2 矩阵 note 语义，usecase defaultWaitingOnForTransition 落实—— previously 靠调用方自觉传参）。测试补 3 用例（非 owner 等待方消亡回 OPEN / owner 消亡等待方健在不误重开 / NULL waiting_on owner 兜底）。

**S3 CI 红（branch behind main）**：大獭已 merge main（d8dfd9cd）推送，随修复 commit 重跑。

**S4 撞车 #1268**：大獭仲裁 #1268 先合、本分支 rebase 时解决 client.ts/helpers.ts 交集（保双方新增）。

**建议 5 payload 无写入载体**：yield 登记把 reason 全文写入 payload（JSON.stringify({brief})）；transition_matter 加可选 payload 参数——§1「简报内容单源」物理落点闭合。测试锁定。

**建议 6 矩阵越界 2 条**：§2 矩阵 OPEN/WAITING_*→SUPERSEDED/ABANDONED 行扩为含 DONE_PENDING_CONFIRM（DPC 也需要终态出口的语义补全），矩阵行内留痕修订说明；条数注释改实际口径（19 entries = 创建 2 + 存续 17）。

**建议 7 resolved_by 格式**：终态 resolvedBy 归一化 `actor==='partner' ? 'partner' : 'otter:'+actor`（§1 口径）；非终态代执行留痕记被代理者同口径。测试同步。（N1 后续修订：resolvedBy 统一单写记实际执行獭，被代理者身份经 resolution 留痕——见 P1 审视修复记录 N1 条。）

**建议 8 repo.transition 接口-实现漂移**：patch 类型删 ownerOtterId/level（SQL UPDATE 只有 8 列——删接口字段不留漂移）。

**建议 9 Golden Gate 标准豁免行**：PR Verification 补「Golden Gate: n/a（verify_by=human_judge）」标准声明行。

**建议 10 机制四问 2/4 显式**：补「谁需要」「后续机制」两条带标签 bullet（此前隐含于背景/§7 分期）。

修复后单测：matter 域 64/64（新增 19 用例：代执行 usecase 5 + dissolve 3 + 工具层 7 + payload/resolvedBy 等 4）。

### Delta 复审 N1-N4 处置记录（2026-10-06 第二轮）

Delta 复审通过（闸门开），新增 4 条建议级。处置：全部快速修掉，无 issue 留痕。

**N1 proxy audit 双写收敛**：删 writeProxyAuditTrail 二次写入——resolvedBy 统一单写记实际执行獭（buildTransitionPatch 一处），被代理者身份经 resolution「代搭档执行：<原话>」留痕（宣告权分权的审计面本就在 resolution）。diff 反而变小，并发窗口随双写消失。

**N2 代执行留痕面扩宽**：validateProxyParams 改 on_behalf_of 非空即强制 resolution（不限 4 目标态）——与 GOTCHA⑤ 承诺对齐。

**N3 打回路径默认 waiting_on**：defaultWaitingOnForTransition 打回路径（任意前态→WAITING_OTTER）未指定时默认 = owner 续办（otter:<ownerId>）——消灭 stale 'partner' 行（dissolve 双扫描 waiting_on/owner 都漏的残留）。认领路径（OPEN→WO）仍默认=认领獭。

**N4 口径尾巴**：§1 resolved_by 描述同步 N1 语义（实际执行獭+被代理者经 resolution 留痕）；§2 矩阵计数句 + 改动范围表「14 条」改实际口径（19 entries）。

修订后单测：matter 域全绿（新增 N3 打回默认 1 用例，resolvedBy 断言随 N1 修订）。
