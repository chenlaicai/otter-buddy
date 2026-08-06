---
id: F20260806cnp6
title: repo-hygiene-sweep
doc_type: feature

summary: |
  代码仓定期排查清理：死代码/兼容 shim 物理删除 + 单模型兼容路径移除（Incompatible），一次排查一个文档。
  动机：仓内积累了一批"保守保留"的过渡产物——双定义、双写、结构兼容拷贝、不可达分支，腐蚀唯一真相源原则。
  机制：全部物理删除或合并到规范位置，不留 @deprecated 桥；llm.models[] 收编为配置唯一真相源。

causal_links:
  from:
    - F20260717wx6q   # pi-agent-core-cleanup（system-prompt-config.ts 当年"保守保留"决策，本次推翻）
    - F20260731-multi-model-routing   # 多模型路由引入时的单/双路径兼容设计，Part 2 收编

status: development
change_type: refactor
tags: [cleanup, dead-code, compatibility-shim, single-source, config, incompatible]
modules:
  - src/frameworks/agent/system-prompt-config.ts
  - web/src/api/index.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/usecases/ports/agent-invoke-port.ts
  - src/usecases/scheduler/agent-invoke-port.ts
  - src/usecases/scheduler/scheduler-service.ts
  - src/usecases/recruiting/process-inbound-recruit.ts
  - src/bootstrap/platforms.ts
  - api-contract/sse/events.ts
  - src/interface-adapters/http/sse-streamer.ts
  - src/usecases/im/message-broadcaster.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/frameworks/config/index.ts
  - src/frameworks/config-service.ts
  - src/frameworks/llm/models-factory.ts
  - src/bootstrap/database.ts
  - src/bootstrap/controllers.ts
  - config/config.yaml.example

created_at: 2026-08-06
---

# 代码仓定期排查清理

全仓代码新鲜度检视（兼容性处理、老旧残留、TODO/FIXME、双实现）后的统一清理。分两个 Part：Part 1 死代码与兼容 shim，Part 2 单模型兼容路径移除（破坏性变更）。检视中确认**无需处理**的项列在文末，避免后续重复排查。

## Part 1：死代码与兼容 shim 清理

### 1.1 死文件物理删除

| 文件 | 依据 |
|------|------|
| `src/frameworks/agent/system-prompt-config.ts` | 全仓零 import。F20260717wx6q 决策 2 当年"保守保留"（理由：getPriorityWeight 可能未来使用），至今无消费者，推翻该决策 |
| `web/src/api/index.ts` | barrel（`export * from client/sse`），web 页面全部直接引 `api/client`，裸 `api` 路径零引用（`@contract/api` 是另一包，不影响） |
| `src/types/`（空目录） | 本地残留，git 不跟踪，直接 rmdir |

### 1.2 不可达分支删除（pi-session-factory）

`_ensureModelRuntime` 中的单模型 else 分支（"兼容旧逻辑"）在生产装配下不可达：`initModels` 两条路径都产出 `ModelPool`，bootstrap 必装配下传。删除 else，注释说明不变量。

### 1.3 AgentInvokePort 双定义合并

同名端口曾有两处定义：`usecases/ports/agent-invoke-port.ts`（消费者 agent-dispatch-service）与 `usecases/scheduler/agent-invoke-port.ts`（消费者 scheduler-service、process-inbound-recruit、platforms 装配）。合并到规范的 `usecases/ports/`，`AgentInvokePortAdapter` 一并迁入；ports 版签名（含可选 `onSSEEvent`、`aggregatedTargets`）是 scheduler 版超集，消费者只需改 import 路径。

### 1.4 SSEEvent 信封单一来源

`{event, data}` 信封曾有三份"结构兼容"拷贝：sse-streamer（自认真定义）、agent-invoker 的 `AgentSSEEvent`、message-broadcaster 的私有 `SSEEvent`，靠注释维持同步。收编到 `api-contract/sse/events.ts`（跨层共享，不违反分层：usecases 不能 import interface-adapters）。`AgentSSEEvent` 别名不保留，agent-invoker 内全量替换为 `SSEEvent`；sse-streamer 一度加的 re-export 经评审核实零消费者，已删（不留兼容桥）。

### 1.5 config 兼容导出 Proxy 移除

`frameworks/config/index.ts` 的 `config` Proxy（"兼容旧代码"）全仓只剩 pi-session-factory 两处 `circuitBreaker` 读取。改用 `getConfig()` 调用时获取（构造函数与运行时调用均在 main.ts `initConfig` 之后，行为不变——旧 Proxy 访问属性时同样要求已初始化）。Proxy 删除，identity-prefix.test 的 mock 同步改为 `getConfig`。

