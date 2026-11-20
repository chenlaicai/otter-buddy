---
id: F20261120svctk
title: "外部来源真凭据通道：服务令牌（Bearer）补齐跨反代集成方"
summary: "上一轮把声明式身份头（X-Otter-User-* / ?otterRole=）收口到本机直连，堵住了伪造面，但没给「跳反代或走公网域名」的集成方留路——对端恒回环 + 带转发头 = 被判外部来源，声明式头一律 401，CoLink 通道随之断掉。补一条真凭据通道：配置 auth.serviceToken（env OTTER_SERVICE_TOKEN 优先），请求带 Authorization: Bearer 命中即授予服务身份，与来源无关；常数时间比较、<16 字符启动期 fail-fast、未配置则通道不存在。身份解析顺序为 会话 cookie → 服务令牌 → 声明式头（仍限本机直连）。colink-agent-app 有令牌即改发 Bearer，无令牌退回声明式头。"
change_type: fix
capability_test: "n/a: 纯鉴权面补齐（新增一条真凭据通道），非 LLM 行为采样面——由 tests/interface-adapters/http/service-token.test.ts（优先级/fail-fast/校验器）、tests/interface-adapters/http/identity-middleware.test.ts（服务令牌通道 5 例：跳反代形态可用、外部来源可用、错误令牌 401、未注入即通道不存在、会话优先）、tests/frameworks/config-service.test.ts（类型与长度校验、加载）与 extensions/colink-agent-app/test/otter-bridge.test.mjs（Bearer/声明式/空白令牌三态）覆盖"
intent:
  problem: "入口收口把声明式身份头限定为「本机直连」是对的（那是可伪造的接缝），但同机的通道适配进程 colink-agent-app 未必需走回环：它的中枢地址是可配置的 OTTER_BASE_URL，一旦指向公网域名或经 nginx，请求就带转发头、被判成外部来源，声明式头一律 401，外部 IM 通道整体断掉。此时缺的不是「放松闸门」，而是给这类集成方一个不可伪造的凭据——声明式头的失败是设计使然，不能靠撤回闸门解决。"
  solution: "①配置面新增 auth.serviceToken（env OTTER_SERVICE_TOKEN 优先于配置文件，与登录口令同一优先级口径）；②身份解析新增第二通道：Authorization: Bearer <token> 命中即返回固定服务身份（service-token/admin），与来源地址无关；③比较走常数时间、长度差先短路；令牌短于 16 字符启动期报错（唯一凭据可猜中等于没有）；未配置 = 通道不存在（Bearer 被忽略，落回声明式/来源闸判定）；④colink-agent-app 存在 OTTER_SERVICE_TOKEN 时改用 Bearer、不再发声明式头，否则退回原样；⑤配置样例与部署说明写清「走公网域名必须两侧同值配令牌」。"
  expected_effect: "CoLink 通道无论 OTTER_BASE_URL 指向回环还是公网域名都能通：后者靠令牌，前者两条通道任一条皆可。外部来源的伪造面不因这次改动松开——声明式头仍然只对本机直连生效，令牌即使泄露也与其他口令同级（可换值、可撤销）。运维脚本（本机回环）行为不变。"
  verify_by:
    type: static_only
created_in_conversation: 0401284f-dff7-4927-af60-3516a984529d
tags: [security, auth, http, identity, integration, deploy]
modules:
  - interface-adapters
  - config
  - extensions
causal_links:
  - {type: "complements", id: "F20261119entrc", note: "上一轮把声明式通道收到本机直连，这一轮给它之外的集成方补真凭据——同一收口的两面"}
---

# 外部来源真凭据通道（F20261120svctk）

## 背景

入口收口（F20261119entrc）把「可伪造的声明式身份头」从公网可达面上去掉了：只有
「对端回环 且 无转发头」才认 `X-Otter-User-*` / `?otterRole=`，其余来源只认 owner 会话 cookie。

方向对，但漏了消费方：**同机的通道适配进程 `colink-agent-app`**。它与中枢同机，
可中枢地址是配置项（`OTTER_BASE_URL`）。指向公网域名或经 nginx 时，请求带转发头 →
被判外部来源 → 它发的声明式头一律 401 → 外部 IM 通道整体断掉。

这里要看清一件事：**这不是闸门设错了，而是那条通道对这类调用方本来就不该用**。
声明式头是接缝不是凭据，它能被收口，就说明它本来就不能跨来源用。所以补法不是撤回闸门，
而是给集成方一个**真凭据**。

## 改动清单

