---
id: F20261105pidrx
title: pi-coding-agent → pi-durable 1.5.0 原生 runtime 迁移
change_type: refactor
capability_test: "n/a: runtime 适配以真实 Harness/临时 SQLite 行为测试验证，非 prompt 能力变更"
intent:
  problem: "将 otter 推理与 session 持久化从 coding-agent 切换到 durable，同时保持单 owner 与工具安全边界"
  expected_effect: "真实 Harness 能执行自定义工具并保存 checkpoint，进程中断后不重复执行 unsafe 工具"
  verify_by:
    type: behavior_check
created_at: 2026-11-05
created_in_conversation: b4e05359-7a17-4478-8774-162360569279
causal_links:
  - F20260716sq6e
  - R20260810piab
  - F20260912recr
  - F20261009rsmo
  - F20261014cwsp
  - F20261029pcha
summary: 以 pi-durable SQLite session、单 writer、unsafe custom tool 和模型策略替换 coding-agent 推理 runtime；保留 otter 对话/调度/审批领域，关闭旧 JSONL 重启恢复与双 owner。
---

# pi-durable 原生 runtime 迁移

## 目标与决策

2026-11-05 12:43 搭档 chen 原话：「我还是认为durable是趋势，所以咱们还是必须切换过去。但如你所言，这个动作很大，所以，你现在来，专门创建一个环境来做好这件事，但不要影响主目录、影响main分支」。

本特性替换 `AgentGateway` 内部的 coding-agent 推理与 session 持久化，不是增加一个可回退到 coding-agent 的旁路。验证在独立 worktree、临时数据库与独立 alpha 实例中完成；不启动/停止生产服务，不修改生产数据库，不由实现者合入 PR。

- 使用上游 **pi-durable/pi-ai 1.5.0** 的公开 Harness、Node SQLite storage、models、tools、watch 和 prompt/steer/abort API。
- 对话事实、invoke/attempt、matters/signals/yield、track_work、审批门及 SSE 仍归 otter；durable 不获得这些领域的写入权。
- otter 仍是同一獭同一 invoke 的 admission owner；durable 是该 invoke 内的 session owner。重启不启用 durable 自动恢复未完成模型轮，也不重放旧 invoke；新显式调度打开 durable checkpoint 后继续新轮。
- 旧 JSONL 只用于已有重启换世的只读交接切片，不导入新 store、不继续写入。
- ResourceLoader 只保留为现有 profile/skills/MCP 的读取来源；运行时 prompt 和工具由 durable registry/extension 接管。skills 注入与 tool_search 使用公开 schema/section，不加载旧 coding-agent extension。

## 非目标

- 不迁移独立平台/IM 的 coding-agent session，不更改对话/调度领域表。
- 不引入 coding-agent 执行 fallback、并行写双份 session 或自动 durable crash replay。
- 不承诺解决上游 memory tools、provider transport 或默认 extension 的独立缺陷。
- 不把 mock 行为测试称作真实 provider 端到端验证。

## 模块与公开接口

| 模块 | 职责 |
|---|---|
| `frameworks/agent/durable-model-runtime.ts` | pi-ai `createModels`、模型唯一解析、retry/timeout/thinking；复用现有自定义 provider 注册事实源 |
| `frameworks/agent/durable-tool-registry.ts` | OtterTool/invokeContext → durable `ToolRegistration`，统一 `replay:"unsafe"`、参数/输出错误映射 |
| `frameworks/agent/durable-session.ts` | pool entry、registry、conversation/watch、消息与 token/compaction 适配、生命周期关闭 |
| `frameworks/agent/durable-event-stream.ts` | 公开 watch parts → 现有 `AgentStreamEvent`，工具开始/结束先于副作用的可观测事件 |
| `pi-session-factory.ts` | 保留 invokeContext、epoch/breaker/bash/loop-block hooks；删除 coding-agent 建 session/绑定/内存镜像与会话锁（单主人归部署层，见下方「单主人与部署前置」） |
| `resume-interrupted-service.ts` | 显式只读 checkpoint 继承与防双跑；不依赖持久化 scheduler 重放旧模型轮 |

核心持久化数据归属 durable：`data/durable-sessions/<otterId>.sqlite`（含 harness metadata、conversation、entries、tool tasks）。每个獭一个独立 storage/单 writer，不跨獭写 conversation；每条 invoke 的 `currentInvokeId` 通过 extension runner 的 request-scoped AsyncLocalStorage 与工具 entrypoint 绑定，拒绝缺失 ID 的写工具。

