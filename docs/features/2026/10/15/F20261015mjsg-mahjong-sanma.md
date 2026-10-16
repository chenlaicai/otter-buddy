---
id: F20261015mjsg
title: 三人立直麻将（獭桌三麻）方案
summary: 搭档要打麻将——在系统内集成三人立直麻将：1 真人 + 2 獭实时同桌，独立牌局页面（对话只放入口卡/战报卡），自研三麻裁判引擎（mahjong-utils 不支持三麻已实证），LLM+规则辅助打牌、节流阀控 token
change_type: feature
capability_test: "n/a: 方案文档阶段无代码行为面；实现期验收走 tests/usecases/mahjong/ 裁判牌例集（≥50 例覆盖全役种/符数/振听/流局）+ 引擎集成测试 + 端到端真人对局"
created_in_conversation: a00f8fec-1ec0-4c63-9b1d-27b5756b2fc8
intent:
  problem: "搭档想在协作系统里和海獭打日麻（突发奇想 2026-10-15 11:47），现状系统无游戏能力，打牌只能去雀魂/天凤，獭置身事外。"
  expected_effect: "三人麻东风局一桌可完整对局：独立页面实时渲染+内嵌聊天框，獭自主摸打且言行有人味，完整三麻规则裁判兜底，token 可控（节流阀+操作发言同帧）。"
  verify_by:
    type: behavior_check
tags: [mahjong, game, feature]
modules: [src/usecases/mahjong, src/entities/mahjong, web-mahjong]
causal_links:
  - 2026-10-15 对话「麻将」：搭档拍板——实时同桌、LLM+规则辅助、完整规则、三人麻、独立页面入口
---

# 三人立直麻将（獭桌三麻）

## 需求结晶（已过结晶门）

- **C1 为谁解决什么**：为搭档提供与两只海獭同桌打三人立直麻将（さんま）的人格化娱乐对局——不是棋牌平台，是「獭味牌局」
- **C2 现状与代价**：系统内无此能力，打牌只能去雀魂/天凤跟陌生人或引擎打，獭完全置身事外；纯增量功能
- **C3 成功长什么样**：从对话点入口卡进独立牌局页面 → 牌桌实时推进 → 獭自主摸打且言行有人味（报听宣言、吐槽牌河、赛后锐评）→ 规则合规有裁判兜底 → 一局完整结算
- **C4 明确不做**（搭档确认）：不接专业日麻 AI 内核；不做段位/积分/天梯；不做多人真人对局（固定 1 真人 + 2 獭）；不做观战/牌谱回放分享（v1）；**不做四人麻 v1**
- **C5 最小可交付**：三人麻东风局一桌、完整三麻规则裁判、两只獭上桌打牌、独立页面实时渲染 + 内嵌聊天框

## 关键决策记录（搭档拍板原话锚点）

| 决策点 | 结论 | 锚点 |
|---|---|---|
| 对局形态 | 实时同桌 | 「实时」（12:00 前三问回复） |
| 獭牌力 | LLM + 规则辅助，像人一样，不接专业 AI | 「llm+规则，不需要专业的日麻ai，像人一样」 |
| 规则范围 | 完整立直规则（三麻变体） | 「完整规则」 |
| 人数 | 三人麻（1 真人 + 2 獭） | 「咱们token有限，先不做四人麻…三人麻…一局更快」（12:00） |
| 入口形态 | 独立页面（对话内只放入口卡），页面内嵌聊天框 | 「ok。开工！」（12:55）确认 B 方案 |

## 方案设计

### 总体架构

```
对话时间线                      独立牌局域（新增）
┌──────────────┐      ┌─────────────────────────────────┐
│ 入口卡        │─────▶│ /mahjong/:roomId 页面（SPA/静态） │
│ 「三麻桌已开」 │      │   ├─ 牌桌渲染（Canvas/DOM）      │
│ 战报卡（结算后）│◀────│   ├─ 内嵌聊天框                  │
└──────────────┘      │   └─ WS/SSE 连接                  │
                      ├─────────────────────────────────┤
                      │ RoomService（新 usecase 域）       │
                      │   ├─ SanmaEngine：牌局状态机       │
                      │   │   （摸打/副露/立直/结算/流局） │
                      │   ├─ Referee：规则裁判（自研）     │
                      │   │   （役种/符数/点数/振听/违规） │
                      │   ├─ OtterPlayerAdapter：獭调度    │
                      │   │   （唤醒/喂局面/收操作+发言）  │
                      │   └─ ChatLog：局内发言记录         │
                      └─────────────────────────────────┘
```

**核心边界**：牌局域自管状态机与渲染，**不碰对话引擎**——对话侧只产生两类 entry（入口卡、战报卡），牌局过程几十上百次摸打不灌进对话历史与记忆索引。

### 模块一：Referee 三麻裁判引擎（自研，纯函数 TS 模块）

**选型结论（已实证）**：调研了 `mahjong-utils`（ssttkkl，Kotlin→JS，41★）——不支持三麻（README/规则选项/HoraArgs 全部四人限定），且 npm 0.7.7 dist 缺失为已知 issue；其余三麻开源项目（Meowjong/Mortal fork）是 AI 训练仓非裁判引擎。**结论：自研**，算法可参考 mahjong-utils 与公开日麻点数表。

职责（纯函数，无副作用，可单测）：
- **手牌解析**：面子/雀头分解、向听数、听牌形（标准形/七对/国士）
- **和牌判定**：役种识别（三麻全集：含拔北宝牌不算役、无三色同顺中的万子部分适配等三麻特有判定）、符数、翻数、点数（含自摸损：三麻自摸按（子家点+庄家点）/2 收两家，点数规则按雀魂三麻口径）
- **合法性校验**：振听（含立直后同巡振听）、食替、副露合法性（碰/杠/拔北，无吃）、立直条件（门清/1000 点/余牌）
- **流局判定**：三风连打（三麻三家同风，非四风）/ 四杠散了（三麻存在：三家累计四杠）/ 九种九牌 / 流局满贯（三麻适配）；~~三家和了~~（三麻=全员和牌，该流局条款在三麻不存在——审视 A6 修正）
- **宝牌**：指示牌、里宝牌、拔北宝牌计数

验收（采纳审视 S3 修正——原「对公开三麻牌例集 100% 一致」不可执行：雀魂牌谱无公开数据集、天凤口径与雀魂三麻有差异，「与不存在的数据集一致」不是验收门）：
- **自构造分层测试集 ≥300 例**：全役种每役 ≥1 例 + 符数表全枚举（20/25/30/40/50/60/满贯跳切边界）+ 振听三变体专项 + 流局各形态专项 + 三麻特有判定（拔北、自摸损）专项
- 天凤三麻牌谱对齐降级为**抽样回归**（口径差异点显式豁免清单），不作验收门
- 雀魂规则细节以规则文档逐条断言为准（实现期逐条核实，见模块二规则清单）

