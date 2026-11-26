---
id: F20261126expab
title: "执行机资源池 PR-3 统一注册与设置页：实现、审视与验证接续"
summary: "承载 PR-3 相对 PR-2 主方案快照的全部原始增量；主方案与 main 一致，接续记录独立保存。"
doc_type: feature
change_type: feature
capability_test: "n/a: 本文档只迁移 PR-3 的既有实现、检视处置与验证记录；行为验证仍由原测试与 CI 承载"
created_in_conversation: 6af46649-f93f-4c5b-a6d2-245a4ed33e9f
from:
  - F20261126expot
causal_links:
  - issue:#1868
tags: [execution-machine, connector, web, documentation, stacked-squash]
modules: [frameworks/execution, usecases/conversation, interface-adapters/http, web]
created_at: 2026-11-26
intent:
  problem: "PR-1 squash 合入后，PR-3 不得再修改主方案历史快照，但统一注册制的实现、接管表、检视与真实验证记录必须保留"
  expected_effect: "主方案与 main 逐字一致；PR-3 原始文档增量在本接续文档完整可检索，历史文档闸在 PR-3 base 下通过"
  verify_by:
    type: static_only
---

# 执行机资源池 PR-3 文档接续

## 迁移关系

- 主文档：`F20261126expot`；本文件承载 PR-3 接续记录，不改写主文档已合入内容。
- 原始已审 PR-3 树：`90bc42bc887721ad57f49ee4cc187d3bd96ba818`；原始文档对比 base：已审 PR-2 `4ca36c0963d6a882532ff89bbb69d63fa5ecc70a`。
- 主文档在整理后恢复为 main `31e407341bb115fd6b90aae3a1b16e8b3880b7dc` 的版本。本层的 capability_test 口径、未决问题收口、实现清单、设计取舍、首轮检视处置、机制接管表、验收、负向验收与未覆盖边界全部迁到本文件。

## 保留方式

为避免人工摘抄造成语义漂移，下面原样保存「原始已审 PR-2 文档 → 原始已审 PR-3 文档」的 unified diff。新增内容、被替换旧句和原位置均保留；仅对 diff 文本自身的行尾空白机械去尾以满足 whitespace 闸，其他字符不变。这不是第二份完整方案，也不引入新设计。

