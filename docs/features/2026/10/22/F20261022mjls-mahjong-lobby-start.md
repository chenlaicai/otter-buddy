---
id: F20261022mjls
title: 麻将三麻「建房≠开局」：lobby 等待态 + 手动开始 + 默认/自定义陪打獭
summary: 拆分建房与开局——createRoom 只建 lobby 等待房（不立即发牌起跑），搭档在牌桌点「开始」才发牌开局；建房支持默认獭设置与自定义陪打獭选择；lobby 房 1 小时未开始自动清理。修复「建房即开局导致真人未入场就被离桌止血阀强拆」的体验缺陷（搭档 10-22 09:16 定调）。
doc_type: feature
change_type: feature
capability_test: tests/usecases/mahjong/lobby-start.test.ts
created_in_conversation: a00f8fec-1ec0-4c63-9b1d-27b5756b2fc8
created_at: 2026-10-22T09:35:00+08:00
tags: [mahjong, sanma, lobby, lifecycle, ux, otter-config]
modules: [src/usecases/mahjong/room/room-service.ts, src/usecases/mahjong/engine/engine.ts, src/interface-adapters/http/controllers/mahjong-controller.ts, web-mahjong/js/app.js, src/usecases/settings/settings-keys.ts]
from: [F20261016mjsg, F20261021gmbe]
supersedes: []
intent:
  problem: createRoom（room-service.ts:92）建房即开局——建引擎→startRound 发牌→kick 起跑一步到位，搭档还没入场牌局就在跑，17 分钟不操作即被真人离桌止血阀（#1564-6，连续 10 决策点未操作）强拆房间，报「房间不在内存」。搭档原话「建房后不要立即开始，得我点开始才开一局」。
  goal: 建房与开局解耦——建房只开 lobby 等待房（三座位就绪、不发牌），搭档主动点开始才发牌起跑；陪打獭可默认可自定义；lobby 房防占位超时清理。
  non_goal: 不改变对局内规则/引擎回合逻辑；不动离桌止血阀对「已开始牌局」的作用（只豁免 lobby 等待态）；不做大厅列表/多房管理 UI（单房起手）。
  expected_effect: 建房后房间停在 waiting 态不发牌不计数离桌，点开始后发牌起跑；等待房 1 小时自动清理。
  verify_by:
    type: behavior_check
---

## 背景与根因

现状链路（实证锚点）：
- `createRoom`（`src/usecases/mahjong/room/room-service.ts:92`）：建房即 `new SanmaEngine(config)`（引擎构造 status=playing）→ `engine.startRound()` 发牌 → 落库 → `publishGame` + `kick` 起跑。无中间等待态。
- 真人离桌止血阀（`room-service.ts:411`）：`humanIdleStrikeLimit ?? 10`，真人连续 10 个决策点未操作 → 停局清房出内存 Map。
- 事故链：搭档 08:51 建房 → 未入场（卡片未及展开/未出牌）→ 獭持续推进 → 真人 strike 累计至 10 → 房间被停局清出内存 → 搭档 09:08 join 报「房间不在内存，也没在库里」。

根因：**建房与开局耦合**——没有「等人就绪」的 lobby 态，真人未入场即被计入离桌。

## 方案设计（搭档 10-22 09:31 已拍板方向）

### 决策记录（搭档原话）
- ① 建房开**空房等待**，点开始时才拉獭入座开局（非建房即入座）；**要有默认獭设置 + 支持自定义獭**
- ② 开始由**牌桌页面「开始」按钮**触发（非对话指令）
- ③ lobby 房**要超时**：1 小时未开始自动清房防占位

### 状态机改动（引擎 + 房间）

引擎 `status` 增加 `"waiting"`（lobby）态：

```
[新增] waiting（lobby：房建好、座位配置就绪、未发牌）
   │  POST /rooms/:id/start（牌桌「开始」按钮）
   ▼
playing（startRound 发牌 → kick 起跑，现有逻辑不变）
   ▼
settle → finished（现有）
```