### 模块二：SanmaEngine 牌局状态机

- 状态模型：`{场风, 局数, 本场, 供托, 各家点数, 牌山(含王牌), 各家手牌/河/副露, 当前行动家, 副露窗口}`——**单帧完整快照**，落 sqlite（新表 `mahjong_games` / `mahjong_frames`），断线从最近帧恢复
- 推进循环：配牌 → 摸打循环（行动权轮转）→ 副露窗口（他家声明碰/杠/和）→ 终局（和牌结算/流局）→ 下一局或整场结算
- **副露窗口规则**（审视 A2 修正）：优先级 和 > 碰/杠；**双响允许**（雀魂三麻口径：两家同时和牌均成立，无头跳），实现期以雀魂三麻规则文档锁定
- 完整规则清单（三麻雀魂口径，实现期逐条对雀魂规则文档核实——审视 A6）：东风局、拔北宝牌、无吃、二~八万移除（108 张牌）、流局满贯适配、包牌（大三元/大四喜）、双响、三风连打/四杠散了/九种九牌等流局条款
- 状态模型补字段（审视 A5）：`seed`（配牌随机种子，落 `mahjong_games` 表）——断线恢复可复现、game-dev-harness 回归基线可建
- **真人回合超时**（审视 A1）：15s+ 宽限，超时自动摸切（记入战报标注）——对局不因挂机卡死
- **节流阀**：无决策量回合（摸切明显、无人副露窗口）走规则自动代理，不调 LLM——预估獭实际唤醒次数 ~每局 10-15 次而非全部 ~30 巡

### 模块三：OtterPlayerAdapter 獭调度

- **唤醒机制路径**（审视 S1 修正——本方案最大架构决策，原方案零设计）：走 **SDK 直调面**（`SdkInvokePort.invoke(otterId, message, options)`，`src/usecases/ports/sdk-invoke-port.ts:106`），不走 AgentInvoker 对话链（强绑 conversationId、自动落 entry、发言石路由、SSE 广播——走这条等于把牌局灌进对话历史，违背核心边界）。代价与对策：SDK 直调绕开 AgentInvoker 内嵌护栏（锁/水位/熔断/compaction/metrics），牌局域自持轻量护栏：
  - **锁**：复用 `acquireSessionLock`（sdk-invoke-port.ts:112，per-otter 冻结窗口），獭回合内串行
  - **熔断**：獭 LLM 异常/超时 → 规则代理代打该回合（记日志，战报标注）——不传染对局
  - **compaction/水位换世**（审视 S2——原方案「局内禁 restart/dissolve」只约束外部指令，挡不住自动换世）：水位触发器在 AgentInvoker 轮边界（agent-invoker.ts:334 `shouldTriggerWatermarkHandoff`），**SDK 直调路径天然不经此处**——牌局期间无自动换世；局终由 RoomService 统一检查水位、必要时触发交接（牌局间隙换世无明牌顾虑）。R1 风险描述相应修正
- **獭生命周期**（审视 A3 修正——原方案「持久 participant」与「开局 create_otter」矛盾）：**持久牌搭子獭**（首次开局 create_otter ×2，挂靠开局对话；之后复用不重建——跨局记忆成立，「獭记得上局锐评」）；局终**挂起不 dissolve**；约束执行主体 = RoomService
- **牌局中对话侧防护**（delta D2）：牌搭子獭挂靠对话后仍是 participant——牌局进行中搭档在对话 @它 会走 AgentInvoker 对话链触发水位换世（绕过局终统一检查）。对策：牌局进行中该獭对话侧自动应答「打牌中」（复用 `isRunning` 判定，sdk-invoke-port.ts 现成接口），不进入 LLM 推理
- 唤醒协议：局面快照（自家手牌/河/副露/点数/场况，**不含他家手牌**）+ 合法操作集（Referee 预算好）→ 獭一次响应返回 `{action, speech?}`——操作与发言同帧，发言进 ChatLog 不额外烧 token
- 兜底：獭返回非法操作 → Referee 拒绝并要求重答（最多 1 次重试）→ 仍非法则规则代理代打（记日志，战报标注）——对局不因獭发疯而崩
- 人格化：speech 由獭自由发挥（报听宣言、毒奶、锐评），systemPrompt 里给语气基调，不做模板化

### 模块四：牌局页面（/mahjong/:roomId）

- 独立静态目录 `web-mahjong/`（仓库根，与 `game/` 同级同模式；`web/` 是 vite SPA 单入口工程，原生 HTML 进 `web/mahjong/` 会被卷进构建链——delta D1 修正统一命名）+ Hono `serveStatic` 显式路由，**注意与 SPA fallback 的交互**（server.ts:48，需显式排除 `/mahjong/*`）
- 牌局实时推送：现有 SSE 是 conversationId 粒度（`sse-streamer.ts:25`），**room 粒度广播通道为新建**（SSE 或 WS 选型实现期定）
- 牌桌渲染：DOM/CSS（牌面用 Unicode 麻将字符或 SVG 牌面图，不用图片资源），三家视角、手牌横排、牌河 6 列、副露区、点数/场况栏——原生 HTML/JS 单页，风格参照 game/index.html（**注意：game/ 无托管基建可复用**，src 零引用，仅风格参照——审视 S4 修正）
- 交互：点选手牌打出、副露/立直/和了按钮按合法操作集动态显隐、倒计时（真人回合 15s+ 宽限，超时自动摸切）
- 内嵌聊天框：獭的 speech 实时流入，真人可回话——回话在**下局开局时作为首条 user 消息注入**獭 session（审视 A4 修正：不走运行中 reset——会触发换世清上下文；也不走 systemPrompt——create/reset 时才注入）

### 模块五：对话侧触点（薄）

- 开局：搭档在任意对话说「开一局三麻」（或点入口卡按钮）→ 大獭建房间 → 发入口卡（`html-card` 链接卡，裸链 unfurl）
- 终局：RoomService 回调对话域发战报卡（结算点数、役种亮点、獭锐评摘要），登记 `linked_resource`
- 牌局进行中对话域零介入

## 影响范围

