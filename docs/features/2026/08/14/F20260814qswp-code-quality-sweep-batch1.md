---
id: F20260814qswp
title: code-quality-sweep-batch1
doc_type: feature

summary: |
  代码质量专项清理第一批：修 4 个前端流式渲染 bug/埋雷 + 补 2 个工程门禁漏洞。
  核心根因：批量更新在 setState updater 内执行且返回 prev 导致 50ms 窗口内更新丢失；
  SSE 三份处理器漂移导致重试消息流式事件静默丢失。主机制：MessageBatcher 暂存副本链式执行、
  分层 ESLint 白名单取反为默认全限制、web 启用 react-hooks 规则。

causal_links:
  from: []

status: implemented
change_type: fix
tags: [quality, frontend, lint, architecture]
modules:
  - web/src/lib/batch-update.ts
  - web/src/pages/conversation/index.tsx
  - web/src/pages/conversation/MessageList.tsx
  - eslint.config.mjs
  - src/usecases/scheduler/scheduler-service.ts
  - src/usecases/scheduler/scheduler-metrics-port.ts
  - src/frameworks/agent/pi-session-factory.ts
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# F20260814qswp: 代码质量专项清理第一批（行为 bug + 门禁漏洞）

## 背景与需求

### 问题描述

架构师对全仓做代码架构/质量检视后，按根因耦合度分三批偿付技术债。本批为「已知在损害用户或已埋雷」的 6 项：

1. **批量更新丢窗口内更新**：`batchUpdateMessages` 在 `setAllMessages` 的 updater 内执行业务 updater 并返回 `prev`（state 永不变）——同一 50ms 窗口内后续 updater 读到的永远是原始列表，中间更新全部丢失（`message.start` 占位 + 同窗口 `assistant_text` 的文本段直接消失）。
2. **SSE 事件类型漂移**：重试流 `assistant_text` 记 `eventType:'text'/payload:{text}`，与常驻/发送流的 `'assistant_text'/{content}` 漂移；`MessageList` 的 EventItem 只识别后者，重试消息的流式文本事件全部静默丢失（落入 `return null`）。
3. **MessageList 违反 Rules of Hooks**：三个条件 return（no-llm/loading/empty）位于 hooks 声明之前，同一挂载实例上 state 切换会因 hooks 数量变化直接崩溃；且 web 未启用 `eslint-plugin-react-hooks`，静态检查抓不到。
4. **ESLint 分层白名单失守**：`restrictedFrameworks` 手工列举遗漏 metrics/scheduler/feishu，`scheduler-service.ts` 已实际值导入 `@frameworks/metrics`（usecases → frameworks 破口）。
5. **abort 漏 catch**：`pi-session-factory.abort()` 内 `entry.abort()` 返回 Promise 未 await 无 catch，unhandledRejection 风险（同文件 guardAbort 有既有防护模式，此处漏了）。
6. **web 幽灵依赖**：`react-virtuoso`/`hono`/`@hono/node-server`/`@larksuiteoapi/node-sdk` 在依赖表但源码零引用；注释还在提 Virtuoso 误导后来者以为有虚拟化。

另有两项顺手收敛：发送流两处裸 `setAllMessages` 统一走批量通道（消除与暂存副本的双轨竞态）；`batch-update.test.ts` 原为影子测试（复刻实现副本做断言），改为测试真实实现。

### 根因分析

- 批量更新缺陷的根因是**滥用 React state updater 做即时计算**：把"对列表应用变更"和"调度合并渲染"两个关注点塞进了 setState updater，而 updater 必须是纯函数且返回值才是新 state——返回 `prev` 规避重渲染的同时破坏了数据流，副作用（写 ref、起 timer）写在 updater 内进一步违反纯函数约定。
- 事件漂移的根因是 **SSE 处理器三份复制**（常驻/发送/重试），无共享事件构造点，修一处漏两处。
- 分层白名单失守的根因是**维护约定不可靠**：注释自述"新增模块需手动补"已被证明会遗漏。取反为默认全限制（deny-all-except-logger）后新增模块自动覆盖。

### 数据实锤

- 旧测试 `batch-update.test.ts:50-70、108-128` 明确断言"丢失了 m4"/"m4 不存在"——缺陷被测试文档化却照此上线。
- lint 改为黑名单取向后全仓 0 error，证明除 scheduler-service（已同步修复为注入化）外无其他现存破口。

## 方案设计

### 技术方案

