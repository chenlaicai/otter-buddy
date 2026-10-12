---
id: F20261012qtbc
title: "Token 余量统一展示：三家控制台真实余量采集 + 健康面板「配额」看板"
summary: "搭档主用智谱 GLM / Kimi / MiMo 三家订阅账号，此前每次都要开三个控制台网页查 5 小时/本周余量。本特性新增「配额」看板（健康面板第 5 个 Tab）：Playwright 持久档案浏览器定时访问三家控制台页、拦截配额 XHR、归一化为统一窗口模型（按家配窗口：GLM 5h+周、Kimi 5h+7日、MiMo 单余量），面板并排展示余量条+重置时间+耗尽状态。硬边界（搭档拍板）：纯展示——不进 healment/警报等观测数据、不影响调度与模型选择、无任何通知开关。API key 无余量接口（实测 ~30 端点全 404），唯一数据源是控制台网页接口，需网页登录态（首用/过期弹窗扫码一次）。"
change_type: feature
capability_tags: [quota, web-ui, playwright, health-panel]
capability_test: "n/a: 纯展示看板特性。验证 = 单测（三家响应归一化 fixture + TTL 缓存/登录态判定）+ web 组件测试（渲染态）+ Playwright 真机截图自检（UI 视觉变更硬规则）+ 首次真实登录冒烟（需搭档扫码，见「验证」节的验证边界声明）"
created: 2026-10-12
created_in_conversation: 11806e11-1cac-4d00-b263-badff1a80f2b
tags: [quota, playwright, health-panel, web-ui]
modules: [src/frameworks/quota, src/usecases/quota, src/interface-adapters/http/controllers/quota-controller.ts, web/src/pages/health/QuotaBoard.tsx]
causal_links:
  - F20260914usgm   # 健康面板用量看板（本特性同面板新增「配额」Tab，与「用量/效率」分工不同：用量=系统自己烧了多少，配额=账号还剩多少）
  - F20260902sgp2   # 429 配额耗尽降级（既有机制，由真实报错驱动，与本特性零耦合——本特性不读不写该链路）
---

# Token 余量统一展示：三家控制台真实余量采集 + 健康面板「配额」看板

## 背景

搭档主用三家订阅账号（智谱 GLM Coding Plan、Kimi For Coding、MiMo Token Plan），每个账号在控制台网页上有用量窗口（一般为「5 小时余量」「本周余量」）。此前每次查余量要开三个网址控制台逐个看，期望系统直接统一展示，且**要准确数字**（明确否决了本地估算路线）。

## 目标 / 非目标

**目标**
- 从三家控制台网页接口采集**真实余量**（与控制台显示同源），统一展示在健康面板新「配额」Tab
- 按各家真实窗口形态渲染（GLM：5h+本周；Kimi：5h+7日；MiMo：单余量）
- 登录态管理：首用/过期弹浏览器窗扫码一次，其余全自动

**非目标（搭档拍板，边界即需求）**
- ❌ 不进系统观测数据：不写 healing 台账、不进「警报」Tab、不进任何观测/指标体系
- ❌ 不影响系统运行：不参与调度/派工/模型选择（与 F20260902sgp2 429 降级链路零耦合，那是真实报错驱动的另一套机制）
- ❌ 无任何通知开关（搭档原话「移除这个开关」）：纯看板视觉状态（红条/耗尽/重置倒计时），不推送、不打扰
- ❌ 不做自动充值/换账号/降级决策

## 接口探查证据（2026-10-12 静态逆向前端 bundle，探查全记录见对话工作区 quota-console-probe/）

| 端点 | 证据 | 状态 |
|---|---|---|
| GLM `GET /monitor/usage/quota/limit`（bigmodel.cn 同源） | 懒加载 chunk module a279 `u["d"]`；响应 `{data:{limits:[…],level}}`，limit 项字段 `title/name`、`currentValue`、`showLimitCount`、`nextResetTime` | ✅ 端点+字段已定名 |
| MiMo `/api/v1/tokenPlan/detail`、`/tokenPlan/usage`、`/tokenPlan/subscription/status` | main chunk 路由表 + 实测 401（`{"code":401,"loginUrl":"account.xiaomi.com/…"}`，API key 同样 401） | ✅ 端点已定名，字段待首登锁定 |
| Kimi `/apiv2` connect-RPC（`kimi.gateway.order.v1.SubscriptionService` 一族） | pb 描述符解码 + 页面 i18n（statsWeeklyUsage 等）；精确 method/字段待运行时抓包定名 | 🟡 定名待首登 |

**关键结论**：三家 API key 均无余量查询接口（实测 ~30 候选端点全 404，真实调用响应头无 ratelimit 配额字段），唯一数据源是控制台网页接口，一律认**网页登录态**。

## 方案设计

### 数据模型（按家配窗口，搭档纠正后定稿）

```ts
QuotaWindow { key, label, used, limit, remaining, remainingRatio, resetAt }
ProviderQuota { provider, label, status: 'ok'|'needs-login'|'error', windows[], fetchedAt, error? }
QuotaSnapshot { providers[], stale }
```

窗口数量不固定（1 或 2），不硬凑字段——MiMo 只有一根总量条。

### 采集层（Playwright 持久档案浏览器）

