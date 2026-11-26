---
title: CoLink 私聊历史翻页跟随平台统一契约（SDK 0.28.1 / limit+cursor）
id: F20261118clkpg
date: 2026-11-18
module: extensions
change_type: fix
from: F20261118clkpt
summary: |
  平台（CoLink #3393 / F20261118dmcur）把 App 私聊历史读取统一成与话题同款的
  limit + 不透明 cursor，`beforeId/afterId` 被删除且**无兼容层**（服务端 strictObject 直接
  400 EXTENSION_INVALID_INPUT）。我们按 0.28.0 契约把私聊分页固定成 beforeId/afterId，
  于是线上「翻私聊更早历史」必然失败（首屏不带参数仍正常，所以真机验证没暴露）。
  本次把 vendor 从 0.28.0 升到 0.28.1（colink a2e4c18f），扩展侧分页参数统一为
  limit/cursor、删掉按来源分叉的白名单，工具 schema 与提示词同步，并新增 vendor 侧契约
  断言：任何人把 vendor 回退到 0.28.0 都会在 CI 立刻变红。
intent:
  problem: "线上私聊历史翻页参数已被平台删除（实测 400 EXTENSION_INVALID_INPUT），而插件仍按 0.28.0 只放行 beforeId/afterId、反而拒绝合法的 cursor，导致模型翻私聊历史必然失败"
  expected_effect: "私聊与话题共用同一套翻页写法（limit + 上一页 nextCursor），工具层不再按来源分叉参数白名单；旧参数在工具层即被拒为 COLINK_TOOL_ARG_NOT_ALLOWED，不再把注定 400 的请求发给平台；vendor 回退会被契约测试当场拦下"
  verify_by:
    type: behavior_check
    evidence:
      - "extensions/colink-agent-app npm test：40/40 通过（含 DM 用 cursor 成功、hasMore/nextCursor 原样透传、beforeId/afterId 在工具层被拒、vendor 侧 SDK 契约断言）"
      - "变异验证：工具层回退到 HEAD 旧白名单 → DM 用例 2 条红；vendor 的 turn.mjs 把 dm 白名单改回 beforeId/afterId → vendor 契约用例红；删掉提示词里的「续页重复同一个 limit」→ 措辞用例红；恢复后 40/40 全绿"
      - "线上只读探针（ECS 用真实用户令牌，仅看参数校验，不读内容）：beforeId/afterId → 400 EXTENSION_INVALID_INPUT；cursor → 通过参数校验（返回 401 因该令牌已过期）"
      - "SDK 构建锚：colink@a2e4c18f0 的 dev/app-toolkit/distribution/build.mjs 产出 0.28.1，sdk-pin.json 记录 sha512 nbXyyW8qVDzjzcidKgv3UYmJnyS4xkRfjAEx1r15EXNi6L1HbxsdGLzVDtNipZkWOKCMlmMGHKr4A6OeRaCwAQ=="
capability_test: "extensions/colink-agent-app/test/colink-tools.test.mjs"
---

# F20261118clkpg：私聊历史翻页跟随平台统一契约

## 触发

