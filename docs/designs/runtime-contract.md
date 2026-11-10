# 海獭 ←→ 基座 Runtime 契约

> **用途**：pi-durable 升级时的对照清单。pi-durable 是 Experimental——API 会在版本间无通知变更（1.5.0 即有一波破坏性变更），每次升级前按本文档逐项核对，变更点对照契约测试回归。
>
> **由来**：pi-durable 迁移（PR #1783，2026-11-09 合入，特性文档 F20261109pidrx）实测沉淀。立项与收窄论证见 issue #1791 及其分析（搭档 2026-11-09 定调：基座更换是低频事件，契约化的主价值是**升级**安全网，不为「下次换基座」做通用抽象层）。
>
> **活文档**：随 pi-durable 升级与边界调整维护。

## 一、边界约定（三条）

1. **单主人**：同一时刻只允许一个进程操作会话存储。这个保证由部署层负责（launchd 单实例，见 `deploy/launchd/`），**代码里不做跨进程锁**（2026-11-06 搭档定调，proper-lockfile 已全链路移除）。进程内并发互斥保留 SimpleLockManager。
2. **事件形态**：海獭上层只消费自有事件形态（AgentSessionEvent 兼容流）；基座（pi-durable）原生事件格式只在转换层（`durable-event-stream.ts`）翻译，**上层代码不直接 import 基座事件类型**。基座状态类信号（compaction / auto_retry）不是推送事件，是写进 pi.live 状态文档、由边沿检测（`detectLiveEdges` / `detectRetryEdge`）重建为事件——升级时核对 pi.live 文档结构变化。
3. **部署形态**：launchd 托管单进程，**不自启、不自动拉起**（搭档定调：「有时候我就是要关闭进程」）。重启恢复依赖 durable 原生 checkpoint（崩溃后重开精确续跑，副作用单次执行），不依赖进程守护。

## 二、能力对接清单

海獭需要什么 ↔ 基座怎么给。升级 pi-durable 时逐行核对右侧两列是否仍成立。

| # | 海獭需要的能力 | pi-durable（现行 1.5.0） | 承载文件 |
|---|---|---|---|
| 1 | 会话生命周期 | DurableSession 每獭一 sqlite；create 同事务写 otter_configs；换世开新世代 | pi-session-factory / durable-session |
| 2 | 推理执行 | conversation.submit/prompt + watch 事件流 | durable-session / durable-model-runtime |
| 3 | 流式事件 | DurableEventStream 从 entries/ops 派生；compaction/auto_retry 从 pi.live 状态边沿检测重建 | durable-event-stream + detectLiveEdges |
| 4 | 工具注册 | ToolRegistration 适配（replay:unsafe 统一），重名拒载 | durable-tool-registry |
| 5 | 工具搜索 | DurableToolSearch（SDK 原生 deferred） | durable-tool-search |
| 6 | MCP 桥 | pi-mcp 公开 client，旧私有 patch 基建已退役 | durable-mcp |
| 7 | 上下文压缩 | 应用层合成通道保留 + SDK 兜底；pi.live.compactions 感知 + compactionFailure 失败上报 | pi-session-factory + detectLiveEdges |
| 8 | 自动重试 | pi.live.generation.retry 边沿检测重建事件 | detectRetryEdge |
| 9 | abort | 协作式；内置 bash 多 SIGKILL 进程树 | durable-session |
| 10 | steer 注入 | conversation steer + busy 队列降级 | durable-session |
| 11 | 崩溃恢复 | SDK 原生 checkpoint 精确续跑，副作用单次（迁移核心动机） | recoverAfterReopen |
| 12 | 会话互斥（进程内） | SimpleLockManager 保留；跨进程单主人归部署层 | deploy/launchd |
| 13 | 模型接入 | createModels + provider 注册（pi-ai 直连） | durable-model-runtime / models-factory |
| 14 | 前世档案读取 | 当前世代由公开 Storage.findLatestHeadMarker + scanEntries 读取；SessionEntry 投影与历史 JSONL 兼容隔离在适配层 | durable-slice-source / session-slicer |
| 15 | 身份/system prompt 可见性 | otter section 每轮消费最新 systemPrompt + identityPrefix；wire 录音直接断言消费者所得 | pi-session-factory / model-visible-parity |

