---
id: F20261020mjfx
title: 三麻 playtest 六问题修复（#1564）
summary: chen 实机试玩六条问题一次修——立直后仅摸切+禁副露（正确性）、局终结算停驻+停局接口+离桌 runaway 界（体验/止血）、fallback 内部细节不外显、唤醒发言必填；特效不一致核实为 by design 留档
change_type: fix
capability_test: "四块行为钉：①立直后动作集仅 tsumo/tsumogiri/kan/ron/pass（engine 新增 5 例，RED→GREEN）②结算停驻不自动换局+continue 放行+超时自动继续（room-lifecycle 4 例）③stopRoom 出 Map+通知、runaway 到限停局（同文件）④fallback 日志无内部原因串、speech 必填（room-service 9 例全绿，含 speech 空串断言 2 条）"
created_in_conversation: a00f8fec-1ec0-4c63-9b1d-27b5756b2fc8
intent:
  problem: "chen 2026-10-20 实机 playtest（房间 sanma-1020）报六条：①fallback 内部错误串漏进对局日志 ②立直后仍能摸牌/连摸三张（游戏正确性）③獭全程不发言 ④打牌特效不一致 ⑤局终无结算停顿瞬间换局 ⑥无停局接口+真人离桌后自动换局 runaway 烧 token。"
  expected_effect: "立直后操作集锁定（仅摸切+荣和/过）；局终结算可停留可继续；真人可随时停局；对话不泄内部实现；桌上有獭的发言氛围。"
  verify_by:
    type: behavior_check
tags: [mahjong, fix, playtest]
modules: [src/usecases/mahjong/engine, src/usecases/mahjong/room, src/interface-adapters/http, web-mahjong]
causal_links:
  - issue #1564（chen 2026-10-20 实机 playtest 六条问题，大獭分诊立案 P1）
  - F20261016mjsg 三麻全量落地（本篇修其 playtest 暴露的六缺口）
  - F20261019chet 聊天回显（#1 fallback 为该链路的同族残留）
---

# 三麻 playtest 六问题修复（#1564）

## 背景

chen 2026-10-20 上午实机试玩三麻（房间 sanma-1020，东风战 35000 点），打出六条问题（issue #1564），大獭分诊立案后派麻将引擎獭修复。七个 commit 收口（实现 4 + 首轮检视处置 3，分类声明见下）。

## 分诊与修复

| # | 问题 | 分诊 | commit |
|---|---|---|---|
| 2 | 立直后还能摸牌/连续摸三张 | 游戏正确性，最高优先 | `检视2` narrow-fix |
| 1 | 「fallback · 回复中未找到 JSON 对象」漏进对话 | 内部降级外泄 | `检视1/3` narrow-fix |
| 3 | 獭全程不发言（无聊） | 发言闸门过紧 | `检视1/3` narrow-fix |
| 5 | 局终无结算停顿，瞬间自动换局 | 体验 → 新能力 | `检视5/6` mechanism-addition |
| 6 | 无停局/删房接口 + runaway | 止血 → 新能力 | `检视5/6` mechanism-addition |

> 锚点口径（抗 rebase）：commit 一律以 subject 前缀引用（`git log --grep` 可定位），hash 两次因 rebase 断链已弃用。
| 4 | 打牌特效不一致 | **核实为 by design**（见「不做」） | 无代码改动 |

### #2 立直后摸打约束（正确性）

**根因**（troubleshooting 定位，白盒单测复现，两处同族）：
- `engine.ts turnActions` 无立直门：立直后仍对全部手牌张构建打牌候选——真人/獭均可打非摸切张（chen 观感「立直后还能摸牌」即每个回合仍被提示手动出牌，「连摸三张」即连续数回合手打非摸切张）
- `engine.ts claimActions` 无立直门：立直家可被 pon/daiminkan 候选命中 → 鸣碰后 turn 无 drawn → 动作集空 → 獭代理 crash（`proxy: empty action set`，既有副露路径测试实证触发——修复暴露了这个此前被「立直后仍可打任意张」掩盖的洞）

**修复**（雀魂口径）：
- 立直后打牌候选仅剩刚摸的那张（tsumogiri）；`apply` 由既有合法集校验拒绝非摸切打牌（IllegalActionError）
- 立直后副露窗口只剩荣和/过——碰/大明杠不进候选
- 暗杠/加杠照常提供：**雀魂口径立直后可杠（枪杠风险自担），无「听牌不变」限制**——该限制是旧式规则而非雀魂规则，实现期核实后不引入（曾按「听牌不变」写了 wait-check，测试前置断言暴露口径错误后撤回）

### #1 fallback 外泄 + #3 獭不发言