1. **MessageBatcher**（`web/src/lib/batch-update.ts`）：`update()` 调用时立即对暂存副本（pending 或 `getBase` 镜像）执行 updater，窗口内多次 update 链式生效；到期 `flush()` 一次 apply 到真实 state。updater 同步执行的语义保留（调用方的 `added` 闭包计数模式仍可靠）。窗口内暂存值与外部直接写 state（轮询快照）仍是 Map-overwrite 语义，由 `upsertTerminalMessage` 幂等合并兜底（与旧实现一致）。组件内 `useMemo` 单例 + 卸载 `dispose()`。
2. **重试流对齐**：事件形状统一为 `eventType:'assistant_text' + payload.content`；守卫条件从 meta 改为 liveEvents（与其他两路一致）。
3. **Hooks 前置**：条件分支移到全部 hooks 之后；`rules-of-hooks` 设 error、`exhaustive-deps` 设 warn（存量 8 处 warn 保留为提示，非本次范围）。
4. **分层取反**：`group: ["@frameworks/**", "**/frameworks/**"] + allow: logger`；scheduler-service 改依赖新建的 `SchedulerMetricsPort`（结构化兼容具体类，无需 adapter），时钟 `now` 注入化（默认 `Date.now()`）。
5. abort 对齐既有模式 `void ...abort().catch(logger.warn)`。
6. web 依赖表移除 4 个零引用包；相关过期注释（Virtuoso、React 18 createRoot 同步语义）一并修正。

### 目标

- T1: 50ms 窗口内链式更新零丢失（含 message.start→assistant_text→complete 同窗口场景）
- T2: 重试消息的流式过程面板完整显示文本事件
- T3: MessageList 任意 state 切换不触发 hooks 崩溃；web 有静态规则守护
- T4: usecases 层对 frameworks 的 import 全被 lint 拦截（白名单仅 logger），现存破口清零

### 成功标准

lint 0 error（含新 hooks 规则）+ 前后端 tsc 通过 + 全部测试通过 + 新增回归测试锁住 T1/T2 语义。

## 验收标准

### 验收场景
| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | 窗口内更新不丢失 | batcher 同窗口三次 update（占位/追加文本/终态）后推进 50ms | flush 一次，m4 存在且为终态内容 |
| AT-2 | 重试流文本事件可见 | 重试消息 → MessageList EventItem 渲染流式面板 | eventType 为 assistant_text，文本事件不丢失 |
| AT-3 | hooks 顺序合法 | eslint（rules-of-hooks: error） | 0 error |
| AT-4 | 分层边界默认全限制 | usecases 下任意文件 import @frameworks/metrics | eslint error |

### 能力测试映射
n/a（A 类纯代码逻辑，无 LLM 参与行为）。

## 实现细节

### 代码修改

| 文件 | 操作 | 说明 |
|------|------|------|
| web/src/lib/batch-update.ts | 新增 | MessageBatcher 真实实现 |
| web/src/lib/batch-update.test.ts | 重写 | 影子测试 → 测真实实现，8 个用例锁链式语义 |
| web/src/pages/conversation/index.tsx | 修改 | 接入 batcher；发送流两处裸 setAllMessages 统一走批量通道；重试流事件形状对齐；Virtuoso/React18 过期注释修正 |
| web/src/pages/conversation/MessageList.tsx | 修改 | 三个条件 return 移到 hooks 之后 |
| eslint.config.mjs | 修改 | restrictedFrameworks 取反 + web 启用 react-hooks 规则 |
| package.json / package-lock.json | 修改 | +eslint-plugin-react-hooks@^7.1.1 |
| src/usecases/scheduler/scheduler-metrics-port.ts | 新增 | SchedulerMetricsPort（结构化兼容 SchedulerMetrics） |
| src/usecases/scheduler/scheduler-service.ts | 修改 | 去除 @frameworks/metrics 依赖，metrics 走 port、now 注入 |
| src/frameworks/agent/pi-session-factory.ts | 修改 | abort() 补 catch（对齐 guardAbort 模式） |
| web/package.json / web/package-lock.json | 修改 | 移除 4 个零引用依赖 |

### 逻辑变更（补充：边界规则的实现陷阱与阳性验证）

ESLint 10 的 `no-restricted-imports` patterns 对象既不支持 pattern 级 `allow`、也不支持选项顶层 `allow`，例外只能用 `regex` 负向前瞻实现：`(?:^|@|/)frameworks/(?!logger(?:/|$))`。首版正则 `(?:^|/)` 漏匹配 `@frameworks/` 别名形式（`@` 后无 `/`）导致规则静默失效——**lint 全绿不等于规则生效**，已用探针文件做阳性验证（metrics 别名 import、相对路径 import 均被拦，`@frameworks/logger` 豁免）。