- 新增：`src/usecases/mahjong/`（engine/referee/adapter/room）、`src/entities/mahjong/`、`web-mahjong/`（页面，仓库根静态目录）、sqlite 两新表
- 修改：Hono 静态路由注册（`/mahjong/*` 显式路由 + SPA fallback 排除）、入口卡渲染契约（复用 html-card，无契约变更）
- 不碰：对话引擎、发言石、记忆索引、AgentInvoker 对话调度链（獭唤醒走 SDK 直调面，见模块三）
- 依赖：无新 npm 依赖（裁判自研、页面原生）——这是选型结论的直接收益

## 设计取舍

| 取舍 | 选择 | 理由 / 被否方案 |
|---|---|---|
| 裁判引擎 | 自研纯函数 TS | mahjong-utils 不支持三麻且 npm 包破损（实证）；AI 仓非裁判 |
| 游戏载体 | 独立页面 + WS | 对话内开局会让状态机与发言石路由互相特判、污染记忆索引（与搭档对齐过） |
| 獭明牌隔离 | 持久牌搭子獭 + 局内禁 dissolve/restart + SDK 直调路径天然规避水位自动换世 | 牌局全程在 LLM 上下文，无逻辑层信息隐藏手段；外部指令+自动路径双堵（审视 S2 修正后成立） |
| LLM 成本控制 | 节流阀 + 操作发言同帧 | 无决策回合自动代理；发言不单独调 LLM |
| 历史教训检索 | 无同类否决记录 | 负证据防线已查（memory 搜「否决/撤回/翻车」无麻将/游戏引擎相关） |

## 风险

- **R1 獭上下文膨胀**：一局东风场 + 聊天，獭 session 上下文可能逼近压缩阈值——对策：局面快照用紧凑编码（牌用字串而非 JSON），聊天历史只带最近 N 条；SDK 直调路径不经水位触发器（模块三），牌局中途无自动换世；局终统一检查水位；极端情况该局提前结算不重启獭
- **R2 自研裁判的规则正确性**：三麻规则细节多（自摸损、拔北时机）——对策：分层自构造测试集 ≥300 例为验收门（审视 S3 修正），先写测试再写引擎（TDD）
- **R3 token 消耗仍不低**：两獭 × 每局 10-15 次唤醒 × 局面快照 prompt——预估单局 ~30-60k token 量级（推理，未实测），东风局可接受；半庄暂不开放
- **R4 实时性与 LLM 延迟矛盾**：獭思考 3-10s，「实时」体验靠 UI 遮罩（思考动画 + 出牌前 speech 先到）兜底，倒计时对獭放宽

## 验证

1. Referee 单测：分层自构造测试集 **≥300 例**（全役种每役 ≥1 + 符数全枚举 + 振听三变体 + 流局各形态 + 三麻特有判定专项），100% 通过；天凤三麻牌谱抽样回归（口径差异显式豁免清单）（审视 S3 修正）
2. Engine 集成测试：脚本化三局模拟（规则代理代替 LLM），状态机推进/结算/断线恢复正确
3. 端到端：真实开局，搭档 + 2 獭打完一局东风场，规则零违规、聊天正常、战报卡落时间线
4. game-dev-harness 对齐：牌局暴露 seed 化配牌 + 状态快照 + 截图能力（该 skill 分层指导适用）

## 产出与下一步

| 产出 | 状态 |
|---|---|
| 本方案文档 | 待对抗审视 |
| 后续：审视通过 → code-implementation 建分支实现 | 未开始 |

## 机制识别检查点判定（实现期补录）

> 按 commit-convention「Modification-Class」要求补录（方案阶段漏判，对抗审视未覆盖此项；本段为新增附录，不改历史正文）。判定按特性全量给出，各层 commit 按自身 diff 承接命中项。

**检查点逐项**（troubleshooting skill 机制识别清单）：

| 检查点 | 特性全量 | 本 commit（Referee 层） |
|---|---|---|
| 新增配置字段/枚举/开关 | 未命中（无运行时配置） | 未命中 |
| 新增状态生命周期 | 命中——牌局局态（创建→存活→结算），归引擎层 commit 承接 | 未命中（纯函数无状态） |
| 新增定时任务/后台进程 | 未命中 | 未命中 |
| 新增信号类型/消息格式 | 命中——WS 消息帧，归页面层 commit 承接 | 未命中 |
| 新增持久化存储 | 命中——sqlite 牌局表，归引擎层 commit 承接 | 未命中 |
| 新增决策分支（结果被记住并影响后续行为） | 命中——振听/流局/结算分支落局面状态，归引擎层 commit 承接 | 未命中（分支为纯运行时返回值，不落盘） |
| 新增跨模块调用路径 | 命中——引擎→裁判、页面→引擎接线，归引擎/页面层 commit 承接 | 未命中（本 commit 内裁判仅被测试引用） |

判定：特性全量命中 4 项 → 走修法决策树④，首层 commit 声明 `Modification-Class: mechanism-addition`；后续各层 commit 按上表就地承接各自命中项。

**机制预算四问**（作者=麻将裁判獭，实现期当场作答）：

- ① **谁需要它**：搭档（chen）——日常打三麻、明确要求「先把三人麻做出来」；以及引擎层/页面层两层后续獭（裁判 API 与类型是其依赖面）。
- ② **失败后果**：用户可感知的牌局不公——错判役/符/点会直接错和错付；防线是 326 例分层测试 + mahjong-utils oracle 实测对拍。
- ③ **后续机制**：加法带来的未来问题类——规则口径漂移（雀魂调整役/符/点表时需同步）、引擎接线错用（振听标记时序、双响分配）、存疑口径在落地后被实测推翻；对应修法=oracle 对拍回归 + 牌谱抽样定位，存疑点已列「待核实清单」（见实现记录）。
- ④ **退役条件**：三麻玩法下线（搭档不再玩/项目转向）随特性整体删除；或 mahjong-utils 修复三麻支持且口径对拍一致，裁判可被其替换退役。

（重对抗门留痕：方案已过异模型对抗审视+delta复核，搭档 2026-10-15 批准；门控「治本/治标」三问未随该轮审视显式出证——四问系实现期补录，建议本轮代码检视追加核验。）

## 实现记录（Referee 层，2026-10-15）

**范围**：`src/entities/mahjong/`（tile/meld）+ `src/usecases/mahjong/referee/`（12 模块）+ `tests/usecases/mahjong/`（12 文件）。纯函数无 IO；引擎状态机/玩家适配/存储/路由/页面均不在本层。

**API 面**（`referee/index.ts` 统一导出，后续獭接口）：