- `new SanmaEngine(config)` 构造后 `status="waiting"`（不再构造即 playing）；`startRound()` 将 waiting→playing 并发牌。
- `createRoom`：建引擎（waiting 态）+ 落库（status=waiting）+ 登记 lobby 房，**不 startRound、不 kick**。返回 lobby 视图。
- `start`（controller）：waiting 房 → 校验座位配置 → `startRound()` → kick → 返回 playing 视图；playing 房 → 幂等返回当前视图；不存在 → recover。

### 座位与陪打獭配置

`createRoom` 请求体扩展（向后兼容，均为可选）：

```json
{
  "roomId": "可选",
  "players": [
    { "seat": 0, "name": "chen", "kind": "human" },
    { "seat": 1, "name": "小獭一号", "kind": "otter", "otterId": "…" },
    { "seat": 2, "name": "小獭二号", "kind": "otter", "otterId": "…" }
  ]
}
```

- **默认獭设置**：settings 新增 key `mahjong.defaultOtters`（JSON：两个 otter 座位的 otterId+name）。建房未显式传 otter 座位时，用默认设置回填；默认设置缺失时报错引导搭档先配置（或回退到系统推荐的两只小獭）。
- **自定义獭**：建房请求显式传 `players[*].otterId` 即覆盖默认——搭档可指定任意 active 小獭陪打。
- 设置页/对话侧提供「默认陪打獭」配置入口（settings PUT `mahjong.defaultOtters`）。

### 离桌止血阀豁免 lobby 态

`humanIdleStrikes` 只在 `status=playing` 且真人已入局的决策点累计；`waiting` 态不计 strike（房根本没发牌，无「离桌」可言）——从根上消除「未入场被强拆」。

### lobby 超时清理

`waiting` 房登记 `createdAt`，evict 增加 lobby 分支：`waiting` 且距今 > `lobbyTtlMs ?? 3_600_000`（1 小时）→ 自动 close 清房（无需 strike，纯 TTL 防占位）。

## 影响范围

| 层 | 文件 | 改动 |
|---|---|---|
| 引擎 | `engine.ts` | status 枚举 + waiting 态；startRound 守卫 waiting→playing |
| 房间 | `room-service.ts` | createRoom 拆 waiting；start 触发开局；止血阀豁免 waiting；evict lobby TTL |
| 契约 | `api-contract/api/key-info.ts` 或 mahjong 契约 | players 配置 + lobby 状态视图 |
| 控制层 | `mahjong-controller.ts` | create 不再即开局；start 对接 waiting→playing |
| 设置 | `settings-keys.ts` + settings-controller | `mahjong.defaultOtters` key + 读写 |
| 前端 | `web-mahjong/js/app.js` | lobby overlay 渲染「开始」按钮 + 座位就绪态 + 自定义獭选择入口 |

## 取舍

- **选「空房点开始拉獭」（①B）而非「建房即入座干等」（①A）**：尊重搭档「自定义獭」诉求——点是拉獭的触发点，拉哪只由开始时的配置决定，更灵活；代价是 start 时才做獭可用性校验（獭不存在/忙碌需在 start 报错）。
- **默认獭存 settings 而非硬编码**：搭档要多獭场景（陪打獭会换），设置化可演进；代价是多一个 settings key 与配置入口。
- **start 幂等**：playing 房重复点开始返回当前视图不报错（牌桌可能重复点击/刷新重进）。
- **waiting 房也落库**：recover 可恢复 lobby 房（进程重启后等待房不丢），与 playing 房同一恢复通道。

## 已知风险

- **start 时獭可用性**：自定义獭在 start 时可能已解散/忙碌——start 需校验 otterId 有效（active 且未 dissolved），失败给清晰报错，不产生半开局房。
- **状态机回归**：waiting 是新态，所有判 `status==="playing"` 的分支（join/止血阀/evict/恢复/战报）需逐一核对——测试覆盖是关键（capability_test）。
- **默认獭缺失**：搭档首次用且未配默认獭时，建房报错文案需友好引导（去哪配）。

## 验证