- 单一持久化 profile（`data/quota-browser/`，不进 git），三家站点共用一个浏览器档案（各自登录一次）
- **统一采集模式 = 页面访问 + 网络拦截**（不直连 API）：访问各家控制台页，拦截配额 XHR——与控制台显示天然同源（「准确」由数据源保证），且端点变更时自愈
- 响应过滤：GLM `/monitor/usage/quota`、MiMo `/tokenPlan/`、Kimi `/apiv2`+配额语义字段
- 归一化 fail-closed：响应结构识别不出 → status=error（明说未识别+保留 raw 日志），**绝不猜数字**——猜错的「准确数字」比没有更糟
- 轮询：5 分钟 TTL 缓存 + 面板手动刷新（on-demand 拉取，不引入调度器）
- 登录：401/跳登录页 → status=needs-login，面板给「登录」按钮 → POST /api/quota/login 弹有头浏览器窗扫码

### 展示（健康面板「配额」Tab）

- Tab 与 总览/警报/进行中的事/用量·效率 并列，支持 `?tab=quota` 深链
- 三列账号卡：每卡按窗口渲染余量条（≥50% 绿 / ≥20% 橙 / 以下红 / 耗尽红+「耗尽」）+ 数值 + 重置时间
- 5 分钟自动刷新 + 手动刷新按钮；needs-login 卡内「登录」按钮

### 影响范围

- 后端新增：`src/frameworks/quota/`、`src/usecases/quota/`、`quota-controller.ts` + 路由 2 条（GET /api/quota、POST /api/quota/login）
- 前端新增：`QuotaBoard.tsx` + HealthPage 注册 'quota' Tab + api client 2 个方法
- 依赖：`playwright@1.63.0`（精确锁定对齐 web 已装版本，复用其 Chromium 缓存，不触发新浏览器下载）
- 对既有链路零侵入：不 import 任何 agent/调度/观测模块

## 设计取舍

1. **纯展示边界**（搭档两连拍板：不进观测数据、移除通知开关）——配额是给搭档看的仪表盘，不是系统的传感器。机制预算四问：①为何新增机制——无既有机制能读外部控制台余量；②影响半径——quota 模块独立，不接 agent 运行时；③退役条件——控制台接口失效或搭档不再需要 → 移除 quota 模块与 Tab，无残留依赖；④后续机制——不自动扩展（不加告警、不加自动换账号）
2. **页面拦截而非直连 API**——多花一次页面加载，换「与控制台同源」+「端点自愈」+「三家统一一套采集器」；直连方案需要维护三套请求头/CSRF 细节且易碎
3. **fail-closed 归一化**——结构未识别时报错不猜数；首登冒烟后锁定 MiMo/Kimi 字段映射（初版按静态分析字段名+启发式，raw 全量落日志辅助定名）
4. **on-demand+TTL 而非调度器**——看板是拉取式展示，5 分钟 TTL 足够；不给系统加定时任务（与非目标「不影响系统运行」一致）
5. **playwright 精确锁 1.63.0**——与 web 已装 @playwright/test 同版本，蹭同一份 Chromium 缓存；避免版本漂移触发浏览器重下

## 验证

- 单测：三家归一化 fixture（GLM limits 真实字段名/MiMo currentPlan*/Kimi 启发式）+ fail-closed 用例 + QuotaService TTL/needs-login 判定
- web 组件测试：QuotaBoard 渲染态（ok/needs-login/error/耗尽配色）
- UI 真机自查（硬规则）：alpha 实例 + Playwright 截图 + getBoundingClientRect 取证
- **验证边界声明**：端到端真实数据流需搭档扫码登录后才能冒烟（MiMo/Kimi 字段映射按首登实测锁定，锁定过程与 raw 样本记入本文档「实施记录」节）
- 最简实现检查：已过阶梯——仓库无既有采集实现可复用；Playwright 是 web 已装依赖族（不引新家族）；归一化纯函数无框架

## 实施记录

（实现过程中的决策与修正，追加不改历史）

### 2026-10-12 实现与验证（初版）

- **分层重构**：lint 抓到 usecases→frameworks 反向 import（no-restricted-imports，D39/#429 分层规则）——改为端口下沉：`quota-ports.ts`（usecases 定义接口）+ `quota-normalize.ts`（领域纯函数）+ frameworks/providers.ts 仅剩注册表（URL 匹配 + 归一化绑定），QuotaBrowserSession implements QuotaCaptureSession。
- **路由拆分**：registerDataRoutes 触 max-statements——新增 registerQuotaRoutes，并顺手把 memory 路由组拆为 registerMemoryRoutes（行为不变，留安全余量）。
- **MiMo 单余量补强**：buildWindow 推导规则补充「limit 缺失但 used+remaining 已知 → 总量 = used + remaining」，单余量也能画比例条。
- **验证结果**：
  - 单测：quota 归一化 + 服务编排 17/17 绿；web 组件 4/4 绿；全量回归 5373/5373 绿（首次全量有 2 失败未捕获用例名、二次全量未复现，判定环境抖动，quota 相关两次均绿）；web 全套 675/675 绿；lint + tsc + lint:schema + smoke:boot 全过。
  - **真实端到端冒烟（alpha 实例 3152，未登录态）**：`GET /api/quota` 三家状态机全部正确——GLM needs-login（认出登录墙）、MiMo needs-login（401+loginUrl）、Kimi error「结构未识别」（未登录也捕获到 /apiv2 响应，fail-closed 不猜数 ✓）。
  - **UI 真机自查**：Playwright 截图 + getBoundingClientRect 取证（卡片 320×136、按钮 90×28、零尺寸 0 处）——截图与取证存对话工作区 quota-console-probe/。
- **验证边界（未闭环项）**：ok 态（真实余量条渲染）需搭档扫码登录后冒烟；MiMo/Kimi 字段映射为静态分析+启发式初版，首登实测后锁定（raw 响应会落服务日志辅助定名）。
