---
id: F20261119entrc
title: "中枢入口收口：监听地址回环缺省 + 声明式身份通道按来源闸 + 业务读面升档"
summary: "把「中枢 HTTP 入口」从默认敞开改成默认关闭：服务监听地址配置化且缺省 127.0.0.1（原先 serve({port}) 绑全部接口）、声明式身份头/query 通道只对本机直连开放（外部来源只认 owner 会话 cookie，判据为「回环对端 + 无转发头」）、业务正文读面（对话清单/时间线/invoke 流水/记忆库）从兜底 authenticated 显式升到 write。反代侧同步清空客户端自带的身份头做纵深。"
change_type: fix
capability_test: "n/a: 纯鉴权与监听面收口，非 LLM 行为采样面——由 tests/interface-adapters/http/identity-middleware.test.ts（策略矩阵 + 来源闸 5 例）、tests/interface-adapters/http/loopback.test.ts、tests/bootstrap/server-listen-host.test.ts、tests/frameworks/config-service.test.ts（host 缺省/校验）覆盖"
intent:
  problem: "三处默认值同时站错边：①HTTP 服务用 serve({ port }) 不指定 host，等于监听全部网卡（*:3000）；②身份头/query 是声明式接缝而非凭据，任何能连到端口的人带一个 X-Otter-User-Role: admin 就是管理员，而现网是 nginx(443) → 127.0.0.1:3000，经反代进来的请求在 node 侧对端恒为回环，光看对端地址挡不住；③对话清单/时间线/invoke 流水/记忆库这些业务正文读口只落在兜底 authenticated 档，guest 也能读——单用户部署里没有任何合法的 guest 消费方。"
  solution: "①server.host 配置化，缺省 127.0.0.1，显式写非回环地址时启动告警；②声明式通道的来源闸 = 对端回环 且 无 X-Forwarded-For/X-Real-IP/Forwarded/X-Forwarded-Host，任一转发头在场即视为外部来源，此时只认 owner 会话 cookie，否则 401；③策略表为 conversations / invokes / entries / memory 补显式读档规则（方法维度限 GET/HEAD，不遮蔽同族写与 admin 规则），记忆的 POST 语义检索同档；④nginx 站点配置在反代处清空 X-Otter-User-Id/-Role。"
  expected_effect: "外部 IP 无法在 3000 端口上拿到任何身份：直连端口要么连不上（服务只绑回环），要么即使绑了全接口也因来源闸拿不到声明式身份（401）；反代入口清空身份头后再叠加转发头判据，伪造头不生效；guest 档不能再读对话与记忆正文。本机运维脚本与同机反代出来的 web UI 行为不变。"
  verify_by:
    type: static_only
created_in_conversation: 0401284f-dff7-4927-af60-3516a984529d
tags: [security, auth, http, identity, exposure, deploy]
modules:
  - interface-adapters
  - bootstrap
  - config
causal_links:
  - {type: "complements", id: "F20261119extsg", note: "同一轮安全加固的另一面：那条收外部对话的运行时权限边界，这条收中枢入口本身"}
  - {type: "complements", id: "F20261019autz", note: "建了声明式身份接缝与策略表，本特性给这条接缝加来源闸并把业务读面显式收档"}
---

# 中枢入口收口（F20261119entrc）

## 背景与判定

外部对话隔离（F20261119extsg）解决的是「外部用户进了海獭之后能做什么」；
这一条解决更前面的一步：**谁能进中枢**。复核代码与现网拓扑后，结论是入口默认值三处站错边：

| 面 | 现状 | 后果 |
| --- | --- | --- |
| 监听地址 | `serve({ fetch, port })` 不传 host → 绑全部接口 | 3000 端口直接对网卡敞开，绕过 nginx 与 TLS |
| 身份来源 | 无会话 cookie 时采信 `X-Otter-User-Id` / `X-Otter-User-Role` / `?otterUserId=&otterRole=` | 任意能连到端口的人自带 `admin` 声明即管理员；经反代时对端恒为回环，只判对端地址无效 |
| 业务读面 | 对话清单/时间线/invoke 流水/记忆库落在兜底 `authenticated` | guest 档即可读全部对话与记忆正文 |

现网拓扑（`deploy/ecs/README.md`、`deploy/ecs/nginx-otter.conf`）是 nginx(443) → `127.0.0.1:3000`，
所以「只判对端回环」这条设计假设在 ECS 上等于没设防——这是本特性相对设计稿加严的一处。

## 改动清单

| # | 改动 | 锚点 |
| --- | --- | --- |
| 1 | `server.host` 配置化，缺省 `127.0.0.1`；非字符串/带协议/空白 fail-fast；绑非回环地址启动告警 | `src/frameworks/config-service.ts`、`src/bootstrap/server.ts`、`src/main.ts` |
| 2 | 回环判定抽成共用件（`localhost`/`127.0.0.0-8`/`::1`/`::ffff:127.x`/`[::1]`） | `src/interface-adapters/http/loopback.ts` |
| 3 | 声明式通道来源闸：对端回环 + 无转发头才放行；外部来源只认 owner 会话 cookie | `src/interface-adapters/http/identity-middleware.ts`（`allowsDeclaredIdentity` / `parseIdentity`） |
| 4 | 读面显式收档：`/api/conversations*`、`/api/invokes*`、`/api/entries*`、`/api/memory*`、`/api/otters*`（含 session 历史）、`/api/scheduled-tasks*`（任务 body 与执行记录）、`/api/connections*`（对话清单别名）、`/api/skills`、`/api/prompts`、`/api/activity*`、`/api/health*`、`/api/weixin|feishu|channels|execution-machines` 的 GET/HEAD → `write`；`POST /api/memory/search/similar` → `write`；`/api/attachments`、`/api/auth/session`、`/api/unfurl` 显式行写明为何保持 `authenticated` | 同文件策略表 |
| 5 | 反代纵深：nginx 站点在 `location /` 清空 `X-Otter-User-Id` / `X-Otter-User-Role` | `deploy/ecs/nginx-otter.conf` |
| 6 | 配置样例补 `server.host` 注释 | `config/config.yaml.example` |
| 7 | 探查地址改定 `127.0.0.1`：运维脚本的健康检查不再用 `localhost`（缺省只绑 IPv4 回环后，`localhost` 解析到 `::1` 会先撞一次连接失败） | `scripts/alpha.sh`、`scripts/otter-buddy.sh` |

