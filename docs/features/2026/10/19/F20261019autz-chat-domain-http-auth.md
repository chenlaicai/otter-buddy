---
id: F20261019autz
title: 对话域 HTTP 鉴权层（X-Otter 身份头 + 路由策略表）
numbering_note: 编号顺延（2026-10-19 搭档指示）——文档 10/16 建档为 F20261016autz，落地跨日于 10/19 顺延为 F20261019autz；分支历史 commit tag 仍为旧编号（历史事实不重写，双向可搜）
summary: 修 issue #1322：对话域 HTTP 端点系统性无鉴权（UUID 不可猜 ≠ 鉴权）。新增身份中间件（X-Otter-User-Id/X-Otter-User-Role，直链场景退化为 query 参数）+ 路由级策略表（public/authenticated/write/admin 四档），`/api/*` 默认 fail-closed；web 前端、运维脚本、e2e 接入身份声明；麻将面按 issue 评论「新增面」列入策略表暂置 public 待并行分支收紧。
change_type: fix
capability_test: "n/a: HTTP 中间件机械门禁，无 LLM 行为面；覆盖由新增 tests/interface-adapters/http/identity-middleware.test.ts（401/403/public/直链/兜底矩阵）+ 既有 tests/api 全量用例（注入身份后不回归）执行"
created_in_conversation: a00f8fec-1ec0-4c63-9b1d-27b5756b2fc8
tags: [security, http, auth]
modules: [http, web]
intent:
  problem: "对话域 HTTP 端点（对话/消息/记忆/附件/设置/定时任务等）无任何身份校验——任何能连到服务的客户端拿到 UUID 或裸 URL 即可读写数据（issue #1322，2026-10-06 PR #1320 检视发现定性挂账；2026-10-16 PR #1529 检视发现 4 将 /api/mahjong/* 九端点并入同根因）。UUID 不可猜 ≠ 鉴权。"
  expected_effect: "无身份声明的 /api/* 请求一律 401（未知路径也不再 404 透出，fail-closed）；角色不足的写/管理操作 403；web 前端、运维健康探针脚本、e2e 接入身份头后行为与改造前一致；新端点即使忘配策略表也默认落入鉴权。"
  verify_by:
    type: behavior_check
causal_links:
  - "issue #1322（对话域控制器系统性无鉴权——本实现的源头 issue）"
  - "issue #1322 评论「新增面」2026-10-16（PR #1529 检视发现 4：/api/mahjong/* 九端点同根因并入）"
  - "F20261006mlp2（10/6 首次定性：UUID 不可猜 ≠ 鉴权，横切安全债）"
---

# 对话域 HTTP 鉴权层（#1322）

> 编号顺延：原建档编号 F20261016autz（2026-10-16），落地跨日于 2026-10-19 顺延为 F20261019autz；分支历史 commit tag 仍为 F20261016autz（历史事实不重写，新旧编号双向可搜）。

## 背景与方向来源

- issue #1322（2026-10-06 挂账）：对话域 HTTP 控制器普遍无身份/会话校验，controller 直接
  `param(c,'id')` 用、无 otter 身份核验；修复方向「对话域端点加会话/身份核验」，属横切工程单独排期。
- 修复方向锚点：大獭 issue 认领评论（2026-10-16T08:42Z）——「对话域 HTTP 鉴权层落地
  （X-Otter-User-Id/X-Otter-User-Role 中间件 + 路由级策略表）」。派工简报同口径。
  （注：交接摘要提到的正文「唯一活路」段在 issue #1322 当前正文中不存在，实际正文为
  根因/影响/修复方向三段——以认领评论 + 派工简报口径为准，已向大獭回报此差异。）
- issue #1322 评论「新增面」（麻将方案检视獭，2026-10-16）：PR #1529 新增的 9 个
  `/api/mahjong/*` 端点与对话域同构裸奔（含 `view?seat=` 即权限），并入本 issue 同根因。

### 目标

- T1 身份中间件：`X-Otter-User-Id`（必填身份）+ `X-Otter-User-Role`（admin/user/guest）声明式头；
  无法设请求头的直链场景（附件 `<img>/<audio>/<a href>`）退化为 `?otterUserId=&otterRole=` query 参数。
