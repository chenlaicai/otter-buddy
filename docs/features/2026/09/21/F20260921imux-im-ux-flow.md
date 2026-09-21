---
id: F20260921imux
title: IM 新建流程 UX 整改：先名后码 + 同号覆盖确认 + 助理线投影真相源
summary: 按搭档 UX 指令整改微信新建流程——①「点击新建 → 先输入助理名字 → 再显示二维码 → 扫码即建线」（原顺序：扫码成功后弹命名弹层）；名字即连接名，「起名建线」补丁按钮退役（流程前置闭合后无「已扫码未命名」状态）。②同一微信重扫时按 ilinkUserId（微信侧稳定身份）识别同号，弹「已有助理，是否覆盖」——确认删旧账号再建线（对话历史保留）。③账号→对话映射改后端真相源：listAccounts 投影 assistantLine.conversationId，取代前端 title.includes(acc.id) 启发式（增量三后必 miss，PR #1055 检视发现 2 的长期修复）。依赖 F20260921wxba（bot 锚路由 + 删号释放绑定——同分支叠加）。
doc_type: feature
change_type: feature
capability_test: "n/a: 流程时序/UI 重排 + 端点投影，无 prompt 行为语义可测（后端行为断言见 tests/interface-adapters/weixin/connection-controller.test.ts）"
created_in_conversation: b11cf010-f20d-4f92-88e6-ecc6414017a6
tags: [weixin, im, ux, assistant, account-mapping, duplicate-detection]
modules:
  - web/src/pages/im/index.tsx
  - web/src/components/weixin/QRCodeLoginCard.tsx
  - web/src/api/client.ts
  - src/interface-adapters/http/controllers/weixin-connection-controller.ts
  - src/interface-adapters/http/router.ts
  - src/bootstrap/controllers.ts
  - tests/interface-adapters/weixin/connection-controller.test.ts
causal_links:
  - F20260920imax
  - F20260921wxba
created_at: 2026-09-21
---

# IM 新建流程 UX 整改

## 搭档指令（逐字锚定）

> 扫码>弹出设置名字，我觉得这顺序不对，应该是点击新建时，要先要求我输出名字、然后再弹出二维码，然后，我设置名字之后，这个名字就应该作为这个连接的名字，不应该再有一个"起名建线"（我甚至看不到这是什么意思）。并且，如果我用同一个微信扫码，此时系统应该提醒我 已有助理，是否要覆盖移除。你要顺着用户的体验来梳理一遍咱们的功能

## 改动设计

### ① 先名后码（流程前置）

新流程：`＋ 新建助理连接` → 第 1 步输入名字（必填，创建后固定）→ 第 2 步显示二维码（名字以徽章贯穿显示）→ 微信扫码确认 → 立即 provision 建线 → 完成。

- 原流程的「扫码成功 → 命名弹层」弹层关闭即产生「已扫码未命名」孤儿状态（PR #1055 检视严重发现的补丁场景）——流程前置后此状态不再存在，「起名建线」按钮退役。
- QRCodeLoginCard props 改为 `lineName`（贯穿显示）+ `onLoginConfirmed`（扫码确认回调，页面接管后续）；卡片内不再有命名职责。

### ② 同号覆盖确认

- 识别键 = `ilinkUserId`（微信侧稳定身份）。accountId 是时间戳随机 id（`login-flow.ts:80`，`weixin-${Date.now().toString(36)}`）——同一微信号重扫必然产生新记录，**「断联回同一线」在账号层从未成立过**（既有 bug，本次覆盖流程顺带消解：旧账号被覆盖删除，新账号建线，用户感知连续）。
- 时机：扫码确认后（success），前端拉账号列表，按本次扫码账号的 ilinkUserId 找其它同号记录 → 命中弹「这个微信已有助理」→ 用户裁决：覆盖（删旧账号 → 新记录建线，旧对话历史保留可回看）或取消。
- 后端新增 `POST /api/weixin/accounts/lookup`（body: ilinkUserId → 已有账号 + 助理线投影）。前端当前在扫码后用列表本地匹配（更简单可靠），lookup 端点供扫码前预探测等演进场景。

### ③ 助理线投影（账号→对话映射真相源）

- `GET /api/weixin/accounts` 响应增 `assistantLine?: { conversationId }`（connectionRepo.getByExternalId(accountId) → getActiveSession 投影；可选注入，未注入时字段缺失，向后兼容）。
- 前端映射改 `acc.assistantLine.conversationId` 精确匹配，取代 `title.includes(acc.id)` 启发式——增量三（用户任意命名）后启发式必 miss，PR #1055 检视发现 2 建 issue 跟踪的长期方案，本特性落地。

## 机制识别检查点

命中「新增跨模块调用路径」（controller 增 connectionRepo 依赖）+「新增端点」（lookup）——但均为既有机制的窄扩展（只读投影 + 既有 store 查询），非净新增机制：无新配置/状态机/定时/信号/持久化/决策分支。走修法排序①（既有 provision/删号机制内重排流程时序）。

## 审视处置（检视imux，mimo 异模型，2026-09-21）

| 发现 | 级别 | 处置 |
|---|---|---|
| confirmOverwrite 错误提示误导（删成功但 provision 失败时提示「旧账号未删除」——用户误以为旧助理还在，不采取恢复动作） | 🔴 严重（S1） | 已修：两步错误语义拆分——delete 失败提示「未做任何变更，可原地重试」；provision 失败提示「旧已清理，请重新新建」并 resetFlow |
| startFlow 无谓 async 签名 + JSDoc 不符 | 🟡 建议（D1） | 已修：改同步，注释同步 |
| lookupWeixinAccount 未消费 | 🟡 建议（D2） | 保留为演进预留，api/client.ts 加标注 |
| IM 页无前端组件测试 | 🟡 建议（D3） | 建 issue 跟踪（与 LeftPanel 分组测试同批补） |


- 后端：`tests/interface-adapters/weixin/connection-controller.test.ts` 5 例（投影命中/缺失语义/lookup 命中/空/400），30/30（含既有 wxba 回归）全绿
- tsc 前后端 0 error；eslint 0 error（initControllers 超行已拆 buildWeixinControllerInstance）
- web 全量 505/505（现 worktree 快照）
- UI 流程：先名后码两步 + 覆盖确认弹层 + 建线中过渡态（真机验证待合入后由搭档扫码走查）

## 影响范围与已知边界

- 覆盖删除走 `deleteWeixinAccount`（含 F20260921wxba 的删号释放绑定 + 停轮询），旧对话保留。
- 扫码确认到 provision 完成之间有短暂「已连接未建线」窗口（页面有过渡提示，非持久孤儿态——用户停在页面上时闭环，离开则下次列表显示「未命名连接」提示可删除重试；比旧弹层孤儿态轻：新流程下该窗口以秒计且不依赖用户命名动作）。
- lookup 端点未在前端消费（预留演进）；accountId 时间戳随机的根治（改用 ilinkUserId 稳定键）超出本次范围，覆盖流程已消解其用户可见影响。