## 机制识别与预算

**机制识别**：涉及新持久化存储、新跨模块调用路径，且替换既有执行/恢复机制。分类为 `deletion`（`mechanism-addition` 的识别四问仍答，重对抗审视必需）。

1. **禁止**：旧 JSONL invoke resume + durable 自动重放并存；缺 `currentInvokeId` 调用写工具；durable 写 otter 领域 DB；主目录/main/生产服务操作。
2. **持久事实**：旧 otter invoke/conversation/recovery 事实不变；durable checkpoint 仅记录模型对话与工具 attempt。新事实能回答会话在哪个 checkpoint、tool 是否可重放、压缩阈值与模型 retry 配置。
3. **解释方式**：watch/part 是流式输出，tool hook/工具错误/abort/entry usage 是接管信号；watch 只读，不能代替 dispatcher 的 yield/entry 持久化。
4. **删除条件与验收**：无 coding-agent fallback、无双恢复、旧 JSONL 不被追加；公开 API 行为测试覆盖 custom tools、流式/tool event、abort/steer/followUp、retry/compaction、crash reopen 与 unsafe replay；build/test/lint 通过，真实 provider/实 crash 未跑则明确未验证。

## 设计取舍与淘汰路线

- **不保留 coding-agent 执行 fallback**：会形成双 owner、双 token/压缩与双恢复事实源；研究建议的保留线上路径已被本次搭档明确迁移决策覆盖，但 Experimental 风险仍由 PR 明示。
- **不让 durable 恢复 scheduler 自动重放**：工具 replay 默认 unsafe，重启由 otter 显式交接；避免旧 invoke 新 invoke 同时调用 speak/外部副作用。真实 LLM request 的断点恢复因此保留为残余风险，不伪称已完全接管。
- **不把旧 JSONL 导入新模型上下文**：公开 schema 不支持无损迁移完整 reasoning/tool/usage；已有换世切片保持只读。
- **不直接移植 coding-agent extension**：改为 otter prompt 聚合与 durable section/tool search；MCP 读取器与既有重连策略保留，若尚无 durable MCP server bridge 则作为验收阻断而非静默删功能。
- **不改生产 DB**：验证仅临时 SQLite、独立 dataDir、独立端口。

## 保护接管检查表

| 被替换物 | 原保护不变量（含反向/异常路径） | 消费者 | 新机制接管 |
|---|---|---|---|
| AgentSession prompt/subscribe | 完整 system prompt；流式文本和工具开始/结束；abort 与 settled 不混淆 | invoker、SSE、breaker、capability tests | durable sections + watch mapper；abort 等 conversation 状态；hook 在工具执行前检查 |
| SessionManager JSONL | session 链、重启换世切片、in-memory prompt 镜像；不可跨獭打开写 | pool、slicer、profile token | durable SQLite 每獭 store；slicer 仅旧档案；新 prompt 由 checkpoint 持有 |
| customTools + tool wrappers | 类型化 args、toolContext、安全器与审批工具；缺 invokeId 禁副作用 | dispatcher、tools、工作账本 | durable custom tool adapter，统一 unsafe，entrypoint scope 校验 |
| compaction/usage | 阈值策略、剩余量、token delta、client identity | context/progress UI、退避 | durable AgentTurn usage/threshold + pi-ai `calculateContextTokens`；negative/compaction 单测 |
| retry/abort/steer/followUp | 网络/超时与 provider 重试、取消、打断、排队、失败清理 | orchestrator、gateway、dispatcher | pi-ai retry policy + durable prompt/steer/followUp；失败仍由现有 orchestrator 分类 |
| 重启恢复 | 单 invoke 单 owner；崩溃不重复副作用；checkpoint metadata 不丢 | resume service、otter locks、matters | 显式 recovery + 持久 checkpoint；禁旧自动 replay；跨进程 admission lock 验收待测 |
| bash/loop-block/guard | 工具调用前拦截；外部调用与循环块取消即时 | guards、healing 台账 | durable beforeTool hook，直接复用现有 hook 检查；映射 block/tool_error |
| 熔断器/看门狗/编排守卫（检视处置补登） | per-event 工具执行看门狗（maxPerEventTimeMs）、滑窗/连续重复熔断（steer→terminate）、编排越权 steer、黑名单（loopBlockedTools） | circuit-breaker-helpers、activeEntry abort 链 | **接管**：DurableSession.subscribe 多播事件总线 + prompt 内 watch→sink 单一事件源，attachCircuitBreaker/attachOutputGuard 原样消费同一事件流（回归测试见 durable-runtime.test.ts 看门狗用例）；beforeTool 不再直查 breaker（防滑窗双计数） |
| 输出退化/滑动/首字节超时（检视处置补登） | text/thinking delta 重复检测、流式滑动超时、首字节超时、tool/compaction 暂停 | output-guard、streaming 超时 abort | **接管**：同上事件链恢复 delta 喂入与 pause/resume；首字节计时器（armFirstByte）随事件链 arm/解除。compaction 感知已修复（见下文）：pi.live 文档边沿检测重建 compaction_start/end 事件，outputGuard 压缩期避让恢复。auto_retry pause 仍无事件源（durable 无该事件），以 tool pause 兑住主路径 |
| skills/extensions/MCP | profile 可见；system prompt/skills 注入；工具发现；MCP 与故障策略 | query-otter-profile、prompt provider、tool_search | loader 只读；durable section+tool_search；MCP server bridge 不得静默省略 |

