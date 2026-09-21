---
id: F20260921wxba
title: 微信入站路由锚分裂修复：消息恒走 bot 账号锚 + 删号释放绑定
summary: 用户移除微信重扫建新线「我的微信」后消息仍进旧对话。根因（代码+DB 双实锤）：扫码建线锚=accountId（app.ts provisionWeixinAssistantLine），消息路由锚=fromUserId（message-processor process），两键永不相等——新线从建成即收不到消息，旧时代按人建的线继续吸走消息；增量五只改了飞书的 bot 锚，微信 ingress 漏网。修复：入站 ensureConnection 改用 botAccountId（platforms 装配传 account.id，与建线同键，飞书 feishu-bot:<appId> 同构），fromUserId 保留给出站 contextToken 定向/命令门禁/entry 身份；附带修删号不清绑定（onWeixinAccountDeleted 释放 bot 锚 connection 活跃 session，防账号复用 id 时新线静默失效）。
doc_type: feature
change_type: fix
capability_test: "n/a: 路由锚/装配变更，无 prompt 行为语义可测（回归用例见 tests/interface-adapters/weixin/message-processor.test.ts F20260921wxba 两例）"
created_in_conversation: b11cf010-f20d-4f92-88e6-ecc6414017a6
tags: [weixin, im, assistant, routing, bot-anchor, bugfix]
modules:
  - src/interface-adapters/weixin/message-processor.ts
  - src/bootstrap/platforms.ts
  - src/app.ts
  - tests/interface-adapters/weixin/message-processor.test.ts
causal_links:
  - F20260920imax
created_at: 2026-09-21
---

# 微信入站路由锚分裂修复

## 预注册（动手前冻结）

- 预期根因方向：移除账号未清旧绑定，同锚二选一取了旧
- 验证标准：找到「删号不清绑定」或「路由多候选未取最新」的 file:line
- 最强反例：路由根本没建新对话 / 前端展示错位
- **实际结果：预期偏离**——查 DB 发现两条 weixin connection 的 external_id 根本不同（`weixin-muajiclk` vs `o9cq8003…@im.wechat`），不存在「同锚二选一」；方向修正为「锚分裂」后证据链闭合。

## 问题现象

2026-09-21 用户在 Web IM 页移除微信账号 → 重新扫码创建「我的微信」（新对话 01:02 建立）→ 微信发消息 → 消息进入旧对话「微信助理 · wechat」（前一天建），新对话零消息。

## 根因分析（证据链）

**建线锚与消息路由锚是两把不同的钥匙，永不相遇：**

1. **建线锚 = accountId**：`src/app.ts` provisionWeixinAssistantLine → `ensureConnection(accountId, accountId, "weixin")`。注释声称「与消息 ingress 的 ensureConnection 同键，幂等汇合」——**该断言错误**。
2. **消息路由锚 = fromUserId**（修复前 `message-processor.ts:62`）→ `ensureConnection(fromUserId, fromUserId, "weixin")`。fromUserId = 发消息的人的 ilink id（`polling-channel.ts:239`，取自 `msg.from_user_id`）。
3. **DB 实锤**（生产库 sqlite 直查）：两条 weixin connection——`weixin-muajiclk` → 「我的微信」（新，01:02）；`o9cq8003…@im.wechat` → 「微信助理 · wechat」（旧，前一天）。用户消息按 fromUserId 键 → 命中旧线。移除重扫只是暴露问题：**新线从建成那一刻就收不到任何消息**。
4. **为何旧线一直「能用」**：旧线是 ingress 按人自动开户时代所建，与消息路由同锚（fromUserId）。增量三/五把建线锚改到 bot（accountId），但 ingress 锚从未跟上——增量五的 bot 锚定只落了飞书侧，微信漏网。
5. **次级问题**：删号不清绑定（onWeixinAccountDeleted 只停轮询+取消登录会话）。与本次现象无因果（锚已分裂，清了也到不了新线），但构成下一个坑：账号复用同 id 重扫时 ensureConnection 幂等命中旧 connection，getCurrentConversation 返回旧对话，新建线静默失效。