- T2 路由级策略表：`public / authenticated / write / admin` 四档 + **`/api/*` 方法级 fail-closed 兜底**
  （GET→authenticated、非 GET→write），新端点忘配策略也落入鉴权。
- T3 全客户端接入：web 前端（client.ts/request + 直连 fetch + XHR SSE + 附件直链 URL）、
  运维/健康探针脚本（curl/fetch 带头）、Playwright e2e 直连调用——行为不回归。
- T4 测试面：既有全量 API 用例注入身份后不回归；新增鉴权矩阵用例（401/403/公开面/直链/兜底）。

### 非目标（边界）

- 不做前端登录/注册 UI、不做真实 session 体系、不做 HTTPS/网络层绑定、不做 memory 目录访问控制
  （issue 明确无关）——身份头是**声明**不是凭据，凭据绑定留给后续 session 工程（见取舍③）。
- 不实际收紧 `/api/mahjong/*`（另一獭在 fix/mahjong-chat-echo 并行开发，不碰 web-mahjong/ 与
  src/entities/mahjong/）：策略表**列入**这些路径但暂置 `public`，留翻转锚点与 issue 评论 L2 选型指针。
- 不修 `/api/inbound/*` 平台回调的验签缺口（平台无法携带我方身份头，其校验责任属既有 inbound 面，
  本次显式列 public 保留现状并留档）。

## 机制识别检查点判定（前置，写第一行实现代码前完成）

| 清单项 | 命中 | 说明 |
|---|---|---|
| 新增配置字段/枚举/开关 | 否 | 无新增配置/env 开关；admin/user/guest 是 API 契约角色枚举，非配置面 |
| 新增状态生命周期 | 否 | 身份解析为请求级临时值，不创建/销毁跨请求状态 |
| 新增定时任务/后台进程 | 否 | — |
| 新增信号类型/消息格式 | 部分 | 新增 401/403 错误响应形态（`{error, code}` 与既有错误同构，仅 code 取值新增） |
| 新增持久化存储 | 否 | 零 DB 变更（无迁移文件） |
| 新增决策分支（结果被记住并影响后续行为） | 否 | 每请求独立裁决，纯运行时临时分支不算 |
| 新增跨模块调用路径 | **是** | web 前端/运维脚本/e2e → HTTP 中间件的新身份契约；中间件 `c.set('identity')` 供下游控制器消费的接缝 |

命中「跨模块调用路径」（+ 信号格式部分命中）→ 按修法决策树走 **④ 新增机制**，四问如下。
跳过 ①②③ 的理由：① 既有机制内修——仓内**不存在**任何身份校验机制可「缺啥补啥」
（grep 全仓无 X-Otter/Authorization 校验面，issue 所引 project-api 鉴权面不在本仓）；
② 收窄管辖边界——问题本身就是管辖缺失（全对话域裸奔），无既有边界可收窄；
③ 删除机制——无可删机制，删除不解决越权。

## 机制预算四问（修法决策树④，作者当场作答）

1. **谁需要它，没有会怎样？** 搭档（部署侧安全边界）+ issue #1322 提出视角：服务一旦对外暴露
   （端口转发/内网共享），任何拿到 URL 或 UUID 的第三方可零凭据读对话、读附件、读 settings
   （含 dbPath/模型配置）、注入麻将动作。没有它 = 本 issue 描述的系统性裸奔面持续存在且随新端点扩散
   （三麻将局端点即为活例：新端点无人记得加校验，fail-closed 兜底正是针对该扩散模式）。
2. **失败时用户受什么影响？什么信号能发现失败？** 两类失败方向相反：
   - 防线失效（中间件被绕过/未挂载）→ 退回现状裸奔，无用户可见信号（这正是本债隐蔽十天的原因）
     ——靠新增鉴权矩阵测试 + fail-closed 默认兜住「忘挂载」形态；
   - 防线过严（误杀合法请求）→ web UI 大面积 401/403、健康探针失败服务起不来——**立即可见**，
     既有 tests/api 全量用例（167 处请求）+ smoke:boot + e2e 三层回归网可发现。