## 验收 / 负向接管

- 行为测试验证同 input 的流式顺序与 tool call id、工具执行结果、abort/steer/followUp、steering 中断及 compaction。
- 重启测试：崩溃后 checkpoint 可读、工具副作用不重放；旧 JSONL mtime/内容不变；同獭 invoke 不双跑；新 turn 可打开 checkpoint。
- 负向：缺 invokeId、guard block、tool throw、abort、provider retry、压缩失败/边界、storage 关闭与 reopen。
- 外部能力：MCP bridge 若公开 API 不能承载，停止该点并报告 file:line 和已试清单，不宣称完成。
- PR 附机器锚点与「未复验」分项；CI 修复后由独立检视獭对抗审视，实现者不自审通过。

## 当前验证记录

- 基线：`5300d8e0`；分支：`feat/pi-durable-runtime`；所有修改仅在专用 worktree。
- 真实 Harness + 临时 SQLite：custom tool/watch、错误与 terminate、unsafe reopen 不重放、owner 竞争、abort、steer/followUp、MCP stdio、retry/compaction、缺 invokeId 拒绝副作用，共 10 条专项行为测试通过（含真实进程中断）。
- 真实进程中断：子进程在工具内被 SIGKILL，重启后重开 checkpoint（锁已删，无 stale 窗口）；工具副作用计数仍为 1，未重复执行。
- 全量：`npm run lint`、`npm run build`、`npm test -- --reporter=dot`（432 files / 5681 tests）通过。
- 未验证：真实外部 LLM provider、生产 alpha 实例、真实用户会话切换；MCP OAuth 自动登录与动态 extension 注册未验证，不能宣称全量兼容。
- 恢复 owner：otter invoke/admission 仍负责领域恢复；durable reopen 对未完成任务显式 abort，不允许旧 invoke 与 durable 自动 replay 双跑。

### 单主人与部署前置（2026-11-06 搭档定调：锁移除）

- **会话单主人是运行环境责任，海獭不做锁**：原 proper-lockfile 文件锁（含 60s stale 判死窗口，SIGKILL 快速重启会误拦一次 resume）已全链路移除（commit eb43a189），alpha 实测：SIGKILL 后 8 秒极速重启，中断 resume 直接成功（25s settle done）。
- **删锁后的双开防护矩阵**：单实例由部署层保证（launchd/systemd Label 单实例 + 崩溃重启退避），数据完整性由 sqlite busy_timeout + pi-durable commit 一致性校验兑底。语义层双驱防护依赖部署层配置。
- ⚠️ **部署前置项（未配置前勿对同一数据域双开）**：主服务当前 nohup 裸跑，launchd/systemd 单实例配置**尚未落地**，属合并后运行环境配置项；配置就绪前，同域双进程驱动同一会话目录无锁拦阻，仅剩存储层拒绝冲突写入。
- #1791 契约条目：「会话单主人 = 运行环境责任，海獭只声明依赖」——云化（Durable Objects 等）时由平台原生满足。
- 旧 JSONL：仅 `.jsonl` 档案可读作交接切片；新执行不写旧 JSONL，不导入新 durable store。