## 修复设计（修法排序①：既有 bot 锚模型内对齐，narrow-fix）

搭档统一模型（F20260920imax 拍板）：一个 im 侧 bot = 一个海獭助理对话。本修复把微信 ingress 对齐到该模型，不新增机制。

| 改动 | 位置 | 说明 |
|---|---|---|
| processor 增 `botAccountId` 可选依赖 | `message-processor.ts` | 入站 `ensureConnection(anchor, anchor, "weixin")`，anchor = botAccountId ?? fromUserId（未装配回退旧锚，仅防御；线上恒传） |
| 装配传入 `account.id` | `platforms.ts` startWeixinAccount | poller 闭包本就持有 accountId，注入 processor——建线/消息从此同键 |
| 删号释放绑定 | `app.ts` onWeixinAccountDeleted | 查 bot 锚 connection 的活跃 session，releaseSession；失败仅告警不阻断删号 |

**机制识别检查点**：未命中清单（无新配置/状态机/定时/信号/存储/决策分支/跨模块调用——botAccountId 是既有依赖注入模式的可选参数，路由行为收敛到既有 bot 锚机制）。命中清单论证：无命中项，走修法排序①。

## 失败证据（bugfix 硬规则，5a 固化）

**修复前红**（2 例失败，忠实复现线上根因）：

```
✗ F20260921wxba：入站路由锚 = bot 账号（bot=对话），不按发送者开户
✗ F20260921wxba：两个发送者私聊同一 bot → 汇流同一对话
Tests  2 failed | 15 passed (17)
```

失败详情：`ensureConnection` 收到 `("user-a", "user-a", "weixin")` 而非 bot 锚——正是「消息按发送者开户」的线上行为。

**修复后绿**：`Tests 17 passed (17)`。

**验证总账**：tsc rc=0；ESLint 0 errors（新断言改行为断言后有状态 fake，符合 no-restricted-syntax）；backend 3624/3624；web 504/504。

## 影响范围

- **修后行为**：用户消息 → connection(accountId) → 「我的微信」；多人给同一 bot 发消息汇流同一对话（统一模型，飞书同构）；fromUserId 身份保留在 entry senderId / dispatch senderId。
- **旧线归宿**：「微信助理 · wechat」连接键是人的 id，不再被入站命中——自然停收，历史保留可查。旧线如需彻底清理，搭档在 Web 端操作即可。
- **出站回信不受影响**：gateway-adapter 按 toUserId(=fromUserId) 查 contextToken 定向（`weixin-gateway-adapter.ts:37-50`），与路由锚解耦。
- **已知边界**：删号释放为 best-effort（失败告警不阻断）；跨进程并发删号的窗口期理论存在，概率与危害均低。

## 审视处置（检视wxba，mimo 异模型，2026-09-21）

| 发现 | 级别 | 处置 |
|---|---|---|
| onWeixinAccountDeleted sync→async 类型断层（controller 签名仍 void、调用无 await，HTTP 200 先于 DB 清理返回） | 🔴 严重 | 已修：weixin-connection-controller.ts 签名改 `void \| Promise<void>` + deleteAccount 加 await；bootstrap/controllers.ts deps 同步放宽 |
| botAccountId 回退无日志无测试 | 🟡 建议 | 已修：回退时 logger.warn + 新增回退守卫用例（断言落发送者锚 + 告警） |
| 删号不清理旧 fromUserId 键连接（孤儿数据悬挂） | 🟡 建议 | 维持：旧时代进孤儿连接的功能无害（不被入站命中），清理属数据卫生非本 PR 边界；后续可与 issue #1063 死端点评估同批处理 |
| 修复前红未固化为可执行负例 | 🟡 建议 | 已修：即回退守卫用例（botAccountId: undefined → 断言旧行为 + warn），装配回退时从绿变红 |

## 预期 vs 实际对照

预注册预期「删号不清绑定」被 DB 证据推翻（两锚不同键，不存在竞争）→ 转向「锚分裂」假设 → 代码+DB 双验证闭合。次级问题（删号清绑定）作为附带修复纳入，非本次现象根因。