| # | 改动 | 锚点 |
| --- | --- | --- |
| 1 | 配置新增 `auth.serviceToken`，env `OTTER_SERVICE_TOKEN` 优先；类型/长度校验（<16 字符 fail-fast） | `src/frameworks/config-service.ts`、`config/config.yaml.example` |
| 2 | 令牌解析与校验器（常数时间、长度差先短路、固定服务身份） | `src/interface-adapters/http/auth/service-token.ts` |
| 3 | 身份解析新增令牌通道：`Authorization: Bearer` → 服务身份；顺序 会话 cookie → 服务令牌 → 声明式（仍限本机直连） | `src/interface-adapters/http/identity-middleware.ts`、`src/interface-adapters/http/router.ts` |
| 4 | 装配：从配置/环境解析令牌并注入校验器 | `src/app.ts` |
| 5 | 通道适配：有令牌发 Bearer、无令牌退回声明式头（含附件 multipart 上传路径统一走同一处身份头） | `extensions/colink-agent-app/src/otter-bridge.mjs`、`src/app.mjs` |
| 6 | 文档与样例：部署说明（两侧同值）、扩展 README 与 `.env.example` | `deploy/ecs/README.md`、`extensions/colink-agent-app/README.md`、`extensions/colink-agent-app/.env.example` |
| 7 | 常数时间比对抽成共用件，登录口令与服务令牌共用（两处各写一份迟早分叉） | `src/interface-adapters/http/auth/owner-password.ts`（`constantTimeStringEquals`） |

## 关键取舍

1. **令牌通道不看来源地址，也不该看**。它防的是「猜到并伪造」，而令牌就是秘密本身；地址判据在这里没有增益，反而会把「同机但绕反代」的合法调用方误杀——这正是这次要修的那个 bug。
2. **不加新角色，令牌授予固定服务身份**。单用户部署里「系统自己」就是 owner 档，再造一套权限体系没有消费方。
3. **不配置就没有这条通道**（Bearer 被忽略，落回原判定）。缺省闭合优于缺省开启：一个没被任何调用方使用的凭据通道，开着只会多一个被猜的面。
4. **env 优先于配置文件**，与登录口令同一口径（部署面覆盖仓内默认）；两侧文档都写清「中枢与 App 必须同值」，因为这一条漏了只表现为稳定 401，现场很难联想到。
5. **不把令牌塞进 URL 或自定义头**，用标准 `Authorization: Bearer`：反代、日志与抓包工具对它的处置都是既有惯例，不需要额外解释；也避免自定义头被反代清空（nginx 站点明确清了 `X-Otter-User-*`）。
6. **`<16` 直接启动期报错而不是告警**。告警会被忽略，而短令牌等于没有凭据——这是「配了但没防住」的最坏形态，与入口默认值那条同一判断。

## 附带修复：一条定时任务用例的时钟依赖

本特性与定时任务无关，但它撞上了同一条硬约束——**CI 红着就没法证明这次改动是绿的**。
`tests/usecases/scheduler/scheduler-service.test.ts` 里「同槽即时重试」这条真库集成用例把
「3h 前」与「5min 前」两行写在真实此刻上，而它断言的两件事都算在「此刻」：两行是否落在同一
cron 槽（每日窗口——槽起点后三小时内这两行必然跨槽），以及新行是否超滞留阈值（2h）。
于是每天有约三小时它必红，且与任何改动无关（现网 main 在同一时段同样红）。

改法只动这条用例的时钟锚：此刻固定成确定值，两行仍由「此刻前 3h / 前 5min」派生，断言语义
一条没动（stuck 翻篇 `failed`、新行未超阈仍 `running`、真库判定 `covered` 不入列、healing 记
`covered`）。改后结果与跑测试的钟点无关。

为什么不单独开一条 PR：它只影响「能否拿到可判绿的 CI 证据」，本身不改变系统行为；单独走一轮
检视与授权，代价大于收益。这一点在 PR 正文里单独声明，接受检视方按独立关注点审视。

## 部署侧（本 PR 只准备配置与清单，**未上线**）

1. `/etc/otter-buddy.env` 增加 `OTTER_SERVICE_TOKEN=<openssl rand -base64 32>`（或写进 `config.yaml` 的 `auth.serviceToken`）。
2. `/etc/colink-agent-app.env` 增加 **同一个值** 的 `OTTER_SERVICE_TOKEN`。
3. 重启两个 unit；`OTTER_BASE_URL` 保持现状（回环或公网域名皆可）。
4. 验证：CoLink 侧发一条 DM → 中枢侧能看到外部对话与回复；`journalctl -u colink-agent-app` 无 `OTTER_HTTP_401`。
5. 回滚：删掉两侧 `OTTER_SERVICE_TOKEN` 并把 `OTTER_BASE_URL` 指回 `http://127.0.0.1:3000`（回到声明式通道）。

## 验收

| 项 | 判据 |
| --- | --- |
| 令牌通道（跳反代形态：回环对端 + 转发头） | 200，身份为服务身份（真凭据不受来源闸限制） |
| 令牌通道（外部来源） | 200（令牌是秘密，不依赖地址） |
| 令牌错误 / 缺失 / 非 Bearer | 401，且声明式回退拿不到档位 |
| 未配置令牌 | Bearer 被忽略，按声明式 + 来源闸原样判定（通道不存在） |
| 声明式通道 | 仍只对本机直连生效（上一轮的回归全绿） |
| CoLink 适配 | 有令牌发 Bearer、无令牌发声明式头；空白令牌视同未配置 |
