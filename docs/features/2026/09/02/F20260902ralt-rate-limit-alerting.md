---
id: F20260902ralt
title: 模型限流 429 编排层感知：healing 落账 + 会话告警 + 派工前置提示
summary: 修复 #543——api_error 终态的 429/配额耗尽对编排层完全黑盒，检视席静默空转 3 小时无告警
change_type: fix
created_in_conversation: a56c349e-c566-438c-97d0-653a260171ed
---

# 模型限流 429 编排层感知：healing 落账 + 会话告警 + 派工前置提示

## 背景（#543）

2026-08-27 纸面交易 PR4 链：14:55 实现獭 429 限流（5 小时限额，重置点 18:05）——中断 3 小时+无任何系统级告警，靠检视獭 19:00 现场人工核实才发现。9/1 早报再添实证（429 ×2 后重试链异常）、9/2 09:00 健康检查 agent invocation 截断失败。

## 根因链（排查结论）

```
LLM API 429（终态配额耗尽）
→ pi-ai 判定 isTerminalRateLimitError → 不重试直接失败
→ pi-coding-agent session.state.errorMessage 记录
→ otter 层 checkSessionError 抛 `LLM API error: <provider 错误正文>`
→ orchestrator classifyExit 分类为 api_error
→ routeByReason: case 'api_error' → failTerminal 直接终态   ← 盲区在此
   （无 healing event、无系统消息、无告警——搭档和编排獭只能看消息 failed，不知道是配额黑了）
```

关键代码锚点（修复前）：
- `orchestrator.ts` `routeByReason`：`case 'api_error': return this.failTerminal(...)` 一行直达终态
- 对照组：`guard_abort` 路径有 degenerate 落账（recordDegenerateHealingEvent）、熔断上限有 sendSystem 通知（F20260831cbkw）——api_error 是唯一无告警的失败终态

为什么不该在 otter 层重试：SDK（pi-coding-agent agent-session）已内置 maxRetries=4 指数退避；能上抛到 orchestrator 的 429 要么是终态配额耗尽（`isTerminalRateLimitError` 判定不可重试），要么 SDK 重试预算已耗尽。otter 层再叠加退避重试只会续期静默窗——这正是 #642 的教训（链看门狗对 429 失明，静默窗被重试无限续期）。

## 方案设计

三出口（对应 issue 修复方向）：

### 出口① healing 落账（errorType: rate_limit）

- `HealingErrorType` 新增 `'rate_limit'` 枚举
- severity 分级：配额耗尽（终态）→ high；瞬时限流（SDK 重试耗尽）→ medium
- context 携带 `modelAlias` / `exhausted` / `resetHint` / `errorMessage(截断500)`——编排獭 query healing 台账即可看到「谁在 429、哪个模型、何时重置」

### 出口② 会话内即时告警（sendSystem + SSE system.message）

- 配额耗尽：`[系统告警] <獭名> 的模型 <alias> 配额耗尽（429 限流终态），本轮发言已终止…编排者请改派其他模型的獭`
- 瞬时限流：`[系统提示] …SDK 自动重试已耗尽…通常短时后自行恢复`
- 高危路由增强：high 级 rate_limit 事件同时入 `healingAlertRegistry` 队列——大獭下一次 invoke 时 DynamicContext 注入提醒（复用 F20260826mwrd C3 管道，进程内即时、无需轮询）

### 出口③ 派工前置提示（create_otter，可选增强）

- 创建小獭指定模型（或走默认模型）时，检查该模型近 24h 内有无未恢复的 rate_limit(exhausted=true) 事件，有则在回包附 ⚠️ 提示
- 提示不硬拦：rate_limit 事件无人驱动 resolve（配额恢复是外部事实），硬拦会误伤；编排獭结合上下文自行裁决

## 识别策略（rate-limit-error.ts）

正则匹配错误消息文本——数据源是 pi-ai `formatProviderError` 格式化 + checkSessionError 加前缀后的终端形态（跨 provider 统一）。纯函数可单测。

| 分类 | 模式 | 例 |
|------|------|-----|
| 配额耗尽（exhausted） | `usage_limit_reached` / `insufficient_quota` / `quota…exceeded` / `配额…耗尽` / `insufficient balance` / `arrearage` | 智谱 code 1310、OpenAI 月配额 |
| 瞬时限流 | `\b429\b` / `rate limit` | SDK 重试耗尽上抛 |
| 重置提示（尽力） | `每日/每周/每月…重置` / ISO 时间戳+重置 / `reset at` | 智谱响应体中文粒度说明 |

重置时间边界：pi-ai 的 openai-completions 路径（GLM 走这条）不透传 Retry-After 响应头，重置提示从错误正文尽力提取；提取不到则落观察时间戳（createdAt）——issue 原文「没有则记观察时间戳」。宁可保守缺省，不误报。

## 变更清单

| 文件 | 变更 |
|------|------|
| `src/entities/healing/healing-event.ts` | `HealingErrorType` + `'rate_limit'` |
| `src/usecases/conversation/agent-turn-orchestrator/rate-limit-error.ts` | **新增** 识别纯函数 + 告警文案 |
| `src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts` | `api_error` 路由改走 `handleApiError`（识别→落账→告警→failTerminal）；executeTurn catch 保留 err `_modelAlias` 到 result（落账需模型标识） |
| `src/usecases/conversation/agent-turn-orchestrator/types.ts` | `HealingEventInput.errorType` + `rate_limit` |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | create_otter 配额前置提示（checkModelQuotaHint）；HealingEventInput 类型随实体放宽 |
| `tests/.../rate-limit-error.test.ts` | **新增** 识别/文案单测（11 例） |
| `tests/.../agent-invoker-rate-limit.test.ts` | **新增** 集成测试（5 例）：模拟 429 错误注入 SDK mock → 断言落账+通知路径 |

## 验证

- 单测：`npx vitest run tests/usecases/conversation/agent-turn-orchestrator/rate-limit-error.test.ts tests/interface-adapters/agent-invoker-rate-limit.test.ts` → 16/16 通过
- 集成断言覆盖：配额耗尽落账（high + modelAlias + resetHint）/ 瞬时限流（medium）/ 非限流不误报 / 落账失败不阻断主路径 / 无 healingRepo 降级仍告警
- 全量回归：222 文件 2803 测试全过；`npm run lint` 0 error；`npm run build` 通过
- 真实链路不强求复现（issue 验收原文），错误形态按 pi-ai 源码实证建模（openai-codex-responses.js `isTerminalRateLimitError` / openai-completions.js `formatProviderError`）

**最简实现检查**：已过。识别逻辑收敛为单文件纯函数（regex 识别 + 两个文案构造器），编排层改动最小化（一个路由 case + err 元数据透传），无新依赖、无 DB schema 变更（rate_limit 复用 errorType 字符串列）、无新进程内状态（高警复用既有 healingAlertRegistry）。曾评估在 pi-session-factory 层落账（离错误源更近）但该层无 sendSystem 通道，通知会缺主出口——落点选 orchestrator（错误终端汇聚点 + callbacks 齐全）。

## 边界与遗留

- 派工前置检查按 24h 窗口扫描 open 事件，不判定配额恢复（外部事实）；提示性信息由编排獭裁决
- issue 方案 3（成本可见性：按模型/按日 token 聚合视图）标 P2 可拆分，本 PR 不做
- 已知边界（接受）：正则识别依赖 provider 错误正文格式，新 provider 文案变化可能漏识别——漏识别退化为现状（fail 无告警），不劣化