### 逻辑变更（原）

- `getBase` 读取 `allMessagesRef`（render 后同步的 state 镜像）；apply 时跳过与现值相同的会话避免无效渲染。
- 发送流 `syncLiveEvents`/`assistant_text` 累积改走 `batchUpdateMessages` 后，消息列表写入单轨化——旧双轨（批量暂存 vs 直接 setState）在窗口内互相覆盖的竞态消除。
- `handleSend`/`handleRetryMessage`/常驻订阅 effect 的 deps 补入 `batchUpdateMessages`。

### 已知残留（后续批次）

- SSE 处理器三份复制的**结构性合并**（本批只修漂移不合并，合并属重构需独立验证面）
- memory repo 级联删除 ×4 去重、MemoryRepository port 三分（第二批）
- agent runtime 拆解为应用层编排（第三批，需独立设计文档走对抗审视）
- exhaustive-deps 存量 8 处 warn
- conversation 页 878KB chunk（Prism 全量 + 零懒加载）

## 验收结果

### 测试结果

- `npx eslint .`：0 error / 8 warning（exhaustive-deps 存量）
- 后端 `npx tsc --noEmit` 通过；web `npx tsc --noEmit` 通过
- 后端 vitest：101 文件 / 1207 测试全部通过
- web vitest：14 文件 / 123 测试全部通过（含新增 MessageBatcher 8 用例 + MessageList 渲染 4 用例）

### 证据判定
| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 窗口内零丢失 | 测试通过（回归用例直接断言链式语义） | ✅ |
| T2 重试流事件可见 | 真实实例验证（隔离端口 3210 + 独立 DB + kimi 真实 LLM，send→abort→retry 全流程）：重试 SSE 流实际投递 assistant_text 事件且 payload.content 为 blocks 数组；DB 持久化事件同形状；新增 MessageList.test.tsx 4 用例锁定 EventItem 对新形状渲染、旧形状（'text'）不渲染 | ✅ |
| T3 hooks 守护 | rules-of-hooks error 级 0 违规 | ✅ |
| T4 分层全限制 | 黑名单取反后全仓 0 error（破口清零）+ 探针阳性验证 | ✅ |

#### AT-2 验证过程记录（含两个顺带发现）

- 验证路径：隔离实例（`config/config.yaml` 本地副本：端口 3210、`./data/verify-at2.db`、默认模型 mimo→kimi）→ 建会话 → POST 发送 → 2.5s abort → POST retry → 抓取 SSE 原始事件 + 查 DB message_events。mimo 首响应挂起 18min+（与既往退化观察一致），换 kimi 后流程正常。
- **发现 A（未修，独立问题）**：POST 发送流与 GET 订阅流的事件推送均依赖 `messageBroadcaster`，而 broadcaster 仅在飞书配置存在时创建（`app.ts:176` `messageBroadcaster: feishu?.broadcaster`）。web-only 部署（不配飞书）下整个流式事件链路断流，POST 流只剩 stream.end，GET subscribe 端点直接对 undefined 调 subscribe 会抛错。验证时以无效飞书凭证让 broadcaster 建立后链路恢复。建议后续独立 issue：broadcaster 与飞书解耦（本地 SSE 也应走统一广播总线）。
- **发现 B（未修，既有行为）**：重试触发的 speak 失败会走 speak 重试，耗尽后 message.failed（"Speak retry exhausted"）——与记忆中"重试成功率待观察"一致，非本 PR 引入。
- jsdom 测试技巧记录：React 合成事件需用原生 `HTMLElement.click()` 触发，`dispatchEvent(new MouseEvent)` 无效（MessageList.test.tsx 内有注释）。

## 设计决策

- **updater 同步执行而非排队到 flush**：常驻/发送流的 `added` 闭包计数模式依赖"updater 调用后立即可读"，排队到 flush 会破坏该语义且收益仅是少一次暂存复制。
- **exhaustive-deps 设 warn 不设 error**：前端存量 8 处依赖刻意省略多与 MPA 生命周期假设绑定，一步设 error 会阻塞且强迫逐个人工判定；先让债务可见。
- **SchedulerMetricsPort 用结构化兼容而非 adapter**：具体类方法签名与端口完全一致，bootstrap 传具体类即可，不为纪律符号增加一层无信息量的转发。

## 对抗审视记录

本批为 bugfix + 工程门禁清理（无新架构决策），按流程未走多轮对抗审视；批次二的 repo 重构与批次三的 agent runtime 拆解设计文档将走完整审视流程。