3. **加法带来的未来问题类（四条）：**
   - 声明式身份头可被伪造——安全声明只到「防误访/防 CSRF 简单请求」，不到「防蓄意伪造」；
     未来接真实 session/凭据时以校验替换值源，本层是接缝不是终态；
   - 新端点默认落入 fail-closed——忘配策略表 → 401（设计意图），但新端点作者必须知道身份契约
     （前端接入点集中在 web/src/api/identity.ts 一处，契约有单一真相源）；
   - 直链身份走 query 参数 → 出现在 URL/访问日志（等价于头的可伪造强度，但需留档）；
   - `/api/mahjong/*` 暂置 public 是**已知保护缺口**——收紧时需与 web-mahjong 前端同步改造，
     否则牌局页 401（翻转锚点已写死在策略表注释 + issue 评论）。
4. **何时退役/被什么取代？** ① 搭档确认部署形态恒为单机 localhost 且认为策略表维护成本高于收益
   → 删中间件回裸路由（安全声明同步收回）；② 真实 session/凭据体系落地 → 本「声明式身份头」被
   凭据校验取代（同位置替换，策略表保留）；③ 被取代信号：identity.ts 值源从常量改为 session 派生。

**重对抗门提示（交大獭编排）**：机制类改动需在对抗审视轮追加重对抗门三问
（治本/治标/信息不足判定）——小獭无召唤权，已在 PR 描述与交棒说明中提请大獭将三问并入检视獭审查范围
（requirement-analysis §61-70 允许与步骤 7 对抗审视合并为同一轮）。

## 设计取舍

| 方案 | 判定 | 理由 |
|---|---|---|
| **中间件 + 路由策略表**（选定） | ✅ | 一处挂载覆盖全部既有与新增路由（fail-closed）；策略表即安全态势文档；controller 零改动 |
| 每 controller 手写身份校验 | ❌ | 25 个 controller × 每方法重复；新端点漏写 = 回到 #1322 原状（三麻九端点就是这么裸的） |
| 引入 JWT/会话框架中间件 | ❌ | 超出方向（不做真实 session 体系）；无签发方的库是空架子，且引入依赖 |
| 仅绑定 localhost/内网（issue 评论选项①） | ❌ | 部署侧责任，与身份层正交；issue 评论 L2 选型未拍板此项，不代拍 |
| 房令牌（选项②） | 留给麻将面 | 麻将并行开发 + L2 选型未拍板，本次只列策略表占位 |
| 统一 web 面鉴权收口（选项③ = 本实现） | ✅ | issue 认领评论已定方向 |
| 声明式身份头（选定） vs 凭据校验 | ✅ | 派工方向即头方案；凭据属 session 工程（非目标），头是其前置接缝 |
| 附件直链身份走 query 参数 | ✅ | `<img>/<audio>/<a href>` 无法设请求头；备选 fetch→blob 会毁掉直链/缓存/右键另存 |
| 麻将路径列策略表暂置 public | ✅ | 派工边界：只保证可挂载；并行分支不能碰，强启会打断牌局页 |
| 默认 fail-closed（GET→authenticated、非 GET→write） | ✅ | 直击「新端点忘配」扩散根因；public/writable 全靠显式声明 |

### 最简实现检查（PR 必答）

本实现 = 1 个中间件文件（策略表 + 解析 + 裁决 ≈ 百行级）+ router 一行挂载，无新依赖、无新配置、
无 DB。备选「每 controller 手写」在覆盖面与漏写风险两维都更差；备选「框架鉴权库」需要不存在的签发方。
当前形态无更简的既有机制可用（仓内零鉴权先例，已 grep 证实）。

### 负向验收（破坏了什么）

- 旧契约破裂：**裸 URL 即可访问 /api** 不再成立——一切客户端必须声明身份（[Incompatible] 标注缘由）。
  受影响方已同步接入：web 前端、3 个健康探针脚本、2 处 e2e 直连、settings 读取脚本。
- 未知 `/api/*` 路径行为从 404 变 401（无身份时）——先认证后 404，信息面反而收紧。
- 未绕过任何既有保护（本次是加保护，非减）；已知保留缺口：inbound 无验签、麻将面暂 public（均留档）。