1. `tests/usecases/mahjong/lobby-start.test.ts`（capability）：
   - 建房 → status=waiting、未发牌（无 hand）、无 kick 起跑
   - start → waiting→playing、发 14 张、kick 起跑
   - start 幂等：playing 房重复 start 返回当前视图
   - 默认獭回填：不传 otter 座位用 `mahjong.defaultOtters`；自定义 otterId 覆盖默认
   - waiting 房不计 humanIdleStrikes（10+ 决策点等待不被强拆）
   - lobby TTL：waiting 房 1 小时未 start 自动清理
   - start 校验：自定义獭 otterId 无效/dissolved → 报错不开局
2. 前端 lobby overlay：「开始」按钮 + 座位就绪 + 自定义獭选择渲染（web-mahjong 手工实测截图）。
3. 全量测试 + lint + tsc，CI 三绿。

## 下一步

1. 对抗审视（检视獭，异模型——重点：状态机新增 waiting 态的分支穷尽性、默认/自定义獭校验面、止血阀豁免边界）
2. 呈搭档终审（决策简报）
3. 批准后 code-implementation（派实现獭）

---

## 实现记录（2026-10-22，实现獭代码填空）

### 变更清单

| 层 | 文件 | 改动 |
|---|---|---|
| 引擎 | `engine/types.ts` / `engine/engine.ts` | `GameState.status` 加 `"waiting"`；构造后 status=waiting；`startRound` 首调 waiting→playing（nextRound 内部重入复用不拒绝） |
| 落帧 | `room/frames.ts` | `createGame` 第四参 status（默认 playing 兼容）；新增 `updateGameConfig`（start 重配座位后回写库内 config） |
| 房间 | `room/room-lobby.ts`（新文件） | `startLobbyRoom`（幂等/覆盖/校验/回填状态机）+ `buildLobbyView` + `scheduleLobbyEvict`/`clearLobbyEvict` + `applyDefaultOtters` + `checkOttersUsable` |
| 房间 | `room/room-service.ts` | `createRoom` 拆 waiting（不 startRound 不 kick）；`startRoom` 接线；`beginPlay` 发牌起跑链；`recover` waiting 分支（重挂 TTL）；`close` 清 lobby 定时器；`loop` 顶 waiting 守卫（不出循环不 fireGameover）；`isWaitingSeat` 谓词；`collectReportEvents` 拆出 |
| 战报 | `room/gameover-report.ts` | `buildGameoverReport` 组装函数拆入（service 控行数） |
| 设置 | `settings/settings-keys.ts` | `MAHJONG_DEFAULT_OTTERS_KEY` + `MahjongDefaultOtter` + `parseMahjongDefaultOtters`；`api-contract/api/settings.ts` DTO 加 `defaultOtters`；`settings-controller.ts` 读写 + 校验 |
| 契约 | `room/room-types.ts` | `RoomView.lobby` 字段（waiting 态座位就绪况）；`RoomServiceDeps` 加 `lobbyTtlMs`/`checkOtterUsable`/`defaultOtters` |
| 控制器 | `mahjong-controller.ts` | create 回 status=waiting；start 改真开始（body 可选 players 覆盖；400/404 分流；同步段抛错 400 引导） |
| 装配 | `bootstrap/controllers.ts` + `app.ts` | `mahjongOtterDeps` 注入（settings 读取默认獭 + otterRepo.getByIds 校验 active/dissolved） |
| 前端 | `web-mahjong/js/app.js` / `api.js` | waiting 遮罩（开始按钮/座位就绪况/换獭入口）；`enterRoom` 移除自动 start；`onStartGame` 收集覆盖 POST start；建房文案更新；api.start 带 payload |
| 测试 | 新 `tests/usecases/mahjong/lobby-start.test.ts`（7 断言）；既有 room-service/room-lifecycle/room-report-chat/api/web-mahjong 测试适配（createRoom 后补 startRoom——语义适配非删断言）；page-visual 新增 waiting 遮罩真机用例 |

### 实现要点与取舍落地

