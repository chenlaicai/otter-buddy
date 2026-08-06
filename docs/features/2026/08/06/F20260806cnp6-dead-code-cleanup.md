---
id: F20260806cnp6
title: dead-code-cleanup
doc_type: feature

summary: |
  代码新鲜度专项清理：删除死文件、不可达分支与兼容 shim，合并双定义，SSEEvent 信封收编到 api-contract 单一来源。
  动机：仓内积累了一批"保守保留"的过渡产物（Proxy 兼容导出、同名端口双定义、结构兼容注释同步），腐蚀唯一真相源原则。
  机制：全部物理删除或合并到规范位置，不留 @deprecated 桥。

causal_links:
  from:
    - F20260717wx6q   # pi-agent-core-cleanup（system-prompt-config.ts 当年"保守保留"决策，本次推翻）

status: development
change_type: refactor
tags: [cleanup, dead-code, compatibility-shim, single-source]
modules:
  - src/frameworks/agent/system-prompt-config.ts
  - web/src/api/index.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/usecases/ports/agent-invoke-port.ts
  - src/usecases/scheduler/agent-invoke-port.ts
  - api-contract/sse/events.ts
  - src/interface-adapters/http/sse-streamer.ts
  - src/usecases/im/message-broadcaster.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/frameworks/config/index.ts

created_at: 2026-08-06
---

# 死代码与兼容残留清理

## 背景

全仓代码新鲜度检视（兼容性处理、老旧残留、TODO/FIXME）发现一批过渡产物。本档记录清理项与依据。检视中确认**无需处理**的项也列在文末，避免后续重复排查。

## 清理项

### 1. 死文件物理删除

| 文件 | 依据 |
|------|------|
| `src/frameworks/agent/system-prompt-config.ts` | 全仓零 import。F20260717wx6q 决策 2 当年"保守保留"（理由：getPriorityWeight 可能未来使用），一年半载后仍无消费者，推翻该决策 |
| `web/src/api/index.ts` | barrel（`export * from client/sse`），web 页面全部直接引 `api/client`，裸 `api` 路径零引用（`@contract/api` 是另一包，不影响） |
| `src/types/`（空目录） | 本地残留，git 不跟踪，直接 rmdir |

### 2. 不可达分支删除（pi-session-factory）

`_ensureModelRuntime` 中的单模型 else 分支（"兼容旧逻辑"）在生产装配下不可达：`initModels` 两条路径（initSingleModel / initMultiModel）都产出 `ModelPool`（models-factory.ts:218/:255），bootstrap/database.ts 必装配下传。删除 else，注释说明不变量。

### 3. AgentInvokePort 双定义合并

同名端口曾有两处定义：`usecases/ports/agent-invoke-port.ts`（消费者 agent-dispatch-service）与 `usecases/scheduler/agent-invoke-port.ts`（消费者 scheduler-service、process-inbound-recruit、platforms 装配）。合并到规范的 `usecases/ports/`，`AgentInvokePortAdapter` 一并迁入；ports 版签名（含可选 `onSSEEvent`、`aggregatedTargets`）是 scheduler 版超集，消费者只需改 import 路径。

### 4. SSEEvent 信封单一来源

`{event, data}` 信封曾有三份"结构兼容"拷贝：sse-streamer（自认真定义）、agent-invoker 的 `AgentSSEEvent`、message-broadcaster 的私有 `SSEEvent`，靠注释维持同步。现收编到 `api-contract/sse/events.ts`（跨层共享，不违反分层：usecases 不能 import interface-adapters）。sse-streamer re-export 保持原 import 路径可用；`AgentSSEEvent` 别名不保留，agent-invoker 内全量替换为 `SSEEvent`。

### 5. config 兼容导出 Proxy 移除

`frameworks/config/index.ts` 的 `config` Proxy（"兼容旧代码"）全仓只剩 pi-session-factory 两处 `circuitBreaker` 读取。改用 `getConfig()` 调用时获取（构造函数与运行时调用均在 main.ts `initConfig` 之后，行为不变——旧 Proxy 访问属性时同样要求已初始化）。Proxy 删除，identity-prefix.test 的 mock 同步改为 `getConfig`。

## 检视确认无需处理项

- `prompts/platform/SYSTEM_PROMPT.md` / `platformPrompt` 字段：此前已彻底清理，零残留。
- dist 产物未混入 git 跟踪与 src 引用链。
- `web/.../Modals.tsx` 的 `legacyCopy`：clipboard API 正当降级，保留。
- 术语库 `deprecated` 状态：是设计语义（F20260716hkv3），非代码残留。

## 遗留待议（不在本 PR）

- 单模型兼容路径整体移除（`initSingleModel` + config-service `validateMultiModel` 顶层 `llm.*` 回填）：涉及 config.yaml schema 破坏性变更，单独 PR。
- `web/src/pages/skills` 整页 mock（TODO: API contract not yet defined）：产品决策项，补 API 或摘出构建入口。
- `db/otter/backfill-session-ledger.ts` 一次性回填每次启动执行：需加幂等守卫。
- `tests/api/helpers.ts:475-476` 两处 TODO mock stub。

## 验证

- `npx tsc --noEmit`（后端 + web）通过
- `npm run lint` 通过
- `npx vitest run`：84 文件 / 1041 测试全绿