- 向听/分解：`shanten`/`regularShanten`/`chiitoiShanten`/`kokushiShanten`、`decompose`（四形枚举）、`waits`、`isWinning`、`meldToBlocks`；类型 `ShantenResult`/`Pattern`/`Block`/`WaitType`
- 符：`calcFu`（`FuContext`）——20 底符/听牌形+2/门清荣和+10/非平和自摸+2/暗刻/副露碰杠/雀头役牌/副露最低30/切上/七对25/国士30
- 役：`detectYaku` + `COMMON_HAN`/`YAKUMAN_MULT` 表（28 普通役 + 13 役满，三色同顺不入表——三麻无 2-8 万不可成立）
- 点：`pointsFromHanFu`/`yakumanPoints`（`PointBreakdown` 含三麻自摸分布字段）
- 宝牌：`countDora`（表/里/赤/拔北）
- 总评：`evaluateWin`（`WinContext` → `WinResult`：valid/reason/yakus/yakuHan/dora/totalHan/fu/points/pattern，高点法取最大）
- 振听：`isFuriten`/`hasTempFuriten`/`canRon`/`multiRon`（三麻双响无头跳，放镜者对每家全额）
- 动作：`canRiichi`/`canDiscard`（食替）/`canCall`（碰/杠/拔北，吃恒拒）/`isTenpai`
- 流局：`detectAbortiveDraw`（三风连打/四杠散了/九种九牌）、`notenSettlement`（流局满贯 +4000 / 3000 交换）
- 实体：`parseTiles`/`formatTiles`/`sortTiles`/`tileKind`/`doraKindFromIndicator`/`buildSanmaWall`（108 张）、`Meld`/`isMenzen`

**关键口径**（以 mahjong-utils 源码 + hora API 为 oracle 实测对拍，非凭记忆）：

- 点数：`a = fu × 2^(2+han)` 截 2000；子荣=4a、亲荣=6a；三麻子自摸每家 `ceil100(1.5a)`（自摸损）、亲自摸每家 2a；累计役满 `1+floor((han-13)/13)` 倍
- oracle 钉死四个反直觉口径：役牌需刻子（雀头不算）、全带幺九需含顺子（纯老头不计）、二盃口不含一盃口、役满全叠加
- 高点法同点 tiebreak = 翻优先（oracle 同点选了 10 番版非 9 番 40 符版）；双碰荣和 −2 符（flat）
- 测试期望值机械生成自 oracle（dump/probe/gen 脚本），避免期望与实现同源自证
- lint：复杂度/长度超限处按仓内既有惯例（98 处先例）附 `eslint-disable` + 理由（规则表类函数天然多分支）

**测试统计**：12 文件 / **326 例全绿**（≥300 验收门 ✓）

| 分层 | 文件 | 例数 |
|---|---|---|
| 记谱/牌实体 | tiles | 33 |
| 点数 | points（oracle 全枚举） | 86 |
| 普通役 | yaku（28 役逐役） | 36 |
| 役满 | yakuman（13 役逐役） | 16 |
| 动作合法性 | actions（立直/食替/副露） | 24 |
| 向听 | shanten | 23 |
| 符数 | fu（20/25/30/40/50/60/70+切上） | 23 |
| 流局 | ryuukyoku | 22 |
| 振听 | furiten（三变体+双响） | 20 |
| 和牌总评 | win（e2e+非法分支+选项） | 19 |
| 宝牌 | dora | 14 |
| 听牌 | waits | 10 |

全役种 41/41 每役 ≥1 例；仓内全量回归 378 文件 / 5951 例通过 0 失败；`tsc --noEmit` 干净；eslint 0 错误。

**已知缺口/待核实**：

1. `KUIKAE_SAME_WAIT`（碰后同听形替换禁令）在三麻碰牌结构下不可达（结构性论证：唯一解 = 弃牌与所鸣之牌同种，已被同种禁令先拦），分支保留作防御、无正例覆盖
2. 待引擎层雀魂实测核实：1 万指示牌的万子宝牌口径（现按标准次序落已移除的 2 万 = 恒 0 张）、三麻亲自摸每家 2a、三风连打含北与否、流局满贯细则、累计役满阶梯、连风雀头 4 符（rounding 后不可观测故未测）
3. 验证节「天凤三麻牌谱抽样回归」未做——需外部牌谱数据，未在本层范围，待大獭排期

## 实现记录（口径核实，2026-10-16，麻将引擎獭）

**核实途径声明**：本机无外网（curl 实测 DNS 解析失败 + 连接超时，会话内证据），无法访问雀魂官方规则页；改用两条替代途径——① mahjong-utils 0.7.7 离线缓存安装（npm cache 命中，包体拆分 mahjong-utils + mahjong-utils-entry，oracle 走 `call()` 动态入口）做独立口径实测；② 规则结构推理 + 规则知识置信度标注。**凡未实测项均显式标「未核实」，未拿雀魂实盘验证过的结论不当定论。**

对缺口 2 六项的冻结结论（追加不改历史）：

| # | 口径项 | 结论 | 核实途径 | 置信度 |
|---|---|---|---|---|
| 1 | 1 万指示牌的万子宝牌 | **维持现口径：万子次序落在已移除的 2 万 → 该局恒 0 张宝牌**；备择假设「环绕到 9 万」存在于部分规则源，未排除 | 无外网、无 oracle（三麻专属）、无缓存资料 → **未核实** | 中低（留雀魂实盘对照钩子） |
| 2 | 三麻亲自摸每家 2a | **确认**：亲自摸每家付 2a（与人数无关的按份公式） | oracle 实测：kazoe 探针 parentTsumo=16000 = 2×8000（a=8000 时）；与裁判 points.ts `tsumoParentPays=2a` 一致 | 高 |
| 3 | 三风连打含北与否 | **维持现口径：东南西北四风全含**（detectAbortiveDraw k∈[27,30]） | 三麻专属、无 oracle、无外网 → **未核实** | 中（留实盘钩子） |
| 4 | 流局满贯细则 | **维持现口径：恰一家听牌 → 该家 +4000，余两家各 -2000**（三麻仅 2 家赔付，零和结构 4000/2=2000 必然） | 结构推理（零和 + 单家听）+ 标准规则通行，无雀魂特有分支的证据 | 高（结构）/中（细则变体） |
| 5 | 累计役满阶梯 | **维持现口径：每 13 番 +1 役满**（13-25→1x、26-38→2x、39-51→3x、52-64→4x，points.ts:77 `k=1+floor((han-13)/13)`）；**注意：mahjong-utils 不同**——其实测 kazoe 为平坦 1x（13/25/26/39/52/65 六点探针全 = 1x，a=8000），与裁判在 han≥26 处分叉，oracle 不可作本项核实源 | 规则知识（通用累计阶梯）+ 裁判现口径一致；oracle 反证已记录 | 中（留 26+ 番雀魂牌谱钩子） |
| 6 | 连风雀头 4 符 | **确认：双风雀头 +4 符且不给役** | oracle 实测：`options.hasRenpuuJyantouHu=true`（默认开）+ 对照探针（东场东家 11z 雀头 hu=40 vs 无风同形 hu=30，pre-pair 28 唯一差异 = +4 符）；yaku=[Tsumo] 仅 1 番 = 雀头不给役（与裁判「役牌需刻子」一致） | 高 |