- **止血阀豁免方式**：不在 `guardHumanIdleStrike` 加状态判断，而是从根上消除——waiting 房不 kick、不 parkHuman，`humanIdleStrikes` 根本不累计（loop 顶 waiting 守卫直接 return）。测试⑤验证：strikeLimit=2 + timeout 10ms 下 waiting 300ms 纹丝不动，start 后照常到限停局。
- **lobby TTL 与终局驱逐同构**：`scheduleLobbyEvict` 仿 `scheduleEvict`（代际校验 gameId + unref）；start 时 `clearLobbyEvict`。已开始的房不再受 TTL 影响（测试⑥后段验证）。
- **默认獭回填时机**：在 start 而非建房时回填（方案①B 取舍：点是拉獭触发点）。占位 otter 座位按序取默认（不按座位号取——proxy/human 座位不消耗默认位）。回填/覆盖生效时重建引擎（waiting 未发牌无损失）+ `updateGameConfig` 回写库内（恢复真相源）。
- **start 幂等口径**：非 waiting 房重复 start 返回 `alreadyStarted: true` 不报错；controller 层回执当前视图（终局驱逐后的房回 `"already started"` 状态字符串）。
- **半开局房防线**：獭校验失败/默认獭缺失均返回错误且房保持 waiting（库内 status 也仍是 waiting——测试⑦验证）；发牌前的所有同步操作失败都不落库变更。
- **前端状态机**：waiting 视图优先显 waiting 遮罩（join 遮罩退后——start 前 seat 概念尚不生效）；`enterRoom` 不再自动调 `api.start`（否则一进房就开局，破坏等待语义）；「开始」收集换獭输入仅在差异时带 players 覆盖。
- **room-service 行数**：lobby 逻辑拆 `room-lobby.ts`（结构化参数注入，同 room-lifecycle 先例）后仍 493 行（上限 450），文件头加 `eslint-disable max-lines` 带理由（编排核心不可再拆，参照 engine.ts 单类先例）。

### 机制判定（机制识别检查点）

本特性经 RA 流程，判定已在方案期完成；代码填空阶段新增机制自查：无新机制——waiting 态是既有状态机的扩展（枚举 + 分支），lobby TTL 复用既有 evict 模式，默认獭配置复用 settings key 模式。`Modification-Class: mechanism-addition`（状态机新状态 + 新 settings key 属新增机制，非既有机制内修——经重对抗门）。

### 验证记录（实现者自报）

- ✅ `tests/usecases/mahjong/lobby-start.test.ts` 7/7 通过（方案验证节七条断言逐条覆盖）
- ✅ 全量 `npm test`：416 文件 6652 passed / 6 skipped（含既有 mahjong 全套回归 + 新真机用例）
- ✅ `npx tsc --noEmit` 0 error；`npx eslint .` 0 error
- ✅ UI 真机自查（Playwright Chromium）：waiting 遮罩渲染（开始按钮可见且在视口内、两个换獭输入在位）→ 点开始 → 发牌 13+ 张进牌桌，无控制台报错；截图 `/tmp/mjls-shots/06-waiting.png` / `07-started.png`（已固化进 page-visual.test.ts 作为长期回归门）
- ✅ 最简实现检查：已过——引擎只加一个枚举值 + 构造默认值变更；lobby 逻辑全部复用既有模式（evict 代际校验/结构化参数拆分/settings key）；未引入新依赖、新表、新路由（start 端点语义复用）
- 负面向验收：本变更破坏的旧契约 = 「createRoom 即 playing」的调用方预期（四个测试文件 + 两个 API 测试适配）；「POST /rooms 响应 status 恒 playing」的契约改为 waiting（前端 api.js 注释同步）。无绕过既有保护的路径——止血阀/fireGameover/恢复通道均在 waiting 下走新分支而非被绕过。
- Golden Gate：n/a（本变更纯代码逻辑 A 类，无 prompt/skill/协议层改动——capability_test 字段声明的 lobby-start.test.ts 为 A 类行为契约测试）
- CI：推送后 gh run watch 验证（结果待 PR 后回填）
