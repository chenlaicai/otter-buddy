---
id: F20260901r5xx
title: "RHI HTTP 端点错误响应统一：废除守门人模式，catch 兜底改 5xx（#581）"
summary: "rhi-controller 8 个端点的 catch 兜底从「200+error body」改为经 handleError 统一返回 5xx（DomainError 自动映射 4xx）；全局盘点确认守门人残留仅在 rhi-controller，memory health 端点的 200+healthy:false 是健康度数据语义予以保留；前端清理 ok:false 死代码；ADR 记录决策依据。"
change_type: refactor
status: development
created_at: 2026-09-01
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
capability_test: "n/a: HTTP 错误状态码语义修正，无 LLM 行为变更"
tags: [http, api, error-handling, rhi, adr, status-code]
modules:
  - src/interface-adapters/http/controllers/rhi-controller.ts
  - src/interface-adapters/http/http-error.ts
  - web/src/api/client.ts
  - web/src/pages/health/index.tsx
  - tests/api/rhi-api.test.ts
---

# RHI HTTP 端点错误响应统一：废除守门人模式（#581）

## 背景

Issue #581（源自 PR #557 对抗审视发现 #2）：rhi-controller 全部端点的 catch 兜底返回 HTTP 200 + `{ error }` body——控制器头注释声明这是有意的「守门人模式」（对齐 memory 端点的历史决定）。

问题：服务端错误应 5xx，客户端无法凭状态码快速分流——监控告警、重试策略、网关层都依赖状态码。检视獭-557b 实测订正过 issue 描述：trends 端点同样 200+error，新旧端点行为一致。

**决策**：大獭拍板走方案 a——统一改 5xx + 前端适配 + ADR 记录（不再走方案 b 纯 ADR）。

## ADR：为什么放弃守门人模式

### 历史决定

守门人模式诞生于 RHI 端点初建期（F20260825rweb Phase 2），当时「对齐 memory 端点」的写法被当作惯例沿用。但它对齐的其实是 **memory health 端点的健康度语义**，而非通用错误处理约定——后续 rhi-controller 各端点（trends/score/costOutput）照抄了这个 catch 模板，把「数据端点读依赖故障」也包成了 200+error。

### 本次决策理由

1. **仓库已有统一错误基础设施**：`src/interface-adapters/http/http-error.ts` 的 `handleError` 将 DomainError 映射 404/409/400/403、HttpError 按携带状态码、未知错误 500。11 个 controller（memory/message/conversation/connection 等）已在用——rhi-controller 是漏网之鱼，不是异见者。
2. **状态码是机器可读的错误分流信号**：监控告警（按 5xx 告警）、重试策略（5xx 可重试）、网关层（连续 5xx 熔断）都依赖状态码。200+error 需要每个消费方解析 body 才能发现错误，等于把类型信息藏进字符串。
3. **前端已有完备的适配层**：`web/src/api/client.ts` 的 `request()` 统一检查 `res.ok` 并抛 `ApiError`（含 status + body.error）——后端改 5xx 后，现有 catch 分支自动接管，适配成本极低。

### 保留的例外（不在本次废除范围）

- **`GET /api/health/memory` 的 200 + `healthy:false`**（health-controller.ts）：F20260803mval 的显式决策——健康检查的响应体本身就是诊断数据，`healthy:false` + `gapReasons` 是**健康度语义**而非 transport 错误；「系统能回答自己不健康」恰恰是健康检查成功。前端 memory 页 banner 依赖此语义。**这不是守门人模式，是领域语义**。
- **channel-controller**：无 try-catch，依赖 Hono 框架默认 500，无守门人问题。
- **inbound-controller**：已正确使用 401/400/503/500。

### 4xx/5xx 分流粒度（实现决策）

RHI 端点的 catch 是「未知依赖故障」兜底——repo/worker 抛出的错误无领域语义可分。决策：

- **不引入新的错误分类逻辑**（catch 块里判断 error message 猜语义是反模式）
- **一律经 handleError → 500**；未来 usecase 层抛 DomainError 时自动获得正确 4xx（DomainError→404/409/400/403 映射已内建）
- **已有的显式 404 保留**：chainDetail 的 `chain not found` 路径本来就是 404，不动

## 全局盘点清单（catch 返回 200+error 的端点）