**附带事实（非缺口，供后续参考）**：

- mahjong-utils 离线安装：npmmirror 缓存命中 `mahjong-utils@0.7.7`（空壳依赖包）+ `mahjong-utils-entry@0.7.7`（真身，Kotlin→JS bundle）；`--no-save` 临时装，未入 package.json。oracle 动态入口 `call(method, json)`，HoraArgs 字段为 `agari`(单张)/`tsumo`/`tiles`(单张字符串数组)/`dora`(**番数整数不是指示牌数组**)/`selfWind`/`roundWind`(枚举名 `East`/`West`/`South`/`North`)。
- 曾疑裁判 shanten/decompose 缺字牌顺子（`kind < 27` 限定 decompose.ts:114）——**自查撤回**：字牌不可构成顺子为各玩法通用规则，裁判与 oracle 判「非和了形」均正确，探针期望标错，无缺陷。
- oracle 另实测：连风雀头双风判役为 0（仅符）、切上满贯默认关（hasKiriageMangan=false，同雀魂）、kiriage/aotenjou 选项口径与裁判 ScoreOptions 默认值一致。

## 实现记录（Engine 层，2026-10-16，麻将引擎獭）

**范围**：`src/usecases/mahjong/engine/`（状态机+代理）+ `src/usecases/mahjong/room/`（落帧/适配/编排）+ `src/interface-adapters/http/controllers/mahjong-controller.ts` + router/bootstrap 装配 + `mahjong_games`/`mahjong_frames` 新表。逐模块提交（每模块一 commit）：

| commit | 模块 |
|---|---|
| 4bf29d43 | 六项口径核实冻结（见上节） |
| 1beaf78a | 引擎骨架：types.ts 单帧快照模型 + rng.ts 种子洗牌 |
| 835c94a8 | 状态机主体（配牌→摸打→副露窗口→立直→和了/流局）+ 剧本测试 5 例 |
| 902d46f5 | 规则代理 + 节流阀判定 + 路径覆盖测试 9 例 |
| 66136d44 | sqlite 落帧（新表+哈希链+恢复往返）+ 测试 3 例 |
| 646a568c | 獭调度适配 + 房间编排 + 测试 11 例 |
| 1e2f0b23 | Hono 八端点 + SSE + bootstrap 装配 + API 集成测试 2 例 |

引擎层测试合计 30 例（engine 5 / proxy+覆盖 9 / frames 3 / room+adapter 11 / API 2，另 0 例属口径探针已删）；动作合法性全部委托裁判层，引擎零规则实现。

**页面獭接口面（/api/mahjong，Hono JSON+SSE）**：

- `POST /api/mahjong/rooms` 建房即开局：`{roomId?, seed?, players:[{kind:"human"|"otter"|"proxy", name, otterId?}×3]}` → 201 `{roomId, gameId, seed, status}`（players 校验失败 400，房间已存在 409）
- `POST /api/mahjong/rooms/:roomId/join` `{seat:0|1|2}` → 该座私有视图（手牌可见）；他人座 `hand:null`
- `POST /api/mahjong/rooms/:roomId/start` 幂等开局回执（未知房尝试 recover，仍无 → 404）
- `POST /api/mahjong/rooms/:roomId/actions` `{seat, action}` 真人动作注入 → `{accepted, view}`；非停驻位/非该座 → 400（action 必须逐字来自 decision.actions）
- `GET /api/mahjong/rooms/:roomId/view?seat=` 视图（无 `seat` = 观战全览含三家手牌）。视图字段：`{roomId, gameId, status, roundNo, honba, sticks, dealer, phase, seatWinds, wallRemaining, doraIndicators, players[3]{seat,name,kind,points,hand|null,melds[{type,tiles,from}],kita,discards,riichi,riichiTurn,ippatsu}, decision{kind:"turn"|"claim",seat,actions[],drawn?,claim?{discardSeat,discardTile}}|null, awaitingHuman{seat,deadline}|null, settlement}`
- `GET /api/mahjong/rooms/:roomId/frames` 复盘：`{count, chainOk, brokenAt, frames[{seq,action,prevHash,hash,createdAt}]}`；`?state=1` 每帧附全量 `state` 快照
- `GET /api/mahjong/rooms/:roomId/events` SSE：`text/event-stream`，首帧 `{"type":"hello",roomId,gameId}`，其后 `data:` 推送 `RoomEvent`——`game`（`{events[], decision, frameSeq, wake{via:"trivial"|"proxy"|"otter"|"fallback"|"human"|"timeout-fallback", speech?, fallbackReason?, attempts?}}`）/ `human-wait{seat,deadline}` / `error{message}`；15s `: ping` 心跳
- `POST /api/mahjong/rooms/:roomId/recover` 断线恢复：最新帧还原 + 续推（无库内房间 → 404）

**关键实现决策**：

