---
id: F20261126corph
title: "Connector 崩溃动作回收与 stdout 反压健壮性"
summary: "修复 connector SIGKILL 后 shell 动作无人回收及 stdout 不排水时主循环冻结：复用既有 boot sweep 和动作台账记录真实进程组与启动时间，经身份校验后回收旧纪元进程；日志改为有界异步写并明确降级计数。保持 unknown 与不自动重放语义。"
change_type: bugfix
capability_test: "n/a: 纯确定性进程、台账、TTY 与 WebSocket 行为，无 LLM 参与；由 A 类单测、真实异常链和 PTY 验证覆盖"
created_in_conversation: 6af46649-f93f-4c5b-a6d2-245a4ed33e9f
created_at: 2026-11-26T10:54:23+08:00
tags: [connector, process-group, crash-recovery, stdout, backpressure]
modules: [connector, execution]
intent:
  problem: "connector 被 SIGKILL 后设备侧 shell 进程组继续运行且既有 boot sweep 无回收目标；stdout 接不排水 PTY 时同步日志写冻结心跳、重连和信号处理。"
  expected_effect: "旧 boot 的 shell 进程组在启动清扫时经 PGID 与进程启动时间核对后被回收并留下台账证据；新 boot 和身份不匹配进程不被杀，动作仍为 unknown 且不自动重放。真 PTY 反压下心跳与 SIGTERM 退出继续工作，日志有界丢弃并可审计。"
  verify_by:
    type: behavior_check
    evidence:
      - "tests/connector/shell-action-executor.test.ts：真实动作启动后台账记录动作 PGID 与启动时间"
      - "tests/frameworks/execution/ledger/sqlite-action-ledger.test.ts：旧 boot 精确回收、身份不符与新 boot 保护"
      - "tests/connector/logger.test.ts：反压期间有界降级、恢复汇总与写错误停用"
      - "工作区 orphan-before/after 与 pty-before/after：同一异常脚本修复前后对照"
---

# Connector 崩溃动作回收与 stdout 反压健壮性

## 背景与预注册

任务要求独立核实 `#2015` 与 `#2012`，不照 issue 候选方案直接实现；边界是不改 hub/SSE、不做 Docker、不改变 unsafe 不自动重放语义。

- 预注册 `#2015`：预期根因是派生动作未纳入可在崩溃后回收的进程组/台账。成立证据为 SIGKILL 后子动作仍存活且重启无精确回收；若现有机制能仅回收旧 boot 动作则放弃。
- 预注册 `#2012`：预期 stdout 同步写阻塞主循环。成立证据为真实不排水 PTY 下 heartbeat/exit 超时；若主循环仍响应则放弃该假设。
- 预期 vs 实际：两项均命中。SDK 已有独立进程组，缺的是 PGID/启动时间入账及 boot sweep 回收，不需要另造执行引擎；TTY 同步写由真实 sample 栈直接确认。
- **第二轮预注册 `#2012`（续）**：第一轮把同步写改为 `fs.write(fd=1)` 异步有界队列后心跳恢复，但真 PTY 下 SIGTERM 后 3 秒未退出（pty-after.json `exitCode=-9`，外部看门狗 SIGKILL）。第二轮假设：日志目的地（stdout/PTY）本身就是反压源——只要日志仍写 PTY，任何形态的写都会有人卡在内核（同步卡主循环/异步卡线程池），`process.exit()` 等 libuv 线程池排空时被卡住的 worker 拖死。成立证据：修复后同脚本 3 秒内干净退出且心跳存活；不成立则回退到第一轮形态并另行处理退出路径。
- 预期 vs 实际（第二轮）：命中。修复后心跳存活、SIGTERM 3 秒内干净退出（rc=0）、offline 帧送达、日志落文件，三连跑稳定。

## 修复前失败证据

证据目录：`/Users/orca/ai/otter-buddy/data/workspaces/6af46649-f93f-4c5b-a6d2-245a4ed33e9f/`。

### 孤儿动作（orphan-before.json）