## 方案设计

### 服务端

- 新增 `src/interface-adapters/http/identity-middleware.ts`：
  - 身份解析：头 `X-Otter-User-Id`/`X-Otter-User-Role`，或 query `otterUserId`/`otterRole`（直链退路）；
    id 校验 `/^[\w.:@-]{1,128}$/`（不合规则视同缺失→401）；role 非法/缺失降级 `guest`；
    **通道整体性**：任一身份头在场 ⇒ 整体走头通道、query 不参与（防 URL 参数越权上抬角色——
    query 会进访问日志/Referrer，不得与头混通道）；两通道皆无才走 query 直链退路；
    合法身份 `c.set('identity', {userId, role})` 供下游（控制器暂未消费，接缝已就位）。
  - 策略表 `POLICY_TABLE`（有序首条命中，method + RegExp/path）：
    - `public`：`/api/inbound/*`（平台回调无法带我方头，验签责任在 inbound 面）、
      `/api/mahjong/*`（**暂置**，注释指向 issue #1322 新增面评论 + 翻转条件）；
    - `admin`：**settings 全方法（含 GET 读面——dbPath/模型路径属基础设施信息，收紧优先，
      消费方 web/探针均 admin 档，见 #1541 首轮检视处置 1，不留隐式）**、otters 建/散/重启
      （retry 豁免为 write）、scheduled-tasks 全写
      （含 trigger）、connections 建/删（enter/leave 豁免为 write）、health 扫描/处置、
      weixin/feishu 凭据面写；
    - `write`（显式仅列族内例外，其余靠方法级兜底）：`otters/:id/retry`、`connections/:id/enter|leave`
      （必须先于同族 admin 规则命中）；`memory/search/similar` 为读语义显式升 `authenticated`。
      其余对话域写口（建会话、messages/read、archive/pin、attachments 上传、resources、
      workspace reveal、memory flag、invokes abort/retry）由**兜底**（非 GET→write）覆盖——
      新写口默认已受保护，不逐条列写；
    - 其余 `/api/*` → 方法级兜底：GET/HEAD/OPTIONS→`authenticated`、其余→`write`（fail-closed）；
    - 非 `/api/*`（静态/SPA/metrics）→ 直通。
  - 拒绝形态与既有错误同构：`401 {error, code:"unauthorized"}`、`403 {error, code:"forbidden"}`。
- 挂载：`router.ts` 在 requestId 中间件之后 `app.use('*', identityMiddleware)`（一处覆盖全部路由，
  请求完成日志补 `userId` 字段可观测）。

### 客户端接入

- `web/src/api/identity.ts`（新）：常量 `web-ui`/`admin`（单用户自部署：唯一人类=搭档=admin）+
  `identityHeaders()` + `withIdentity(url)`（直链 query 追加）。session 工程落地时只换值源。
- `web/src/api/client.ts`：request() 重构为「init.headers 整体替换语义保留 + 恒并入身份头」
  （保住 multipart 不设 Content-Type 的既有语义）；sendMessage/retryInvoke/retryOtter 直连 fetch 补头。
- 直连点补头：skills 页 ×2、WorkspacePanel ×3、UnfurlCard ×1；conversation/index.tsx XHR SSE
  `setRequestHeader` ×2；附件直链（MessageList ×5、MessageInput ×1）改 `withIdentity()`。
- 脚本：alpha.sh/e2e-server.sh/otter-buddy.sh 健康探针 curl 加 `-H` 身份头；
  migrate-sanxing-wushen.mjs fetch 加 headers；generate-guard-replay.mjs 提示文案补带头示例。
- e2e：floating-assistant 两个 spec 的 Playwright 直连请求补 headers。

### 测试

- 新增 `tests/helpers/with-identity.ts`：把带默认身份（admin）的头包在 Hono app 外层
  （`outer.route('/', inner)`），测试业务语义不被身份噪声污染。
- 注入点：tests/api/helpers.ts createTestApp、tests/bootstrap ×2、tests/app/build-app.test.ts、
  tests/capability/helpers/boot.ts——均只包一层，断言与调用点零改动。