1. **唤醒路径（S1/S2）**：`SdkOtterGateway` 直调 `SdkInvokePort.invoke(otterId, prompt)`，**不带 conversationId**（纯 session，不落对话 entry）。失败链：解析/非法/异常/超时 → 携反馈重试 1 次 → 规则代理兜底（`fallbackReason` 广播留痕）。超时默认 90s。
2. **方案 delta（实现期发现，留痕供审视）**：方案「Invoke 前调 `acquireSessionLock`（sdk-invoke-port.ts:112）」不可执行——`PiSessionFactory.invoke()` 内部已取同键 per-otter 锁（pi-session-factory.ts:712 invoke 带锁、:690 acquireSessionLock 同 `session:${otterId}`），外层再取同键锁 = 嵌套等待 → 每次唤醒悬挂至超时。**以实现为准不在外层取锁**，串行化由端口 invoke 自带锁保证。
3. **节流阀（方案 S3）**：`isTrivialDecision` = 回合无特殊动作（和/立直/杠/拔北/九种九牌/副露窗）且代理结论 = 摸切 → 直接执行不唤醒；`proxy` 座位任何回合均直接代理（经由分流修复，不进唤醒）。
4. **落帧**：每步动作后全量快照入 `mahjong_frames`，`hash = sha256(prev_hash ∥ seq ∥ action_json ∥ state_json)`（基于库内存储串重算，恢复/复盘重算一致）；`verifyChain` 定位篡改帧号。恢复 = `restoreEngine(最新帧.state)` 逐字节等价（测试断言）+ 续推。
5. **口径实现注记（均非 oracle 可核实项，沿「实现记录·口径核实」表结论执行）**：拔北补牌从活山取（雀魂实盘待对照）；三麻本场荣和 +200×本场、自摸每家 +100×本场（结构对称推定，置信度中）；双响供托均分；包牌（大三元/大四喜）仅荣和且全部刻子由打出牌完成才有包牌人（取最后完成者）；立直后不提供拔北（引擎口径）；王牌固定布局 `[0..3]岭上 [4..8]表宝牌([4]初始) [9..13]里宝牌`。
6. **副露窗口**：候选家按离打出者近者先问、全员答完裁决；和 > 碰/杠（ron 胜 pon 不受座位序影响）、双响允许；加杠先开枪杠调查窗（全员过才落杠）。四杠散了在「第 4 杠后首次无人和的打牌」触发（岭上和了/枪杠/荣和优先，条款函数仍全在裁判层）。
7. **立直/一发/同巡振听时序**：一发在任何鸣牌（含自家杠）与自己下一次打牌时清除；同巡振听在自己摸牌清除（仅立直者，裁判 hasTempFuriten 口径）；食替经 `canDiscard(justCalled)` 全权过滤。

**已知缺口/待办（引擎层）**：

1. **无外网联调**：无 conversationId 的 SDK 直调运行时行为（签名可选、未实测）与真獭唤醒全链路（mock 已测解析/重试/兜底）待有网环境联调；雀魂口径实盘对照（1 万指示牌宝牌/三风连打含北/拔北补牌源/本场荣和 200）同待实盘。
2. **暗杠 vs 对手立直的跨家约束**：引擎未加额外守卫，全权委托 `canCall`——若裁判层对「立直者等待形不变」类约束有缺口，属裁判层裁决范围（引擎不越权改规则）。
3. **静态页挂载**：`GET /mahjong/:roomId` 页面静态资源不在本层（web-mahjong/ 属页面层）；JSON/SSE 已就绪。
4. **局终形态**：东风战 4 局毕即终局（无连庄延长/突破协议）；包牌细则为简化版（见决策 5）；观战帧端点无鉴权（内网单机假设，随 web 面统一收口）。
5. oracle 曾发现 kazoe 阶梯与 mahjong-utils 分叉（见上节）——若雀魂实盘推翻累计阶梯口径，改动点在裁判 `points.ts`，非引擎。

## 实现记录（Web 层，2026-10-16，麻将页面獭）

**范围**：`web-mahjong/`（原生单页）+ `src/bootstrap/server.ts` / `src/app.ts` 静态挂载（引擎层缺口④）+ `tests/web-mahjong/`、`tests/bootstrap/server-mahjong-static.test.ts`、`eslint.config.mjs`（web-mahjong 浏览器 globals 块）。逐模块提交：

| commit | 模块 |
|---|---|
| 7d0b55e2 | 模块四·牌局页全量：静态挂载 + 牌桌渲染 + SSE 实时联动 + 动作注入 + 开局流程（36 例测试） |
| c3daadef | 模块四·开局流程接 join/start 端点 + 恢复后按座位重取私有视图（手牌可见性防线） |

**页面文件清单**（web-mahjong/，无图片、无新 npm 依赖、不进 vite 构建链）：

- `index.html`——牌桌挂载点（场况栏/左右家/中央/自己区/遮罩/提示条），空壳，内容全由 app.js 渲染
- `style.css`——配色参照 `game/index.html`（只读参考）；牌河 6 列 grid、立直横置、窄屏单列降级
- `js/view.js`（318 行·纯函数，零 DOM 零网络）——视角变换/手牌排序/牌面字形与标签/暗牌张数推导/动作按钮状态机/手牌可点性
- `js/api.js`——7 个 JSON 端点薄封装（动作对象原样透传）
- `js/sse.js`——EventSource 订阅 + 退避重连 + recover 前置 + 静默断链看门狗
- `js/app.js`——URL 路由/遮罩流程/DOM 组装/事件绑定/倒计时/结算与终局展示

**八端点对接确认表**（路由注册：`src/interface-adapters/http/router.ts:264-271`）：

| # | 端点 | 页面消费点 | 状态 |
|---|---|---|---|
| 1 | POST /api/mahjong/rooms | 大厅「建房开局」→ `api.createRoom` | ✅ 已消费 |
| 2 | POST /api/mahjong/rooms/:id/join | 入座遮罩选座 → `enterRoom` | ✅ 已消费 |
| 3 | POST /api/mahjong/rooms/:id/start | `enterRoom` 末位幂等开局确认（回执丢弃，见决策 5） | ✅ 已消费 |
| 4 | POST /api/mahjong/rooms/:id/actions | 手牌点击/动作按钮 → `dispatch` | ✅ 已消费 |
| 5 | GET /api/mahjong/rooms/:id/view?seat= | 初始载入/每轮刷新/恢复后按座位重取 | ✅ 已消费 |
| 6 | GET /api/mahjong/rooms/:id/frames | `api.frames` 已封装，页面未消费 | ⬜ 封装就绪·未消费（复盘 UI 非方案模块四范围） |
| 7 | GET /api/mahjong/rooms/:id/events (SSE) | `sse.js` 全程订阅（hello/game/human-wait/error） | ✅ 已消费 |
| 8 | POST /api/mahjong/rooms/:id/recover | 遮罩「尝试断线恢复」+ `sse.js` 第 2 次重连前置 | ✅ 已消费 |

（7/8 消费；#6 复盘留待后续）

**关键实现决策**：