- #1：`web-mahjong/js/app.js:717` 把 `wake.fallbackReason`（如「回复中未找到 JSON 对象」）直渲染进对局日志。改为 fallback/timeout-fallback 只给中性「（代打）」标签；排查链路走 frame 存储与服务端事件元数据（fallbackReason 仍在事件里，只是不外显）
- #3：唤醒 prompt「speech 可省略」导致几乎全场无发言 → 改必填（≤30 字人味：吐槽/评牌/报听/情绪）。**节流阀维持方案 S3 口径不变**（trivial 回合不唤醒 LLM，防刷屏+省 token）——发言集中在非平凡回合（鸣牌窗/立直/杠/和了决策点）；附带加固（检视建议7）：LLM 回空串/纯空白 speech 视同未提供，不携带进事件（防前端判空歧义）

### #5/#6 局终结算停驻 + 停局接口（mechanism-addition）

**机制判定**：大獭 10/20 分诊先行（派工原话「修：局终结算面板+继续按钮」「修：停局/删房接口」）——属新能力非 narrow-fix。

**四问**（机制判定层，实现前已在派工分诊锚定；文档落档于 PR 阶段）：
- ①治本？✓ 结算停驻解决了「看不到结算」的根因（时序：停驻发生在 advanceRound 之前，win/draw 事件已广播、下一局 deal 未发）；停局接口给了永久止血阀（此前唯一停局路径是重启服务）
- ②治标而非治本？✗ 停驻/停局是牌局生命周期的显式状态，不是补丁式 if
- ③信息不足？✗ 方向由分诊裁决锚定；实现期缺口（room-service 顶 max-lines）按既有拆分先例（room-chat.ts）解决
- ④有更窄的替代？「只加 stop 接口不做停驻」可省一个状态，但 chen 的核心痛点是结算体验，砍停驻=不解决问题

**行为**：
- 有真人的房局终不再瞬间换局——挂停驻定时器（`settleHoldMs` 默认 30s）；到期自动继续；页面「继续」按钮即刻放行（`settleResumed` 放行位防重 park）；末局（第 4 局）按钮文案为「查看终局 →」（继续即进终局，如实标注）；纯獭/代理房维持直推（无人可等）
- `POST /api/mahjong/rooms/:roomId/continue`（404 未知房/409 已终局/400 非停驻态）；`POST /api/mahjong/rooms/:roomId/stop`（终局/进行中均可停：广播通知+清全部定时器+房间出 Map）；**页面入口**：场况栏「停局」按钮（confirm 后调 `api.stop`，成功回大厅——检视严重1 修复，接口不再无 UI 调用点）
- **离桌 runaway 界**：真人连续超时代打计数（`humanIdleStrikeLimit` 默认 10）到限自动停局并广播；真人注入动作清零（回场不误伤）

**实现拆分**：生命周期函数（settleRoundEndFlow/continueSettlement/stopRoomFlow/guardHumanIdleStrike）自 room-service 拆至 `room-lifecycle.ts`（room-service 顶 max-lines 450；定时器回调不进 class，room 内部态经结构化参数注入——与 room-chat.ts/gameover-report.ts 拆分同先例）

## 不做

- **#4 特效统一：by design 留档**——牌桌特效矩阵为：吃/碰/杠（含拔北）横幅 + 立直宣言横幅 + 和了演出；普通出牌/摸切无横幅（与雀魂一致：幺九牌打出的小飘字提示除外，本页未实现该细节）。若 chen 后续想要统一轻反馈（如每次出牌音效/动画增强），另立需求单独立项，不在本修复内顺手加
- chat 历史内存态（刷新丢历史）、包牌简化、东风战 4 局毕等既有口径留档不变（F20261016mjsg）

## 测试与证据

- **RED→GREEN**（#2）：复跑口径（检视建议1 修正）——**当前测试 × 修复前引擎（`daeac012`）** 4 例红（`/tmp/mj-riichi-red2.txt`，全为缺陷断言红：候选集过宽×2 / 非摸切拒不生效 / 禁副露不生效——无测试构造错误），修复后 engine.test.ts 10 例全绿；本 PR 新增 5 例（4 例立直约束 + 1 例 kakan 无立直门）
- **生命周期**：room-lifecycle.test.ts 新增 4 例（停驻不自动换局+继续放行 / 超时自动继续 / stopRoom 出 Map+通知 / runaway 到限停局）；既有驱动器补「结算停驻点继续」适配（room-service.test 9 例、room-report-chat 12 例、api 4 例均绿）
- **HTTP 契约**（检视建议5）：tests/api/mahjong.test.ts 新增 continue/stop 契约例（continue 404/400/200/409 四态 + stop 404/200×2，长停驻服务可控行验证放行路径）
- 全量回归数据见 PR body（pre-existing 超时 flaky 附隔离复跑证据）

## 已知残留

- 立直后暗杠的「雀魂是否完全无限制」口径按「立直后可杠」实现——若后续 playtest 发现雀魂实操有更细限制（如杠后同巡限制），再按实测调
- **拔北口径**（检视建议4 留档）：引擎立直后不提供拔北（`engine.ts` 既有门，注释自标「引擎口径」）；雀魂三麻立直后可否拔北未实测核实（域外判断，置信度中）——若实测口径不同再调
- 结算停驻只在「有真人座位」的房生效；真人中途退座（座位无人接管）的边界与离桌界共用计数逻辑，未单独做 UI 提示