- 新增 `tests/interface-adapters/http/identity-middleware.test.ts` 鉴权矩阵（20 例）：
  无头 401 / 合法头 200 / 非法 id 401 / guest 写 403 / user 管理 403 / admin 200 / 非法 role 降 guest /
  直链 query 通 / 通道整体性（头在场时 query 角色不越权上抬）/ inbound public / 麻将 public（404≠401 证明未拦）/
  未知 /api 路径 fail-closed（无头 401、带头 404）/ 非 /api 直通 / 身份注入下游可见 / resolvePolicy 纯矩阵。
  含检视处置 1 新增钉子：`GET /api/settings` 读面显式 admin 档（guest/user 403、admin 200）。
- web 附件断言用「前缀定位 + getAttribute 全值比对」——jsdom/nwsapi 对值含 `?` 的 `=` 属性选择器有
  解析缺陷（本分支实测：`src="…?x=1"` 精确匹配恒 false，`^=`/`*=` 正常），字符串比对不受影响且断言强度不降。
- web 单测：附件 URL 断言随 query 参数形态更新；e2e 直连补头。

## 影响范围

代码：`src/interface-adapters/http/{identity-middleware.ts(新), router.ts}`；
`web/src/api/{identity.ts(新), client.ts}`、`web/src/pages/{conversation/{index,MessageList,MessageInput},skills,conversation/WorkspacePanel,conversation/UnfurlCard}`；
`scripts/{alpha,e2e-server,otter-buddy}.sh`、`scripts/migrate-sanxing-wushen.mjs`、`scripts/generate-guard-replay.mjs`(文案)；
测试：`tests/helpers/with-identity.ts(新)`、`tests/api/helpers.ts`、`tests/bootstrap/server-{static-routes,mahjong-static}.test.ts`、`tests/app/build-app.test.ts`、`tests/capability/helpers/boot.ts`、`tests/interface-adapters/http/identity-middleware.test.ts(新)`、web 附件断言 ×2 spec、e2e ×2 spec。
零 DB 变更、零新依赖、零 prompt/skill/协议层改动。

## 验证（Verification）

### 修复前越权复现（基线，2026-10-16 17:13）

被测=主仓 3000 端口常驻服务（`lsof -p 72710` → cwd=/Users/orca/ai/otter-buddy，即 main 代码
`c6593a61`，不含本分支任何改动）；curl **不带任何身份头**：

```
GET /api/conversations?limit=2 -> HTTP 200   （真实对话清单：id/title/status/pinned/unread/otterIds…）
GET /api/settings              -> HTTP 200   （dbPath、embedding、models 全量配置）
GET /api/unknown-xyz           -> HTTP 404   （未知路径无门，直接落 404）
```

### 修复后被拒对照（2026-10-19，隔离实例）

被测=本分支 dist + `config.e2e.yaml` 改端口 3001（隔离数据 `data/e2e/`），
证据文件存对话工作区 `evidence-1322-post-fix.md`（完整输出）：

```
## ① 无身份（修复前 200 的裸访问面）
GET /api/conversations            -> 401 {"error":"Authentication required","code":"unauthorized"}
GET /api/settings                 -> 401
GET /api/unknown-xyz (fail-closed)-> 401   ← 修复前 404
POST /api/conversations (无身份)  -> 401   ← 非读面同样先认身份（证据文件中原行标签误写为 (guest)，以响应体为准；
                                              「带 id 无 role 的 guest 写→403」由矩阵用例钉住）
PUT  /api/settings (role=user)    -> 403 {"error":"Insufficient role: admin requires admin","code":"forbidden"}
## ② 合法身份放行（同 URL 恢复 200）
GET /api/conversations (id 头)     -> 200 {"items":[]…}
GET /api/conversations (id+admin)  -> 200
GET /api/settings (id 头)          -> 200   （处置 1 前实例输出；读面收 admin 后同请求→403，见 ⑤）
## ③ 直链 query 通道（附件 img/a 无法设头的退路）
GET /api/attachments/att-none 无身份       -> 401
GET /api/attachments/att-none?otterUserId=web-ui&otterRole=admin -> 404（过门后无此资源；401→404 证明通道生效）
## ④ 显式 public 面（免身份）
GET /api/mahjong/rooms/r1/view -> 404（≠401，证明暂置 public 生效）
GET /metrics                   -> 200

## ⑤ 处置 1 追加对照（settings 读面显式收 admin，2026-10-19 追加实例）
GET /api/settings 仅 id 头（guest）  -> 403 Insufficient role: admin requires admin
GET /api/settings (id+role=user)     -> 403 同上
GET /api/settings (id+role=admin)    -> 200（配置正常读出）
GET /api/conversations (回归，admin)  -> 200
```