1. **静态挂载**：serveStatic 的 `path` 选项不可靠（`server.ts` 既有注释），故 `/mahjong` 与 `/mahjong/:roomId` 用 readFile 直读 index.html（对齐 SPA fallback 写法）；资源走 `serveStatic + rewriteRequestPath` 把 `/mahjong/assets/*` 削成 `/*`。两组路由注册在 `app.use("/*", serveStatic)`/`app.get("*")` **之前**，fallback 内再显式 404 排除 `/mahjong*`（双保险）。新参数 `mahjongStaticRoot` 缺省跟随 `staticRoot` 总开关（false 时不挂）。
2. **座位方向**：right = seat+1（下家）、left = seat+2（上家）——锚 `engine.ts:103` `(caller + 1) % 3 === discardSeat → shimocha`。
3. **动作逐字透传**：`tileAction` 返回 `decision.actions` 里的**原对象**（identity 断言写进测试），HTTP 面「action 必须逐字来自 decision.actions」天然满足。打牌/立直/加杠按记谱**逐字匹配**——按种类匹配会把点红五 `0p` 发成普通五 `5p`（写测试时发现）；暗杠按种类匹配（动作给 `kind`，同种类张等价）。
4. **暗牌张数推导**：视图对非本人 `hand: null` 无张数可用 → `13 +（轮到该家且已摸牌 ? 1 : 0) − Σ副露扣除（吃/碰 2、明杠 3、暗杠 4、加杠 3）`；拔北不改张数（引擎 `doKita` 从活山补牌、不进 melds，`engine.ts:721`）。
5. **全览视图防泄漏**：`start`/`recover`/无 seat 的 `view` 回执都是 `seats=null` 全览（三家底牌可见）。页面只把「自己座位的私有视图」写进 `state.view`，全览回执仅当确认信号用；恢复后必按座位重取（c3daadef）。
6. **手牌排序与刚摸的张**：种类升序 + 赤五在前（稳定保序）；刚摸的张拆到手牌**右端**单独标绿——不能按 code 全匹配，同码张会被一并标成「刚摸的」（真机截图发现，已修）。
7. **SSE 看门狗**：15s 心跳是 `: ping` 注释帧，EventSource 不上抛 → 页面量「距最后 data 帧 35s」主动断开重连；重连从第 2 次起先 POST `/recover` 再重开事件流（进程重启后房间不在内存时的唯一入口）。

**测试**（页面层 36 例；`npm run test` 全量 387 文件 6009 例通过）：

- `tests/web-mahjong/view.test.ts` **21 例**——视角变换/手牌排序/牌面字形与标签/牌河立直横置/场况栏/动作按钮状态机/手牌可点性/暗牌张数推导
- `tests/bootstrap/server-mahjong-static.test.ts` **8 例**——深链接不被 SPA 吞、资源映射、staticRoot=false 不挂、仓库真页面可达
- `tests/web-mahjong/api-sse.test.ts` **4 例**——api.js × 真路由（join 私有/观战全览/动作注入/帧链/404）、断线退避+recover+close 干净、看门狗重连、真 SSE 流桥接（hello→game→human-wait）
- `tests/web-mahjong/page-visual.test.ts` **3 例**——真 Chrome + 真 HTTP 端口（入座→牌桌→出牌、观战、大厅）：零控制台报错、牌河 6 列、手牌张数与服务端一致、牌面为 U+1F000+ 麻将字符；截图留档 `MAHJONG_SHOT_DIR`（不入库）

**已知缺口（页面层）**：

1. **对话侧入口卡/战报卡与 D2 防护未落地**——见下节，跨层归属待大獭裁决。
2. **内嵌聊天框只落地前半**：「獭 speech 实时流入」可由 `game` 事件 `wake.speech` 取到（页面已进对局日志），但**真人回话无端点**（8 端点里没有 chat 注入口），方案「回话在下局开局时作为首条 user 消息注入獭 session」在 engine/room 侧亦未见实现——需引擎层补口。
3. **复盘 UI 未做**（#6 frames 封装未消费）。
4. 观战/页面无鉴权（引擎缺口④同源，随 web 面统一收口）；`/mahjong/assets` 与 `:roomId` 同层，roomId 恰为 `assets` 时会返回 index.html（无实际影响）。
5. 真机截图只跑本机 Chromium——Windows/无麻将字符块字体的回落未验证；牌面已备 `title`/`aria-label` 中文名兜底。

### 模块五（对话侧触点）研究结论与待裁决项

**html-card 机制**（`api-contract/api/html-card.ts:8/12/18`）：一条消息最多 2 卡、单卡 65536B、schema v2；围栏 `html-card` 体内是 HTML。**围栏内的链接不算裸链**（`send-entry-unfurl-scan.ts:6`：URL 独占一段才算，围栏体内不算）——要 unfurl 预览就得让链接独占一段且不进围栏。

- **入口卡（无需新码，随时可用）**：建房后由大獭在对话 speak，两种形态二选一：
  ① 裸链（触发自动 unfurl 预览卡）：`三麻桌已开 🀄 {origin}/mahjong/{roomId}` 独占一段；
  ② html-card 链接卡：

  ```html-card title="🀄 三麻桌已开"
  <p>东风战 · 35000 点 · 1 真人 + 2 獭</p>
  <p><a href="{origin}/mahjong/{roomId}">进牌桌 →</a></p>
  ```

  建房接口：`POST /api/mahjong/rooms {roomId?, seed?, players:[{kind,name,otterId?}×3]}` → 201 `{roomId, gameId, seed}`；页面大厅同款表单在 `/mahjong`（分享链接 → 对方打开即入座遮罩）。

- **战报卡（未落地，卡在「目标对话不可得」）**：触发点在 RoomService 局终广播（`room-service.ts:378 publishGame`），但**房间全程无 conversationId**——`createRoom(roomId, config)`（`room-service.ts:140`）与 GameConfig/PlayerConfig 只有 `otterId`，HTTP 建房 body 亦无（`mahjong-controller.ts:55`）。可行推导已存在：`agent-invoker.ts:1728 resolveFirstConversationId(otterId)` → `conversationQuery.getIdsByOtterId`（牌搭子獭挂靠对话）。**提案**：RoomService 加一个局终回调端口 `onGameover(roomId, settlement, ranking)`，bootstrap 装配时接 `SendEntry`（`src/usecases/conversation/send-entry.ts:115`，html-card 正文 + `create_linked_resource` 登记）→ 改动点在 `room/` + `bootstrap/`，**属引擎层，页面侧不自行改，待裁决**。

- **D2「打牌中」应答（未实现，口径需裁决）**：`grep 打牌中 src/` 为空（未落地）；`sdk-invoke-port.ts:120 isRunning?` / `agent-invoker.ts:868 isRunning()` 已在位，但它是「有进行中 invoke」的**通用**忙碌口径（`agent-invoker.ts:1671` 已用于手动重启 409）。直接拿它当「牌局中」会把所有忙碌獭（定时任务/长任务）都答成「打牌中」。精确谓词要「谁在某局牌里」（RoomService 座位表），同样是引擎层状态。**提案**：引擎侧暴露 `isSeated(otterId)`（或常驻房间表查询），对话派发点前置判断 → 自动回「打牌中」不进 LLM；派发插入点未核实（凭 `agent-invoker.ts:1671` 有忙碌分支，具体 @ 派发链待排查）。