1. 以真实 `ShellActionExecutor + SqliteActionLedger` 启动长期 Node 动作，动作输出自身 PID。
2. SIGKILL connector fixture，随后用同一台账执行新 boot `open()` sweep。
3. 结果：动作 PID `74393` 在 SIGKILL 后及 sweep 后均存活；`ps` 为 `PPID=1, PGID=74393`。台账行 `pid=74391`（connector fixture PID），sweep 仅 `markedUnknown=1`。测试残留已按该专用 PGID 清理。

### stdout 反压（pty-before.json / pty-before-sample.txt）

1. 真 connector 连接真实 WSS fake hub；hub 完成 hello 后发送 3000 个 error 帧产生日志洪峰。
2. connector stdout/stderr 接 `pty.openpty()` slave，master 全程不读取。
3. 20 秒内心跳 `0`、offline `0`；SIGTERM 后 3 秒不退出，只能 SIGKILL。
4. `sample` 栈：`node::StreamBase::WriteString → node::LibuvStreamWrap::DoTryWrite → uv__try_write → write`。

同一脚本保留为修复后对照，不以新断言替代旧失败证据。

### stdout 反压第二轮（第一版修复不完整的证据：pty-after.json）

1. 同一 PTY 洪峰脚本：心跳恢复（20 秒内 1 拍）、offline 帧发出——第一轮异步化生效。
2. 但 SIGTERM 后 3 秒未退出，`exitCode=-9`（外部看门狗 SIGKILL）——优雅退出链卡死在 `process.exit()`。
3. `sample` 栈实锤：主线程卡 `uv__threadpool_cleanup`（等待 libuv 线程池排空），线程池 worker 卡 `write` syscall（fs.write worker 阻塞在无人消费的 PTY write 上，永不完成）。
4. 五组对照实验（同框架：真 PTY、master 全程不读）系统排除所有「继续写 PTY」的路径：

| 写通道 | 主循环心跳 | process.exit() | 结论 |
|---|---|---|---|
| `fs.write` 异步（第一轮形态） | 活（49 拍） | 挂起→SIGKILL | worker 卡内核，退出被拖死 |
| `tty.WriteStream(1)` | 冻结（0 拍） | — | 否决 |
| `net.Socket/Pipe({fd:1})` | — | — | `ERR_INVALID_FD_TYPE: Unsupported fd type: TTY`——libuv 拒 TTY fd，否决 |
| `worker_threads` 承载写 | 活（9 拍） | 5 秒不退（exit 事件已跑） | 退出路径 join 线程，否决 |
| `open("/dev/fd/1", O_NONBLOCK)` 重开 | 活 | 第 2 次 write 卡死 | macOS TTY 对 O_NONBLOCK 不保证 EAGAIN（POSIX 实现定义），非阻塞路线整体证伪，否决 |

实验脚本与逐拍日志：工作区 `pty-exit-experiment/`（child*.mjs/run*.py + exit-stuck-sample.txt）。结论：唯一治本路是让日志目的地本身不是反压源。

## 目标

- T1：shell 动作启动时，既有台账记录独立 PGID 和 OS 进程启动时间。
- T2：旧 boot sweep 对 shell 行先核对 PGID 与启动时间，匹配才发 SIGKILL；结果写入既有 unknown 行，不自动重放。
- T3：缺启动时间的存量行、PGID 已复用、当前 boot 行均不误杀；不能安全回收时留下明确未回收原因和 PGID。
- T4：stdout 不排水时主循环、心跳和优雅退出仍可用；日志队列有界，恢复后报告丢弃数，写错误后停用 stdout 日志。
- T5：真实 alpha 异常链、相关单测/全量回归、build/lint/intent/锚点闸和 CI 均可复验。

## 非目标

- 不改 hub/SSE、协议帧、执行机选择、自动重放或 `unknown` 语义。
- 不做 Docker/ECS，不引入常驻 watchdog、新恢复服务或人工 Web 清理按钮。
- 不承诺回收用户命令自行 `setsid` 脱离原动作 PGID 的第三方进程。