搭档转来上游 issue [colink-group/CoLink#3382](https://github.com/colink-group/CoLink/issues/3382)《统一话题与私聊的历史消息分页契约》，同事判断「私聊没有按频道实现统一」。

核对结论：**该 issue 本身是上游把两类来源的分页契约统一的工作项**（其余验收项在平台侧），但同事的技术判断成立，而且线上已经坏了——我们做的是「对齐 0.28.0 那一版契约」，而 0.28.0 的两类来源本来就不统一。

## 事实与证据

| 事实 | 锚点 |
|---|---|
| 平台私聊读取已是 `limit + cursor`，`beforeId/afterId` 删除且无兼容层 | colink `d4ca3e757:dev/backend/.../app-message-reads.ts:157-160`（"不再接受 beforeId/afterId 消息 ID 游标（F20261118dmcur）"） |
| SDK 侧同样的统一 | colink `a2e4c18f0:dev/app-toolkit/sdk/javascript/src/events/turn.mts` → `const allowed = ['limit', 'cursor']` |
| 我们按 0.28.0 分叉成「话题 cursor / 私聊 beforeId+afterId」 | `sdk-pin 0.28.0` 的 `vendor/app-sdk/src/events/turn.mjs:10`；本插件 `src/colink-tools.mjs:9`（旧 `SOURCE_LIMITS.dm`）与 `:242`（旧 `allowed` 分叉） |
| 线上实测平台已不认旧参数 | ECS 只读探针：`beforeId` → `400 EXTENSION_INVALID_INPUT`；`afterId` → `400 EXTENSION_INVALID_INPUT`；`cursor=bogus` → 通过参数校验后 401（令牌过期） |

**影响面**：私聊首屏（不传分页参数）正常，所以 11-18 的真机验证没暴露；一旦模型翻私聊更早历史（按旧提示词会传 `beforeId`）必然失败；同时合法的 `cursor` 被我们自己在 SDK 层拒成 `INVALID_READ_OPTIONS`。

## 改动

1. **vendor 升级**：`@colink/app-sdk` 0.28.0 → **0.28.1**（colink `a2e4c18f0`，即 #3393 那个 commit，仅含分页统一；不含后续 `feat(tasks)!` 等破坏性改动）。`sdk-pin.json` 由 `npm run prepare:sdk` 重新生成。
2. **工具层统一**：`SOURCE_LIMITS.dm` 改为 `{limit:100, cursor:2048}`；`callTool` 不再按 `source.kind` 分叉白名单，两种来源统一 `['limit','cursor']`。
3. **清单版本** 0.6.0 → **0.6.1**：本次要重新部署线上，版本号让「部署的是哪一版」可辨识。
4. **工具 schema 与提示词**：删掉 `beforeId/afterId` 两个参数；`cursor` 描述改为「上一页返回的分页游标，原样传回；话题与私聊一致」；私聊提示词从「只传 limit/beforeId/afterId」改为「只传 limit/cursor（翻页用上一页返回的 nextCursor）」。
5. **「游标绑定 limit」讲清**：平台校验 `cursor.limit === limit`（`a2e4c18f0:app-message-reads.ts:159-176`），首页显式传 `limit:20` 后只传 `cursor` 会因默认值不同（私聊缺省 50）判 `INVALID_CURSOR`。工具描述、`cursor` 参数说明与系统提示词都补上「续页重复首页的 limit」，并用一条用例锁定这三处措辞。
6. **测试**：
   - 私聊用 `cursor` 读通，且 `hasMore/nextCursor` 原样透传（工具层不得吞平台契约字段）；
   - `beforeId`/`afterId` 在**工具层**即被拒为 `COLINK_TOOL_ARG_NOT_ALLOWED:*`（不把注定 400 的请求发给平台）；
   - 私聊 cursor 超长（2049）→ `COLINK_TOOL_CURSOR_INVALID:cursor`；
   - 非末页透传：`hasMore=true` + 非空 `nextCursor` 原样透传（原 fixture 只有末页，覆盖不到）；
   - **vendor 契约断言**：直接驱动 `vendor/app-sdk/src/events/turn.mjs`，私聊读只接受 `limit/cursor`、拒绝 `beforeId/afterId`，且身份固定为当前用户的 `messages:read-private`。这条是防「vendor 被静默回退」的缺口——工具层测试用打桩，看不出 pin 到的 SDK 到底放不放行 cursor。

## 为什么只升到 0.28.1，不直接追上游最新

上游 `a2e4c18f0..d4ca3e757` 之间还有 5 个 SDK commit（`feat(tasks)!` 任务流统一、artifacts 升版、搜索个人 Agent、后台授权、构建隔离），SDK 目录 +1010/−235。那些是**另一个待办的升级轮**，与本故障无关；把破坏性任务流改动塞进这次抢修会放大回归面。本次只取修好分页的那一个 commit，并在文档里声明这个取舍。

## 边界与未覆盖

- **未做**平台上其余统一项（默认 30 条、末页语义、Playground 夹具、升级说明）——那是平台侧的 issue 剩余验收项，不是 App 侧义务。
- **未验证**真实私聊多页翻到底（需要真实多页私聊数据 + 有效授权）：本地用 fixture 与 vendor 契约断言覆盖参数与透传；真实数据库的多页行为由平台侧 MySQL spec 覆盖（`colink-api.mysql.spec.ts`）。
- 上游 issue #3382 剩余方案里「续页省略 limit 时沿用游标中的值」是**尚未实现**的平台侧计划（当前平台是严格的 `cursor.limit === limit`）。所以我们现在只能靠提示词要求模型重复 limit；等平台放开后，这条约束可以去掉（届时由上游 issue 收口）。
- **未做**向新读取/定位（`afterId` 语义能力）的替代接口：上游明确「App 与 App HTTP 的普通历史列表只向旧翻」，网页端定位另属网页能力面。