## 关键取舍

1. **不引入新凭据体系，只收缩声明式通道的可用面**。会话 cookie（HMAC 签名、secret = owner 口令）已经是不可伪造的真凭据，入口问题不需要再造一套 token；本改动只是把「可伪造的通道」从公网可达面上去掉，本机脚本照旧。
2. **判据取「回环 且 无转发头」，不取「信任 X-Forwarded-For 的解析结果」**。后者的前提是反代是可信的且整链都写了头，而我们要防的正是「反代后面忘了改」这种部署漂移。客户端伪造转发头只会让自己掉出声明式通道，方向安全。
3. **读面用方法维度限定（GET/HEAD），不做族级通配**。族级规则会遮蔽同族的 admin 规则（建会话、会话级定时任务、MCP 配置注入），首条命中的顺序依赖太脆。
4. **`server.host` 缺省回环而不是缺省全接口**。自部署单用户系统里「能被外部连上」应当是显式选择；容器/反代场景显式写 `0.0.0.0` 即可，且会留下一条告警。
5. **未改 `/api/attachments/*` 读档**。附件直链仍走 `authenticated`（表内已显式列行并写理由）：它在浏览器里以 `<img src>` / `<audio src>` 形态消费，身份来自同源会话 cookie；升到 `write` 不增加安全性（能过 cookie 的都是 owner），却会让任何未登录预览场景直接 403，收益为负。同理显式保留 `/api/auth/session`（未登录时也要能回答「你是谁」）与 `/api/unfurl`（只取外部 URL 元信息）。
6. **转发头按「在场」判而不是按「非空」判**。空值转发头（`X-Forwarded-For:` 不带值）同样是反代留下的痕迹；按值判等于给伪造者留一个「发空头」的绕过口。回归用例把四种转发头的空值形态逐一双测。
7. **读面规则族按「业务正文/私有数据面」归类，不按「看起来敏感」猜**。判断口径：这条 GET 返回的东西是否含对话正文、记忆正文、提示词/能力库全文、任务指令、账号凭据元数据——是则 `write`，否则显式保留并写理由。漏口比误伤更贵：误伤会在真机验证时立刻暴露，漏口不会。

## 部署侧（本 PR 只准备配置与清单，**未上线**）

合入后需要一次部署才生效，部署前逐项核对：

1. `/etc/otter-buddy/config.yaml` 不写 `server.host`（缺省即 `127.0.0.1`）；若显式写了别的值，确认是有意的。
2. `deploy/ecs/nginx-otter.conf` 整文件重装（含新增的两行 `proxy_set_header ... ""`）→ `sudo nginx -t && sudo systemctl reload nginx`。
3. 安全组入站只留 80/443/22；3000 不出现在任何安全组规则里。
4. `ss -ltnp | grep 3000` → 应为 `127.0.0.1:3000`（而非 `*:3000` / `0.0.0.0:3000`）。
5. 探活与真机验证：`curl https://<site>/api/ping` 绿、浏览器登录态可用、CoLink 通道（同机 `colink-agent-app`，走 `127.0.0.1`）照旧能收发。
6. 回滚：配置里加回 `host: 0.0.0.0`（不推荐）或整体回退上一版代码。

## 验收

| 项 | 判据 |
| --- | --- |
| 外部 IP 直打 3000（假 admin 头） | 服务只绑回环时连接根本不通；显式绑全接口时为 401，不是 200 |
| 回环脚本同请求 | 200（声明式通道保留） |
| 反代请求带假身份头 | 401（nginx 清空 + 转发头判据双保险） |
| `ss -ltnp` | `127.0.0.1:3000` |
| ECS 探活 | `/api/ping` 照旧绿（public 面不受来源闸影响） |

## 检视处置（独立检视獭第一轮）

| 级别 | 发现 | 处置 |
| --- | --- | --- |
| P1 | 空值转发头绕过来源闸（按值判 `nonEmpty` ⇒ `X-Forwarded-For:` 空串视同不在场） | 改为按**在场**判；四种转发头空值形态补回归 |
| P1 | 业务正文读口别名漏网：`/api/connections/:id/conversations`（对话清单别名）、`/api/scheduled-tasks/:id(/executions)`（任务 body 全文）、`/api/otters/:id/sessions`（交接 summary） | 全部并入显式读档规则 |
| P2 | 能力库/提示词库全文（`/api/skills`、`/api/prompts`）仍 guest 可读 | 升 `write` |
| P2 | 一处恒真断言（只断言导出是函数） | 改为 `allowsDeclaredIdentity` 直测：无对端地址放行 / 非回环拒 / 空值转发头拒 |

一并审查后主动补足：`/api/activity*`、`/api/health*`、`/api/weixin|feishu|channels|execution-machines` 同为内部运营与凭据元数据面，一并收档。