## Part 2：单模型兼容路径移除 [Incompatible]

### 破坏性变更

`config.yaml` 的 `llm.provider` / `llm.model` / `llm.apiKey` / `llm.apiBaseUrl` 顶层字段不再被识别，旧格式配置启动即报错：`llm.models[] 为必填字段`。迁移方式：把顶层字段写为一条 `models[]` 条目（alias 自取，default 缺省取第一条）：

```yaml
# 旧（不再支持）
llm:
  provider: openai
  model: gpt-4o
  apiKey: sk-...

# 新
llm:
  models:
    - alias: default
      provider: openai
      model: gpt-4o
      apiKey: sk-...
```

本机 config.yaml 已是 models[] 格式，无迁移成本。README 双语的配置示例与 .env 迁移表已同步更新。

### 改动明细

| 位置 | 改动 |
|------|------|
| `config-service.ts` | `AppConfig.llm` 收窄为 `{ default: string; models: ModelConfig[] }`；`RawConfig.llm` 删顶层字段；`validate` 删单模型分支、强制 models[] 非空；`validateMultiModel` 更名 `validateModels` 并删除"为单模型兼容填充"的回填（同一份配置双写两个真相源）；loadConfig 日志改记 defaultModel/modelCount |
| `models-factory.ts` | 删 `initSingleModel` 与 `isMultiModel` 分流，`initMultiModel` 更名 `initModelPool` 成为唯一路径；`loadProvider`/`needsCustomProvider` 参数从整个 llm 配置收窄为 `{ apiKey?, apiBaseUrl? }` |
| `bootstrap/database.ts` | `syncApiKeyToAgentAuth` 删单模型 else-if 分支（models[] 恒存在） |
| `bootstrap/controllers.ts` | `appConfig.llm.default ?? appConfig.llm.provider` → `appConfig.llm.default`（validate 保证非空） |
| `config.yaml.example` | 删"单模型模式（兼容旧格式）"注释段 |
| `README.md` / `README.en.md` | 最简配置示例改 models[] 格式；.env 迁移表字段改 `llm.models[]` |
| 两个 config 相关测试文件 | 重写为 models[] 唯一格式 |

### 与 Part 1 的依赖关系

Part 1 已删 pi-session-factory 的单模型 else 分支（`appConfig.llm` 顶层字段的最后消费者），Part 2 删配置层根源。两部分在同一 PR 内自洽。

## 检视确认无需处理项

- `prompts/platform/SYSTEM_PROMPT.md` / `platformPrompt` 字段：此前已彻底清理，零残留。
- dist 产物未混入 git 跟踪与 src 引用链。
- `web/.../Modals.tsx` 的 `legacyCopy`：clipboard API 正当降级，保留。
- 术语库 `deprecated` 状态：是设计语义（F20260716hkv3），非代码残留。

## 遗留待议（不在本次清理）

- `web/src/pages/skills` 整页 mock（TODO: API contract not yet defined）：产品决策项，补 API 或摘出构建入口。
- `db/otter/backfill-session-ledger.ts` 一次性回填每次启动执行：需加幂等守卫。
- `tests/api/helpers.ts:475-476` 两处 TODO mock stub。
- embedding 模型名默认值两处漂移（ensure-model.ts "bge-m3" vs config-service "Xenova/bge-m3"）。
- settings 页 provider 展示语义（评审发现）：`SettingsConfig.provider` 在多模型时代即返回 default alias 而非真实 provider 名（F20260731 引入的历史遗留，本次只是随单模型删除扩大影响面），前端 provider 下拉写死 openai/anthropic/google，alias 查不到时模型下拉为空；该页 LLM 区块本身半 mock，仅展示错乱。

## 评审记录

两个独立 agent 对抗检视（正确性/回归 + 清理彻底性），结论均为"可以合并"。处置：
- 采纳并修复：pi-session-factory 两处 stale 注释（:79 "单模型模式"、:244 "两条路径"在同 PR 内过时）、F 文档 modules 漏列 4 文件、config-service.test 补旧格式报错用例（rejects legacy single-model format）、describe 更名、AgentInvokePortAdapter 补 onSSEEvent 透传。
- 评审分歧裁决：评审 2 称 sse-streamer 的 `export type { SSEEvent }` 是"必要的兼容 re-export"，评审 1 称零消费者——grep 核实仅 message-controller 引 `streamEvents`，re-export 确无消费者，删除（评审 1 正确）。
- 历史遗留登记：settings provider 语义问题非本 PR 引入，列入上方遗留待议。

## 验证

- `npx tsc --noEmit`（后端 + web）通过
- `npm run lint` 通过
- `npx vitest run`：86 文件 / 1051 测试全绿（含合并最新 origin/main 后复验）