## 设计取舍

| 取舍 | 决策 | 被否替代 | 理由 |
|---|---|---|---|
| 动作身份 | 复用台账 `pid` 存 shell PGID，新增 `process_started_at` 精确校验；旧行无该值则只转 unknown | 只存 PGID 并按 PID 直接 kill | PGID 会复用；启动时间令牌防止误杀无关进程 |
| spawn 观测 | 对 pi-durable 1.5.0 加可选 `onSpawn` 回调补丁，保持其他调用方行为不变 | 读取 SDK private `activeChildPids`、轮询 `ps` 猜子进程、重写 shell executor | private/轮询有竞态且并发动作归因不可靠；重写会复制 timeout/spill/输出语义 |
| 回收时机 | 既有 `sweepStaleBoot` 在裁决 shell unknown 前执行同步身份校验与进程组 kill | 新后台 watchdog 或下次定时任务 | 崩溃后唯一确定时机是下次启动；不新增生命周期与常驻进程 |
| 回收失败 | unknown 行记录 `processGroupRecovery` 状态和原因，不伪称已杀，不重放 | 忽略失败或改 interrupted/failed | 副作用仍不可判定，必须转检查 |
| stdout | 运行日志写本地文件 `~/.otter/connector/connector.log`（与 device.json/instance.lock 同目录），保留单在途+最新 pending+dropped 计数与写错误停用；启动时超 5MB 截断 | 继续 `fs.write(fd=1)` 异步（第一轮形态）、`tty.WriteStream`、`net.Socket` 换句柄、`worker_threads`、`O_NONBLOCK` 重开 fd、日志转发子进程 | 第一轮实测：PTY 上异步写卡线程池拖死 `process.exit`（pty-after.json exitCode=-9 + sample 栈）；其余路径见「第二轮实验矩阵」逐项证伪；转发子进程会在 SIGKILL 时制造新孤儿；文件是唯一不反压目的地，代价是终端不再刷运行日志（启动时 stderr 通告一次路径） |
| stderr | 保留现有启动/致命错误路径 | 所有输出统一重写 | 洪峰入口是 stdout 业务日志；致命路径写后即退出，不改变其语义。边界如实声明：极端反压下 fatal 一行仍可能阻塞——但该路径进程本就即将退出，且单行非洪峰，不比旧世界更糟 |

### 机制识别检查点

- 新配置/状态生命周期/后台进程/外部协议消息：否。
- 持久化：是，既有台账新增 `process_started_at` 列，不建新库表。
- 持久化决策分支与跨模块路径：是，spawn → 台账及 boot sweep → OS 进程组回收。

机制识别清单命中三项（新持久化列 `process_started_at`、新决策分支 spawn→同步落账、新跨模块路径 ledger→`process.kill`）——按声明词表如实取 `Modification-Class: mechanism-addition`。同时说明它与既有语义的关系：本修复补齐的是**既有** SDK 进程组、boot epoch、running 台账和 boot sweep 的同一条崩溃恢复语义，没有建立独立恢复控制面或第二套动作状态（新增的列/分支/路径都是这条语义此前缺失的环节）。按 issue 驱动前置纪律与 mechanism-addition 配套要求回答四问。

### 机制预算四问

1. **谁需要它**：远程执行动作的搭档与维护 connector 的大獭/检视獭；前者要求离线后设备不继续产生副作用，后者需要可核查的进程回收和日志降级证据。
2. **失败后果**：孤儿动作会在 hub 判离线后继续写文件/发请求；误杀则会损害新 boot 或无关用户进程。stdout 冻结会使设备假在线、无法心跳/退出，只能强制杀进程。
3. **后续机制**：PGID 可能复用、leader 可能退出而子进程尚存、台账可能缺新列或写失败；分别用启动时间比对、无 leader 不杀并明示、就地迁移与 best-effort 日志处理。日志写可能永久不排水或报错；队列有界、只留最新并计数，错误后停用，不影响动作与信号。
4. **退役条件**：若 pi-durable 原生暴露受支持的 spawn 观测与跨 boot 进程身份回收，并覆盖同等测试，则删除本地 onSpawn 补丁与回收分支；若 connector 日志全面改用有界异步结构化日志基础设施，则删除本地 logger。台账启动时间列作为历史审计证据保留，不做破坏性退役。