## 对抗审视处置（PR #1783，Runtime检视獭 2026-11-05）

上游审视报告：`fact dc120c3d`（2 严重 + 2 建议，全部处置于本 PR）：

1. **严重 1（看门狗/编排守卫静默失活）→ 接受并修复**：根因是 `DurableSession.subscribe` 单监听器被 factory 的 durableForwarder 覆盖且 `emit` 无调用方，事件通道整体死路——波及面比检视点名更广（熔断器、maxPerEventTimeMs 看门狗、orchestrationCheck、outputGuard 退化检测/滑动超时、首字节计时器的解除全部失活）。修复：① subscribe 改多播 Set（listeners），emit 有真实馈送；② prompt 内 watch→sink 单一事件源，派生事件先 `this.emit(event)`（guards 消费）再分发调用方 stream——不依赖 factory 包装，直调 prompt 的路径守卫同样在场；③ 删除 beforeTool 的自制 breaker 段与 configureGuards 接线（防与事件链双计数滑窗，避免假熔断/假 terminate）。回归：看门狗用例（maxPerEventTimeMs=300ms 触发 abort、signal 取消、guardAbortReason 断言）。
2. **严重 2（SIGKILL 断言零判别力）→ 接受并修复**：`split("\\n")` 改按非空行计数（`split("\n").filter(trim)`）；负对照已验：新断言 1 次=1、2 次=2，旧断言恒 1（重放不会被拦）。
3. **建议 1（PR 证据锚点过期）→ 接受并修复**：本处置 commit 后 PR body 锚点更新为本 head + 绿跑（回读输出见 PR）。
4. **建议 2（恒假死代码）→ 接受并修复**：`_restoreOrCreateSession` 的 `stored.sessionFile !== sessionFile` 恒假分支删除，注释澄清 create() 已写注册。

### 残余差异（诚实披露，不伪称完全接管）

- **compaction pause（已修复，2026-11-06）**：此前记录「durable 1.5.0 无 isCompacting 公开 API，也无 compaction 事件」为迁移时误判——实际上 durable 把压缩状态写入 pi.live 文档（compactions 列表），随已订阅的 watch 视图分发，是迁移时只取 entries 丢弃 docs 导致信号断链。修复：watch 回调边沿检测 pi.live.compactions，重建 compaction_start/end 事件流经 subscribe 总线，outputGuard 压缩期避让恢复（回归守卫：durable-runtime.test.ts「压缩感知」用例）。
- **auto_retry pause（已修复，2026-11-06，第二次误判修正）**：此前记录「durable 无 auto_retry 事件」为第二次误判——实际 pi.live.generation.retry（{at, error}）随 watch 分发，退避中出现、恢复时消失（generation.js:364/177 覆写机制）。修复：边沿检测重建 auto_retry_start/end（含 errorMessage 透传，恢复 #764 abort 归因观测窗信号源），走 forwardCompactionEvent 双通道。回归守卫：durable-runtime.test.ts「auto_retry 感知」用例（overloaded 可重试错误注入，双侧断言）。
- **误判模式教训（两条并入，2026-11-06 搭档批评）**：compaction 与 auto_retry 两次误判同模式——拿旧系统答案形状（旧事件名/旧属性名）在新系统里找不到即断言「无信号源」。正确方法（#1791 契约清单核查口径）：先问「durable 用什么机制解决此类问题」（答：一切瞬时通知统一入 pi.live 状态文档，随 watch 分发），再对照我们接没接。检视链结构性盲区：「妥协清单」被当诚实输入接受，无人质疑事实断言本身——后续对任何「无/不可/不支持」断言须源码级核实。
- **abort 是协作式**：工具 execute 永不 resolve 且不监听 signal 时，上游 abort handler 等待 owned work（scheduler `#waitingOn` 含自身），invoke 挂起不可强杀——与旧 SDK 同等限制（旧 600s 看门狗同样不能强杀死循环 promise），非本次迁移引入的回归。
- 守卫事件面经 DurableEventStream 派生（entry/ops → tool_execution_start/end、message_update），与旧 SDK 事件时序近似但非逐事件同构；极端时序差异（如部分提交窗口）未经真实 provider 验证。