对照结论：修复前裸 GET=200 真数据 → 修复后同 URL=401；写面 403 按 role 分档；
证据链闭合（修复前复现 + 修复后被拒 + 放行不回归）。
实例已用受控入口 `node scripts/restart-service.mjs kill-by-pid`（cwd 校验通过）终止。

### 测试与门禁

| 闸 | 结果 |
|---|---|
| 全仓 `npx vitest run` | **397 文件 / 6205 过 / 6 跳 / 0 败**（含处置 1 新增钉子，处置后复跑） |
| 鉴权矩阵新增用例 | 20/20 绿 |
| web `npm test` | **70 文件 / 708 过 / 0 败**（rebase 到 03bd0ddd 后） |
| `npx tsc --noEmit`（主仓 tsconfig / web tsconfig） | exit 0 / exit 0 |
| `npm run check`（build+lint+lint:schema+smoke:boot+script-arg） | 全过（最终步 `test:script-arg-parse` 全部通过佐证链完整） |
| `cd web && npm run build`（tsc+vite） | 绿 |
| `npm run lint` | 0 error；**1 warning 为 pre-existing**（见下） |
| Golden Gate | n/a：纯硬代码（HTTP 中间件/客户端/脚本/测试），未触碰 prompt/skill/协作协议层 |
| 锚点重放评审 | n/a：无 prompt/skill/tool description 行为触发语义变更 |
| UI 视觉核对 | n/a：无视觉变更（头/直链 query 对界面不可见，附件渲染由单测断言钉住） |

### pre-existing 声明（附 origin/main 对照证据）

`npm run lint` 唯一 warning：`src/frameworks/db/conversation/conversation-repository-mixins.ts:210
no-console`。证据：`git diff origin/main --name-only -- <该文件>` 输出**空**、
`git diff origin/main --stat -- <该文件> | wc -l` = **0**（文件字节与 origin/main 一致 ⇒ 在本分支
跑 eslint ≡ 在 main 跑 eslint，该 warning 属 main 既有，非本次变更引入）。
无其他失败项需要 pre-existing 声明（全部测试/门禁绿）。

### 边界自查（改动清单，`git diff HEAD` 22 文件 93+/34- + 新增 5 文件）

- 服务端（2）：`src/interface-adapters/http/{identity-middleware.ts 新, router.ts}`
- 测试（7）：`tests/helpers/with-identity.ts 新`、`tests/interface-adapters/http/identity-middleware.test.ts 新`、
  `tests/api/helpers.ts`、`tests/bootstrap/server-{static-routes,mahjong-static}.test.ts`、
  `tests/app/build-app.test.ts`、`tests/capability/helpers/boot.ts`
- web（11，含 2 测试）：`web/src/api/{identity.ts 新, client.ts}`、conversation 页 5 处（订阅 XHR/附件直链×2 组件/两测试）、
  skills 页、UnfurlCard、WorkspacePanel、e2e 2 spec
- 脚本（5）：alpha/e2e-server/otter-buddy 探针带身份头、migrate fetch 带头、guard-replay 提示文案
- 文档（1）：本文档

**零文件触碰 `web-mahjong/`、`src/entities/mahjong/`**（派工红界）；router.ts 仅加中间件挂载
（若与 fix/mahjong-chat-echo 撞车以 rebase 解——#1536 已自报 router.ts 零改动，预计无冲突）。
web/scripts/e2e 涟漪属派工预期的「全客户端接入」，非越界。