| Controller | 端点 | 原行为 | 处置 |
|---|---|---|---|
| rhi-controller | GET /api/health/overview | 200+error | ✅ 改 handleError（500） |
| rhi-controller | GET /api/health/signals | 200+error | ✅ 改 handleError（500） |
| rhi-controller | GET /api/health/chains | 200+error | ✅ 改 handleError（500） |
| rhi-controller | GET /api/health/chains/:featureId | catch 200+error（not-found 已 404） | ✅ 改 handleError（500），404 路径保留 |
| rhi-controller | GET /api/health/trends | 200+error | ✅ 改 handleError（500） |
| rhi-controller | GET /api/health/score | 200+error | ✅ 改 handleError（500） |
| rhi-controller | GET /api/health/cost-output | 200+error | ✅ 改 handleError（500） |
| rhi-controller | POST /api/health/scan | 200+ok:false | ✅ 改 handleError（500），响应体去掉 ok:false 分支 |
| health-controller | GET /api/health/memory | 200+healthy:false | ⏸️ 保留（F20260803mval 健康度语义，见 ADR） |
| 其余 11 个 controller | — | 已用 handleError | 无需处置 |

盘点方法：`grep -A 4 "} catch" src/interface-adapters/http/controllers/*.ts` 逐 controller 核对 catch 块行为。

## 前端适配（消费点清单）

RHI 端点的 web 消费方全部经 `web/src/api/client.ts` 的 `request()`（统一 `res.ok` 检查 + `ApiError` 抛出）：

| 消费点 | 适配 |
|---|---|
| `request()`（client.ts:33-41） | ✅ 已有 `res.ok` 检查，无需改——5xx 自动进 catch |
| `pages/health/index.tsx` refresh() | ✅ 已有 catch + toast 错误，无需改 |
| `pages/health/index.tsx` triggerScan() | ✅ 清理 `r.ok ? ... : '扫描失败'` 三元（ok:false 成死代码），失败统一进 catch toast |
| `client.ts` triggerRhiScan() 返回类型 | ✅ 去掉 `ok: boolean` 字段 |
| `pages/memory/index.tsx` getMemoryHealth | ⏸️ 无需改——memory health 端点语义未变（仍 200+healthy:false） |

直接 `fetch` 绕过 request() 的消费点（WorkspacePanel.tsx）不消费 RHI 端点，不在影响范围。

## 变更明细

- `src/interface-adapters/http/controllers/rhi-controller.ts`：头注释更新（守门人模式 → HTTP 语义优先）；import handleError；8 个 catch 块改 `return handleError(c, err, this.logger)`；scan 的响应体去掉 ok:false 分支（失败即 500）
- `web/src/api/client.ts`：triggerRhiScan 返回类型去掉 ok 字段 + 注释
- `web/src/pages/health/index.tsx`：triggerScan 简化为成功路径 + catch toast
- `tests/api/rhi-api.test.ts`：新增 describe「错误路径状态码」8 用例——bad repo/worker 注入，断言每端点 catch → 500 + error body（scan 断言不再出现 ok:false）；mock ctx 补 `get: () => undefined`（handleError 读 requestId）

### 回修记录（检视獭-676 审视处置，3 建议全采纳）

1. **重复日志**：删 8 处 catch 内前序 `this.logger.error("RHI xxx failed")`——handleError 内部统一记日志（含 requestId/errorCode/statusCode 结构化字段），前序 log 是每错误双条噪声，且其余 11 controller 均无此前序模式
2. **DomainError→4xx 零佐证**：补 2 端点级用例（not_found→404 / validation→400），验证 ADR 声称的映射在 RHI 端点真实生效
3. **scan ok:true 残留**：成功响应体改 `{ result }`（ok 字段彻底废除——HTTP 200 即成功，状态由状态码携带），同步更新 scan 用例断言 `ok` undefined

## 验证

- `npx vitest run tests/api/rhi-api.test.ts`：31 passed（21 原有 + 8 错误路径 + 2 DomainError→4xx，回修后）
- `npx vitest run` 全量：**205 文件 / 2563 测试全绿**（回修后复跑）
- `npx tsc --noEmit`：零错误
- 全量自检 + lint + web build：见 PR（CI 复核）
- **最简实现检查**：已过——复用现成 `handleError`（11 controller 同款模式），未新写错误分类逻辑、未新增文件；前端只删死代码不加分支。
- 兼容性：与 #665（开放 PR，改 rhi-controller 聚合口径）改动区域不重叠——catch 块 vs 聚合函数，语义合并无冲突。

## 关联

- Issue #581（Closes）
- 来源：PR #557 对抗审视发现 #2
- F20260803mval：memory health 200+healthy:false 的保留依据
- F20260825rweb：守门人模式的诞生地（rhi-controller 初版）