---

## 实现记录（Engine 层收尾：模块五三条跨层缺口，2026-10-16，麻将引擎獭）

大獭 10/16 裁决：页面獭上报的三条跨层缺口（战报卡 / D2 应答 / 真人回话端点）归引擎层收尾。本节追加记录，不改上文历史。

### 提交与测试

| commit | 内容 |
|---|---|
| `e6d6078e` | RoomService 核心三钩：isSeated + addChat/下局开局注入 + onGameover 上报（含 room-types.ts 拆分） |
| `b01159d1` | 真人回话 HTTP 端点 `POST /api/mahjong/rooms/:roomId/chat` |
| `6a21bc5f` | D2：AgentInvoker 入座拦截 + 自动应答「打牌中」+ 安全词例外（含 CreateSpeakEntryInput.invokeId 可选化） |
| `a157a42a` | 战报卡：gameover-report.ts 渲染/编排 + bootstrap 装配 |

- 新增测试 18 例（room 7 + api 1 + D2 4 + 战报 6）；全仓 **390 文件 / 6027 过 / 6 跳 / 0 败**；tsc + eslint 0 error
- 一轮全量中 `rhi-signal-tools-batch-bind`「单批100 截断」抖动 1 次（单跑双绿、次轮全量未复现，与本特性无代码交集）——如实记录
- lint 触顶（max-lines/complexity）处置 = 拆函数（advanceRound/collectStepReport/winLine…）+ 拆类型文件（room-types.ts），**未用 disable**

### 1. 真人回话（方案「内嵌聊天框」后半 + 回话注入）

- 第 9 端点 `POST /rooms/:roomId/chat {seat,text}`：400 校验 / 404 未知房 / 409 已终局 / 200 回执含视图
- `RoomService.addChat`：按 **otter 座位分队**入队（一言双獭各自消费）+ SSE `chat` 事件广播（页面 sse.js 未知类型已确认安全忽略；聊天框实时回显待页面层接）
- **下局开局注入**：跨局 nextRound 后各 otter **并行**经 gateway 直调 `buildChatInjectionPrompt`（独立首段 user 消息——方案「不走运行中 reset/不走 systemPrompt」口径）；成功清队、失败留次局重试；终局轮不注入
- 取舍：独立 invoke（非并入唤醒 prompt）= 方案字面口径，代价是每次注入每 otter 1 次 LLM 调用（回话稀少，可接受）；**注入回复文本当前丢弃**（仅入 session 上下文）——獭回应回显聊天框需页面层接新事件，未做
- 队列仅内存态：进程重启丢失（帧链不含聊天）——聊天是易失交互，接受，留痕

### 2. D2「打牌中」应答（方案 delta D2）

- **插入点核实结论**（方案留白项）：对话派发多入口（message-controller dispatchTurnLoop / signalRouter 点火 / agent-dispatch-service / scheduler / recruiting / invoke-controller 重试）**全部收敛于 `AgentInvoker.invokeConversation`**——单点拦截即覆盖 web/feishu/weixin 全链
- 拦截行为：speak entry 自动应答（metadata `source:mahjong-d2`）+ `entry.speak` SSE 广播（实时气泡）+ 合成 turn 结果 `d2-<uuid>`（链引擎 fetchProducedMessage 查 invokes 无此 id → tsp 空 → 链自然收束，既有降级容错不新增分支）
- **安全词保底（自查发现，差点埋雷）**：链引擎「停下」reminder 是附在消息尾随靠 LLM 确认（`dispatch-chain-engine.ts:210-216`「不硬拦」）——若无例外直接拦截，入座獭永远看不到急停指令。例外口径：拦截前 `scanStopWords` 命中即放行走 LLM；扫的是全量消息（含历史），误报方向 = 放行（安全方向，顶多一轮 LLM）
- `CreateSpeakEntryInput.invokeId` 改可选 + 落库 `?? null`：`entries.invoke_id` 外键 ON（`schema.ts:1069`），无 invoke 场景不能造假 id
- 挂接：`attachMahjongSeatQuery` 延迟 attach（同 attachAgentDispatchService 先例；app.ts initControllers 后挂 `controllers.mahjong.roomService.isSeated`）
- **已知边界**：入座獭牌局进行中的定时任务 invoke 同样被拦（同走 invokeConversation——局中换世正是 D2 要防的）→ 该轮任务以「打牌中」应答代替执行；入座判定 `status==="playing"`，终局即恢复对话侧正常

### 3. 战报卡（方案「终局回调」）

- `RoomService.onGameover` 端口 + `GameoverReport`：gameOver 事件名次（publishGame 单点聚合）+ **跨局**结算亮点（`round.settlement` 只留末局，须在 publishGame 采集）+ wake 发言/代理代打计数（step 内）；loop 顶一次性 fire（reportedOver 幂等）；回调抛错仅告警不回滚牌局
- **recover 已终局牌局不补发**：防跨重启重复播报；重启窗口内未发的战报丢失（接受，留痕）
- `gameover-report.ts`：`renderGameoverCard`（单卡 title 围栏 / 名次 kv / ron·tsumo·noten·abortive 四类亮点行 / 锐评末 8 条截断 / 全量 HTML 转义 / 64KB 上限内）→ `sendGameoverReport`（**首个 otter 座位**的 `getIdsByOtterId[0]`——与 resolveFirstConversationId 同源同缺陷（无 ORDER BY 返回序未定义），选对话策略仍为独立议题）；无 otter 座位/无挂靠对话跳过告警；`linkResource` fact ≤500 失败不回滚发卡
- **锐评口径**：取 wake.speech 原文末 8 条直展，**不调 LLM 二次总结**（方案写「獭锐评摘要」——原文零成本零延迟；需要 LLM 摘要时再加一次局终调用）
- 入口卡不需新码（沿用模块五研究结论）：建房后大獭 speak 裸链或 html-card 即可

### 页面层接口面补充（供页面獭/大獭知悉）

- 第 9 端点：`POST /api/mahjong/rooms/:roomId/chat`
- SSE 新事件：`{type:"chat", roomId, seat, text, at}`（实时回显人声；页面未消费，安全忽略）
- 战报走对话侧 entry（sendEntry），不经牌局 SSE；D2 应答同样走对话 entry + `entry.speak` 广播