**本质变化**（相对 pi-coding-agent 时代）：事件通知 → 状态文档 + 边沿检测；退役三个包袱：私有 MCP patch / 自研 JSONL 重放 / 跨进程文件锁。

## 三、契约测试索引

契约的机器形态就是这批测试——升级后必须全绿。文件：`tests/frameworks/agent/durable-runtime.test.ts`（14 场景）、`durable-create-persist.test.ts`（2 场景）。

| 契约语义 | 测试场景 | 对应能力行 |
|---|---|---|
| 自定义工具经公开 watch 映射终端文本/usage | runs real custom tools... | 2/3 |
| isError 与 terminate 控制保留 | keeps isError and terminate | 4 |
| 重开不重复执行副作用工具 | reopens... without running the unsafe tool again | 11 |
| abort 后 checkpoint 可读 | aborts a running tool | 9 |
| 活跃期 steer/followUp 注入 | accepts steer/followUp | 10 |
| stdio MCP 真实桥接 | bridges a real stdio MCP server | 6 |
| 瞬时失败重试 + 压缩走公开 harness | retries a transient provider failure and compacts | 7/8 |
| **真实 SIGKILL 后重开不重放副作用工具** | reopens after a real process SIGKILL | 11 |
| 无 invoke owner 的副作用工具拒载 | rejects a side-effect tool without an invoke owner | 4 |
| 看门狗超时中止挂死工具 | restores the tool-execution watchdog | 4/9 |
| 同 session 二次 prompt 不炸「Watch already started」 | 同一 session 连续两次 prompt | 2/3 |
| 压缩期 pi.live 边沿触发 compaction 事件入总线 | compact 期间... 边沿触发 | 7 |
| 压缩失败上报 compaction_end(errorMessage) | 压缩失败上报 | 7 |
| retry 出现/消失边沿发 auto_retry 事件（双通道） | generation.retry... 边沿发 auto_retry_start/end | 8 |
| create 同事务写 otter_configs，getConfig 必中 | create() 写入的 session 映射... 同事务落库 | 1 |
| 真实 DB 层 SELECT 命中 otter_configs | 真实 DB 层验证 | 1 |
| 当前世代读取只依赖公开 Storage 契约 | durable-slice-source.test.ts 的 reset/compaction/分页与工厂接线 | 14 |
| 身份/system prompt 进入模型实际 wire 请求 | model-visible-parity.capability.test.ts 的 system 非空且含大獭 | 15 |

## 四、已知债（显式缓做记录）

- **AgentSessionEvent 类型自有化**：`sdk-invoke-port.ts` 等处的旧 SDK 类型 re-export，当前经 `durable-event-stream` 转换层结构性吸收，上层消费的是兼容流。自有化（定义海獭自己的事件类型，两处消费方切换）**缓到 pi-coding-agent 真退役时顺手做**——届时删除 14 处旧 SDK import，一并收编。
- **读侧 schema 耦合已消除**：F20261110grdls 起不再直查 entries/head/record；升级只需确认 Storage 公共查询语义与投影消费面，不得回退为消费者拼 SQL。
- pi-coding-agent 当前角色：**仅工具性借用**（ResourceLoader 只读、ModelRuntime 注册表、类型），「Durable 1.5.0 是唯一执行 runtime」（pi-session-factory.ts 注释）。退役收编时注意：静态 import 口径 14 处之外，model-runtime-registry.ts 另有类型引用/动态 import 各一处，一并处理。

---

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 大獭