### 准入三问与负面清单

1. 决策者不变：是否发起动作、是否重试 unsafe、是否接受残余风险仍归搭档/既有恢复流程；boot sweep 只回收旧 boot 已拥有的进程。
2. 机械守卫：真实子进程/PGID/启动时间、旧 boot/新 boot/复用保护、真 PTY 心跳与退出均由 A 类测试和异常脚本验证；「是否治本」及残余风险标半机械+异体审。
3. 深潜成本降低：unknown 行直接包含 PGID、启动时间、回收结果/拒绝原因；修复前后使用同一脚本和 sample 栈对照。
4. P0 负面清单：不命中；无自动巡检替人盯、随机审计、产出限速、同类跳过或智能预审。

## 影响范围与代价

- connector shell 台账、SQLite 就地列迁移、pi-durable 安装补丁、connector 日志写路径。
- **日志去向变化**：运行日志从 stdout 改到 `~/.otter/connector/connector.log`。hub 侧 supervisor 对 connector stdout 的消费管道（hub-connector-supervisor `child.stdout.on("data")` 日志聚合）将变为静默——观测改从文件读取；supervisor 代码不变（on("data") 无数据即不触发，无副作用）。首启向导交互（isTTY 人工在场场景）与 stderr 致命错误路径不变。
- 残余风险（如实声明）：本地文件写入在文件系统 hang（NFS/外置盘断连）场景理论上仍可能拖慢写回调——概率远低于 PTY 反压（真实常态：终端 XOFF 流控/Ctrl+S 即可触发 PTY 不排水），接受；文件打不开时 logger 停用（宁无日志不冻结）。运行中不做轮转，仅启动时超 5MB 截断（单实例日均 MB 级）。
- 新列需要随包升级；旧库启动时自动补列。SDK 升级必须保留/上游化 onSpawn 补丁，`check-sdk-patch` 机械检查。
- 回收只覆盖原 SDK 动作进程组；命令主动脱离进程组仍是明确边界。同步 `ps` 仅对旧 boot running shell 行执行，不在动作热路径轮询。
- 负向验收：不得绕过既有进程组、boot epoch、unsafe 不自动重放或 ledger 五态保护；不改变非 shell 文件 hash 恢复。

## 机械验收

| 场景 | 操作 | 预期结果 |
|---|---|---|
| PGID 入账 | 启动长期真实 shell 动作，轮询台账 | running 行 pid=动作 PGID（非 connector PID），processStartedAt 非空 |
| 崩溃回收 | SIGKILL fixture 后新 boot open | 旧动作组被回收；unknown 行含 signaled 与 PGID；无重执行 |
| 复用保护 | 伪造旧行指向不同启动时间的现存进程组 | 不发 kill；进程仍活；unknown 行含 identity_mismatch |
| 缺令牌保护 | 旧版行只有 connector PID、无启动时间 | 不杀该 PID；unknown 行含 missing_start_time |
| 新 boot 保护 | 当前 boot running shell sweep | 不 kill、不改状态 |
| 日志有界 | 注入不返回的 async write，连续 log | 仅一项在途和一条 pending；无同步 write；drop 计数准确 |
| 日志恢复/错误 | 释放 write / 返回 EIO | 恢复输出 dropped 汇总和最新行 / 后续不再写文件 |
| 日志目的地 | 启动真 connector 连真 hub | stdout 无运行日志；`~/.otter/connector/connector.log` 产生且含结构化行；启动 stderr 通告路径 |
| 真 PTY | 重跑 pty-before 同脚本（repro-pty-lifecycle.py） | 20 秒内至少一次 heartbeat；SIGTERM 3 秒内退出（rc=0）并发送 offline；三连跑稳定 |
| 真 alpha | 真 alpha hub 实例（隔离端口/数据根）+ 真配对 + 真连接器进程（repro-alpha-chain.py） | 配对核销上线（协议 v2）；SIGKILL 后 hub 侧秒级落 offline（disconnect_reason=heartbeat-timeout）；重启重连新会话；重启后 SIGTERM 干净退出 |
| 真 alpha 动作回收 | 真 ShellActionExecutor + 真 SqliteActionLedger 跨 boot sweep（repro-orphan-lifecycle.py） | SIGKILL 后孤儿动作仍存活 → 新 boot sweep 回收；unknown 行含 recovery=signaled 与 PGID；无自动重放 |