```diff
diff --git a/docs/features/2026/11/26/F20261126expot-execution-machine-pool.md b/docs/features/2026/11/26/F20261126expot-execution-machine-pool.md
index 903bb48a..194d468b 100644
--- a/docs/features/2026/11/26/F20261126expot-execution-machine-pool.md
+++ b/docs/features/2026/11/26/F20261126expot-execution-machine-pool.md
@@ -4,7 +4,7 @@ title: 执行机语义修正：系统资源池与海獭按动作选用，移除
 summary: 对话与执行机不是绑定关系——执行机是系统级资源池（多台同在线），海獭感知机器池并按动作选择落点；移除对话级默认机器与绑定 API/UI；设置页新增执行机在线列表与 connector 配对入口；恢复与审计按动作实际落点走。
 doc_type: feature
 change_type: feature
-capability_test: "n/a: 感知层验证走 alpha 实例真实 invoke + 异体锚点重放（证据见 PR-1 实现记录节）；capability 层无对应用例且本地 LLM 端点未配置"
+capability_test: "n/a: T2 感知/选择层由 alpha 实例真实 invoke + 异体锚点重放兑付（PR-1/PR-2 已留证据）；T3/T6 的机械面由单测兑付（迁移 conversation-machine-column-removal/快照 execution-machine-pool/gate/registry/supervisor lifecycle 等用例），capability 层无对应用例且本地 LLM 端点未配置"
 created_in_conversation: 6af46649-f93f-4c5b-a6d2-245a4ed33e9f
 from:
   - F20261118crtgr
@@ -16,7 +16,7 @@ modules: [frameworks/agent, frameworks/execution, usecases/conversation, interfa
 created_at: 2026-11-25
 intent:
   problem: "对话与执行机是绑定关系（conversations.current_machine_id + 对话级切换 API/UI），海獭对机器池零感知（六动作无落点参数、清单仅服务 Web UI），落点选择权在人不在海獭——与总规划『多执行机：交互端与执行端解耦，可 A 发消息让 B 执行』的产品语义冲突；connector 配对/下载入口错位在对话内而非系统级设置页"
-  expected_effect: "海獭可随时查询机器池（deferred 工具，含在线状态）；六动作支持可选 machine 参数按动作指定落点，fail-closed 报错不静默回落；对话级绑定列/API/UI 移除；设置页有执行机在线列表与配对入口；恢复与审计按动作台账机器路由"
+  expected_effect: "海獭可随时查询机器池（deferred 工具，含在线状态）；六动作以必选 machine 参数按动作指定落点，fail-closed 报错不静默回落；对话级绑定列/API/UI 移除；设置页有执行机在线列表与配对入口；恢复与审计按动作台账机器路由"
   verify_by:
     type: behavior_check
     evidence:
@@ -66,10 +66,10 @@ F20261118crtgr 当时选对话级是**实现轻量取舍**（设计取舍表：
 - 不动 IM 入口、手机 Web 真机验证（验收口径已剔除，见 2026-11-25 对话记录）。
 - 不做「skill 级默认机器」「动作模板落点」等预设机制（未来加法，本特性不预设）。

-## 未决问题
+## 方案期未决问题（实现结论已落定，见 PR-2/PR-3 实现记录）

 - **U1（实现路径，dev 第一步验证，spike 判据 v2）**：`@earendil-works/pi-durable@1.5.0` 六动作 schema 与参数透传的改动路径——路径 A（改框架包+发版，工具参数自然透传）vs 路径 B（本仓 defineExtension 包装工具集，参数在 wrapper 层路由）。**spike 判据（可执行）**：路径 B 可行 ⇔ wrapper 能透传三项框架能力且单测等价：①`prepare` 钩子（改 command/cwd/env）；②结构化输出（bash 的 output/exitCode/truncated/fullOutputPath）；③文件变更队列（edit/write 的 file-mutation-queue）。任一不完整 → 退路径 A；框架包不可控（非内部可发版）→ 路径 A 排除，接受路径 B 的能力边界并如实标注。
-- **U2（存量数据）**：conversations 表 `current_machine_id` 的迁移方式——直接 DROP COLUMN（SQLite 迁移）vs 保留列弃用。倾向 DROP（避免僵尸列），实现时按迁移工具能力定。
+- **U2（存量数据，已决）**：conversations 表 `current_machine_id` 采用幂等 DROP COLUMN；PR-3 已落实数据保留、DDL 等价、CRUD 探针与重复启动测试。
 - **U3（统一注册制生命周期，v6 新增，spike 判据）**：①配对凭据：生成/存储（持久化形态待定——可能新增表或文件，「无新增表」声明作废）/轮换/过期恢复；②启动顺序：凭据中枢签发 vs connector 需凭据上线的鸡生蛋（设计答案已给：启动→签发→拉起，窗口内按离线同构）；③停止级联：中枢退出时 connector 子进程同步终止（防 #2015 SIGKILL 孤儿复发——设计目标：任一退出路径不残留孤儿）；④退避参数与连续失败告警（如 5 连败 high healing）。spike 验收：模拟 4 类异常（kill 子进程/kill 中枢/凭据过期/端口占用）全部自愈或 fail-closed，无孤儿、无死循环。

 ## 方案设计
@@ -79,7 +79,7 @@ F20261118crtgr 当时选对话级是**实现轻量取舍**（设计取舍表：
 | PR | 内容 | 依赖 |
 |---|---|---|
 | PR-1 感知层 | `list_execution_machines` deferred 工具 + 身份注入多机环境说明 | 无（可先行） |
-| PR-2 动作级选择 | 六动作 `machine` 可选参数接通既有 `ConversationActionRouter.resolve(targetMachineId?)`（conversation-action-router.ts:30，显式目标优先于对话绑定——路由层无需新建）+ fail-closed 报错（含可用机器清单）。**核心不确定性=U1 工具 schema 层**（pi-durable bashSchema 无落点参数） | U1 路径判定 |
+| PR-2 动作级选择 | 六动作 `machine` 必选语义接通显式目标路由 + fail-closed 报错（含可用机器清单）。**核心不确定性=U1 工具 schema 层**（pi-durable bashSchema 无落点参数） | U1 路径判定 |
 | PR-3 移除绑定 + 设置页 + **统一注册制（v5 扩展）** | current_machine_id 迁移移除、对话级 API/UI 移除、设置页执行机区块、配对面板迁移；**中枢机器 connector 化（自动拉起/自动配对/掉线重启）、内置 local 移除、快照源与台账统一**；#2036 随此步微调 rebase | PR-1/PR-2 + v5 审视通过 |
 | PR-4 恢复衔接 | 恢复链按台账机器路由、离线挂 #2018 attempts 队列 | #2018 合入（进行中） |

@@ -139,7 +139,7 @@ F20261118crtgr 当时选对话级是**实现轻量取舍**（设计取舍表：

 - [Incompatible] 移除 `GET/PUT /api/conversations/:id/execution-machine` 端点（Web 同步改，无外部消费）。
 - [Incompatible] conversations.`current_machine_id` 列删除（迁移）。
-- agent 工具面向后兼容（可选参数，既有调用不变）。
+- agent 执行机类工具采用必选 machine 语义；旧缺参调用会收到含可用机器清单的错误并由海獭自纠错（不再承诺缺参调用不变）。

 ## 设计取舍

@@ -180,7 +180,7 @@ F20261118crtgr 当时选对话级是**实现轻量取舍**（设计取舍表：
 - **① 谁需要它**：海獭（agent）——跨机操作场景（查 B 机日志、跨机对比、远程部署验证）；用户间接需要（「A 发消息让 B 执行」由海獭在动作层兑现，而非人工切对话绑定）。
 - **② 失败后果**：选错机器=动作在错误机器执行（读错文件/写错位置）——显式选择的自然责任，工具返回带落点标记可即时发现；fail-closed 保证不静默回落放大错误。
 - **③ 后续机制**：机器名拼写错误→报错自带可用清单（自纠错）；机器时开时关→感知工具实时查；未来可能的「skill 默认机器」属新加法（非目标已排除），本机制不预设钩子。
-- **④ 退役条件**：单执行机世界里参数自然休眠（可选参数向后兼容，不删）；框架层统一执行模型重构时随框架迁移。
+- **④ 退役条件**：若未来重新引入默认机须由搭档翻案并重新评审；框架层统一执行模型重构时随框架迁移。

 ### 机制提案准入三问（R8.5）

@@ -249,6 +249,81 @@ spike 原型 = alpha 实例当中枢（隔离 HOME spawn 本机 connector），
 - 弃 ALS+beforeTool 标记的取舍：beforeTool 在 env 构造前跑且能改 args，理论可行；但其 per-call 隔离性依赖 SDK 调度的异步资源边界，静态读码无法排除共享链污染——一旦污染是**静默串机**（A 的命令跑上 B 指定的机器），fail-closed 架构下最坏故障形态。代理方案的失败形态全是吵闹失败（代理 api 守卫断言关键面齐全，spread 丢成员即抛错），并发绝对安全。
 - 三项透传判定不受影响：prepare 链/结构化输出/文件变更队列都在原 execute 链内，与 env 桥机制无关，委托即继承（实现与测试见 PR-2 实现记录节）。

+## PR-3 实现记录（2026-11-25，feat/F20261125expot-execution-pool-pr3）
+
+### 实现清单
+
+- **C1 生命周期（commit `9c01c63d`）**：新增 `HubConnectorSupervisor`，中枢启动时用既有 `IssueConnectorPairingCode` 签发一次性码并拉起本机 connector；隔离 HOME 保存设备身份/实例锁，`--workspace-root` 指回中枢 dataDir。子进程退出按指数退避重启，连败五次写 high healing；正常 dispose 级联 SIGTERM，connector `--managed` 的 200ms ppid watch 覆盖中枢 SIGKILL。配对码全文与前缀均不写日志。首轮检视后补全 spawn `error`：与 `exit` 共用每个子进程仅触发一次的终态闸，进入相同清理、退避、连败告警与停止唤醒链，避免 unhandled error 和双重 respawn。
+- **C2 统一注册制（commit `644bae6d`）**：删除 `LocalExecutionMachine`、`RecordingNodeExecutionEnv` 与 `ConversationActionRouter`；Registry 初始为空且只接受 connector 注册，`resolve()` 缺 machine 即抛错。SDK env 工厂恒返回 Proxy 占位环境，真执行仍由 PR-2 壳在 gate 后按显式 machine 重建 env，漏网文件/OS 调用吵着失败。`upload_device_file` 同样接 gate 与显式 machine。
+- **快照与台账统一（同 C2）**：`machinePoolSnapshot` 只读 devices 全量在线/离线状态，不再拼内置 local；所有新动作进入 central `remote_action_requests`，恢复摘要只读 central。旧 `execution-machines/local/actions.db` 不删除、不迁移合并，保留为历史只读存档。
+- **C3 绑定移除（同 C2）**：`conversations.current_machine_id` 幂等 DROP；repository get/set 与 `GET/PUT /api/conversations/:id/execution-machine` 删除。迁移测试覆盖存量行保留、迁移后 DDL 与新库语义等价、CRUD 功能探针及重复 initSchema。
+- **C4 设置页（commit `8c45398f`）**：设置页新增执行机区块，展示全部注册机器的 ID/名称/在线状态/最近在线时间并支持刷新；`ConnectorOnboardingPanel` 移至设置页。对话弹窗更名「动作状态」，只读 central 台账的全部机器动作，不再加载机器清单、请求绑定 API 或内嵌配对入口。
+
+### 增量设计取舍
+
+| 取舍 | 决策 | 被否替代与理由 |
+|---|---|---|
+| SDK 预构造 env | 恒成功的 Proxy 占位 env；id/cwd 透传，执行面字符串属性返回身份稳定的失败桩，直接调用与可选能力检测均 fail-closed；then 保持缺省以兼容 await | 在工厂直接抛错会炸掉 speak/记忆等全部工具；恢复默认 local 则重新引入隐式落点；只代理已有函数会让未知方法返回 undefined，错误退化为 TypeError 且可选调用可能静默跳过；then 也代理会触发 Promise assimilation，炸掉所有 SDK 工具 |
+| 中枢工作区路径 | connector 独立 HOME，`--workspace-root=dataDir` | 改设备默认 HOME 会撞用户手装 connector；迁移存量对话工作区无必要 |
+| 旧 local 台账 | 原文件保留只读，新动作只进 central | 合并历史库会引入 ID/状态迁移风险；继续双写会保留两套真相源 |
+| 设置页列表 | 直接复用 `/api/execution-machines` 同源投影，无 local 特判 | 前端自造在线状态或本机徽章会重新引入第二套机器语义 |
+| 一次性码日志 | 只记录 expiresAt，不记录码全文或前缀 | 前缀仍是秘密片段，对排障无必要 |
+
+### 首轮检视处置（2026-11-25）
+
+| 发现 | 更好/更差判断 | 处置与验证 |
+|---|---|---|
+| 三处新增注释夹带特性编号或优先级编号 | 改了更好 | 剥编号、保留 why；提交后以 stacked base 重跑注释编号闸 |
+| 占位 env 的函数分支对未知方法不可达 | 改了更好 | 执行面字符串属性返回缓存失败桩；新增直接调用、可选能力检测、未来未知方法、Promise assimilation 与失败桩身份稳定测试 |
+| env 解析注释残留已删除的对话绑定接口名 | 改了更好 | 注释改为显式 machineId 定位与 conversationId 归因，不再暗示对话级回退 |
+| supervisor 未处理 spawn error | 改了更好 | error/exit 经每子进程终态闸幂等合流；补 spawn error 后退避/告警及紧随 exit 不双重 respawn 的判别测试 |
+
+### 删除/替换机制接管表
+
+| 被删/替换物 | 原保护的不变量与异常路径 | 原消费者 | 新机制接管 / 残余风险 |
+|---|---|---|---|
+| 内置 local + RecordingNodeExecutionEnv | 六动作在本机执行；写/编辑/bash 落账；invoke/toolCall 归因；无机器时仍可执行 | SDK 壳、workspace、上传、恢复、测试 | 中枢 connector 注册后走同一 RemoteExecutionMachine/central 台账；启动与重连窗口 fail-closed，占位 env 拦截漏网调用；旧 local 文件仅作历史存档 |
+| ConversationActionRouter + current_machine_id | 显式目标优先，缺省回退对话绑定；对话切换可改后续动作落点 | durable env、workspace、HTTP GET/PUT、Web Modal | PR-2 显式 machine gate + PR-3 Registry 无默认机；缺参/离线/未知机器均报错含清单，不再猜落点 |
+| 每机 `actions.db` 作为新 local 动作真相 | 五态、hash、中断收尾、启动清扫 | local 执行与旧审计 | 新动作由 central registry 统一五态与恢复摘要；旧库不删，历史审计仍可读，但不参与新恢复 |
+| 对话内机器选择器与配对面板 | 人切对话默认机、签发码、下载 connector | ChatView、ExecutionMachineModal、设置页 | 机器生命周期与添加设备归设置页；对话只保留按 central 台账查询动作状态；已移除端点返回 404 |
+
+### 验收断言与实测证据
+
+| 场景 | 操作 | 结果 |
+|---|---|---|
+| 后端全量 | `npx vitest run` | PASS：544 文件 / 6949 测试（`expool-pr3/root-vitest.log`） |
+| Web 全量 | `cd web && npx vitest run` | PASS：91 文件 / 887 测试（`expool-pr3/web-vitest.log`） |
+| 构建 | `npm run build` + `cd web && npm run build` | PASS：tsc、connector closure、tarball/app 打包、Vite 均成功（`root-build.log`/`web-build.log`） |
+| 迁移与核心定向 | supervisor + DROP 迁移 + 机器壳 + Registry/HTTP 等 | PASS；最终安全/结构补强后 22/22（含日志无码、DDL 等价） |
+| 首轮检视补强定向 | placeholder env + supervisor | PASS：2 文件 / 12 测试；TypeScript noEmit 与相关 eslint 通过 |
+| alpha 真启动 | `bash scripts/alpha.sh start`（既有 alpha 数据根） | PASS：监听 3120，无 SqliteError；conversations 无 current_machine_id；中枢 connector 自动配对上线（`alpha-start.log`/`machines-online.json`） |
+| Web 添加设备 | Playwright 登录→设置→生成码→真 connector 核销→刷新列表 | PASS：设备 `connector-d62c14a4` 在线，元素 600×49 且可见；绑定 API 请求数 0（`ui-evidence.json`） |
+| 中枢动作统一台账 | 真 agent 以显式 machine 调 bash `printf PR3_HUB_OK` | PASS：模型观察到输出；`shell.exec` 在 central 状态 succeeded（`hub-action-summary.json`） |
+| kill connector | SIGKILL 字面子进程 PID，轮询实例锁与机器池 | PASS：46396→48266，自动重连 online，并落 high healing（`respawn-summary.json`） |
+| kill 中枢 | SIGKILL alpha 中枢 PID，检查 connector | PASS：connector 100ms 后退出，无受管孤儿（`orphan-watch-summary.json`） |
+| 凭据撤销 | 停止 alpha→删除 devices 旧身份→重启 | PASS：旧 `connector-225c9819` 替换为新 `connector-0a58302b` 并上线（`revocation-summary.json`） |
+| UI 真实可见 | Chromium 1440×1000，读取 boundingClientRect 并截图 | PASS：设置区块 display=block/visibility=visible；弹窗只有动作状态，无旧选择器/配对面板 |
+| CI 同款 connector e2e | `bash scripts/e2e-server.sh run connector-onboarding.spec.ts` | PASS：1/1；设置页签发/公开核销/重放拒绝/双安装包 hash/几何证据（`e2e-connector-onboarding.log`） |
+
+截图与日志统一在对话工作区 `expool-pr3/`：`settings-execution-machines.png`、`settings-execution-section.png`、`settings-web-paired-online.png`、`conversation-action-status.png`。
+
+### 负向验收
+
+- **破坏的旧契约（目标内不兼容）**：执行机类工具缺省 machine 不再可用；对话 GET/PUT 执行机端点与 current_machine_id 删除；中枢没有内置 local，connector 未就绪时动作失败而不是隐式本机执行。
+- **绕过的既有保护**：无。BashGuard、文件闭包、配对码一次性核销、WSS 协议、五态收尾均保持；占位 env 只新增吵闹失败，不代理任何真实文件/shell 能力。
+- **旧资源清理**：旧实现类与路由测试已删除，代码引用 grep 清零；旧 local `actions.db` 是刻意保留的历史数据而非运行中孤儿配置。
+
+### 最简实现检查
+
+已过。复用既有配对码、connector 进程、Registry、central 台账和设置页面板；未新增数据表或第二套路由。Proxy 占位比手写 30+ 方法桩更少且不会随 SDK 增面静默漏拦。
+
+### 未覆盖边界（如实）
+
+- ppid=1 的受管孤儿兜底盘在 macOS 实测；Windows 的父进程句柄语义未在真实 Windows 验证。
+- 端口不可达的指数退避沿用 U3 spike 与 connector 既有实现，本轮未再构造独立断网演练。
+- spawn error 由 ChildProcess 事件注入覆盖 error/exit 竞态与告警链；未在真实操作系统耗尽文件描述符复现 EMFILE。
+- #2018 attempts 的离线恢复排队仍属 PR-4 衔接范围；本 PR 只统一新动作台账与恢复摘要数据源，不宣称交付 PR-4。
+
 ## PR-2 实现记录（2026-11-25，feat/F20261125expot-execution-pool-pr2）

 ### 实现清单
```