## Rollback

Revert 本特性提交并重新安装/构建即可恢复旧行为。新增 `process_started_at` 列保留为无害历史证据，旧代码不读取；已经落 unknown 的动作不会被自动重放。回滚后孤儿回收与反压保护消失，需按台账 PGID 人工核查残留动作。

## Verification

### 证据清单（工作区：data/workspaces/6af46649-f93f-4c5b-a6d2-245a4ed33e9f/）

| 证据 | 文件 | 内容 |
|---|---|---|
| 孤儿链修复前 | orphan-before.json | SIGKILL 后动作存活，sweep 仅 markedUnknown、无回收 |
| 孤儿链修复后（第一轮） | orphan-after.json | sweep 后进程消失，unknown 行 recovery=signaled + PGID + 启动时间 |
| 孤儿链修复后（第二轮复跑） | orphan-after-round2.json（repro-orphan-lifecycle.py 生成） | 日志文件化重构后同链复绿：aliveAfterSigkill=true → aliveAfterBootSweep=false |
| PTY 链修复前 | pty-before.json + pty-before-sample.txt | 心跳 0、offline 0、SIGKILL 收场；sample 栈 WriteString→write |
| PTY 链第一轮（不完整） | pty-after.json | 心跳 1、offline 1，但 SIGTERM 3 秒未退 exitCode=-9 |
| PTY 链第二轮 | pty-after-round2.json（+run1/run2 三连） | 心跳≥1、SIGTERM 3 秒内 rc=0、offline=1、日志文件产生（212KB） |
| 退出挂起根因 | pty-exit-experiment/（5 组实验 + exit-stuck-sample.txt） | 主线程卡 uv__threadpool_cleanup、worker 卡 write；五条替代写通道逐项证伪 |
| alpha 真实链 | alpha-chain-after.json（repro-alpha-chain.py 生成） | 真 hub 配对→上线→SIGKILL→hub 秒级落 offline（heartbeat-timeout）→重启重连→SIGTERM 干净退出 |
| 回归 | npm test | 6986/6986 全绿（pretest 含 eslint）；build:connector + closure check PASS；lint:docs 通过（3 存量 warning 不阻断）；check-sdk-patch verified |

**pre-existing 声明核查**：本轮无「pre-existing 失败」类声明——全量回归全绿，无需 stash 基线对照。

### alpha 链覆盖面与边界（如实声明）

alpha 链覆盖「真 hub 进程 + 真配对 + 真连接器 + 异常（SIGKILL）+ hub 断线收尾 + 重启恢复」；hub 下发动作经对话层/执行机选择体系（LLM 参与），不在本修复边界内——动作进程组回收语义由 orphan 链（真 executor + 真 ledger）验证，两者组合构成完整异常语义。日志文件化后 supervisor 对 stdout 的日志聚合通道静默，已列入影响范围。

### 最简实现检查

- 日志文件化：`src/connector/logger.ts` 一个文件 + main.ts 接线三行，无新依赖（node:fs/os/path 内置）。
- 未引入：常驻 watchdog、新恢复服务、第二套日志框架、配置面扩张。
- CI 锚点：PR 建立后由 CI 跑 check/test/anchor 闸，待补 CI run 编号。
