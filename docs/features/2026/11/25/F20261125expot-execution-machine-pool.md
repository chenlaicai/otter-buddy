---
id: F20261125expot
title: 执行机语义修正：系统资源池与海獭按动作选用，移除对话级绑定
summary: 对话与执行机不是绑定关系——执行机是系统级资源池（多台同在线），海獭感知机器池并按动作选择落点；移除对话级默认机器与绑定 API/UI；设置页新增执行机在线列表与 connector 配对入口；恢复与审计按动作实际落点走。
doc_type: feature
change_type: feature
capability_test: "n/a: 方案文档——实现 PR 时补 capability 用例锚点"
created_in_conversation: 6af46649-f93f-4c5b-a6d2-245a4ed33e9f
from:
  - F20261118crtgr
  - F20261118remex
causal_links:
  - issue:#1868
tags: [execution-machine, connector, agent-tools, web]
modules: [frameworks/agent, frameworks/execution, usecases/conversation, interface-adapters/http, web]
created_at: 2026-11-25
intent:
  problem: "对话与执行机是绑定关系（conversations.current_machine_id + 对话级切换 API/UI），海獭对机器池零感知（六动作无落点参数、清单仅服务 Web UI），落点选择权在人不在海獭——与总规划『多执行机：交互端与执行端解耦，可 A 发消息让 B 执行』的产品语义冲突；connector 配对/下载入口错位在对话内而非系统级设置页"
  expected_effect: "海獭可随时查询机器池（deferred 工具，含在线状态）；六动作支持可选 machine 参数按动作指定落点，fail-closed 报错不静默回落；对话级绑定列/API/UI 移除；设置页有执行机在线列表与配对入口；恢复与审计按动作台账机器路由"
  verify_by:
    type: behavior_check
    evidence:
      - "单测：machine 参数分支（在线路由/离线 fail-closed 含可用清单/缺参报错含清单）+ current_machine_id 迁移"
      - "端到端（alpha 隔离实例+双 HOME connector）：感知查询→指定 B 机执行→落点标记正确；离线报错；恢复按台账机器路由衔接 #2018"
      - "兼容回归：缺参报错文案含完整可用机器清单（自纠错闭环）；planc4 B1 零盲重放/B2 正向恢复用例带参形态下不退化"
---

# 执行机语义修正：系统资源池与海獭按动作选用

## 背景（搭档原话，意图锚）

> 2026-11-25 10:16：「首先，对话就是本系统的用户交互核心区域，执行机主要目的之一也是用海獭们用的。但是现在这个下载入口，你放到每一个对话中，我认为是不对的。比如说，放到 设置 页面下。（当然，那设置页面就要整理下布局了，现在比较乱）我还是期望说，执行机是系统级的操作，并且，执行机是可以同时有多个在线的，所以需要有一个 执行机在线列表的展示界面。」

> 2026-11-25 10:31：「你看，这就发现问题了，我认为，对话和执行机不是绑定关系啊。之前就说过了，执行机可以有多个，海獭明确感知到，然后海獭思考、分析用哪个，海獭系统不做强限制才对啊」

> 2026-11-25 10:36（拍板）：「做。你来改造。移除默认」

> 2026-11-25 11:02（口径拍板）：「选 b；海獭系统后面根本就没有本机概念，就是执行机！但是也不是所有的动作都要执行机啊，只有那些需要在执行机上操作的工具才需要的啊」

现状与目标的差距（代码锚点，2026-11-25 摸底；经对抗审视修订 v2）：

- **对话级绑定**：conversations 行持有当前执行机（列名 `current_machine_id`，schema.ts:163/171；`GET/PUT /api/conversations/:id/execution-machine`，router.ts:342/369；conversation-repository set/get），六动作整体按对话路由（durable-session.ts:121-129 env 回调 `resolveForConversation`；platforms.ts:97-98 同链路）。**动作级路由底座已存在**：ConversationActionRouter.resolve(targetMachineId?) 显式目标优先于对话绑定（conversation-action-router.ts:14/30）——缺口只在工具层没有把参数传进来。
- **海獭零感知**：六动作工具 schema（pi-durable `bashSchema`：`{command, timeout?}`）无落点参数；机器清单 API 只服务 Web UI；agent 身份注入无执行机信息。海獭唯一感知通道=远程机器离线时的报错（remote-execution-machine.ts:146 `connector device offline or unpaired`）。
- **配对入口错位**：connector 配对/下载面板嵌在对话的 ExecutionMachineModal 里（ExecutionMachineModal.tsx:132 `<ConnectorOnboardingPanel />`）。

F20261118crtgr 当时选对话级是**实现轻量取舍**（设计取舍表：对话级一列窄接口直查，repo 全链免改），非产品定论。本特性按搭档拍板修正产品语义。

## 目标

- **T1 感知**：海獭可随时查询机器池（机器 ID、名称、在线状态、最近在线时间），不占常驻上下文。
- **T2 动作级选择**：需要执行机的工具（bash/读/写/编辑/工作区系——OS/文件系统操作类）`machine` 参数**必选**：海獭每次显式指定落点，不带参数报错（错误含可用机器清单，支持自纠错）；**本机特权概念移除**——中枢所在机器只是执行机池中的一台（呈现名可自定义，如 hub-local），选它与其他机器平权。不涉文件系统/OS 的工具（speak/记忆/产物/待办/信号等纯中枢操作）不引入 machine 参数。指定离线/不可用机器时明确报错（fail-closed，不静默回落）。
- **T3 移除对话绑定**：对话不再持有「当前执行机」；绑定列、切换/查询 API、Web 选择器移除。
- **T4 系统级管理界面**：设置页新增执行机区块（在线列表 + connector 配对下载入口）；对话内配对面板移除，远程动作状态保留（按对话查台账，语义不变）。
- **T5 恢复与审计按落点走**：动作台账记录实际执行机器（既有）；恢复链重放按台账机器路由，机器离线时挂入 #2018 的 attempts 恢复队列。

## 非目标

- 不改 connector 设备侧协议（WSS 通道、remote actions 动作集不动）。
- 不做多用户/多租户授权模型（单用户原则不变；机器授权集=全部已配对机器）。
- 不做设置页全面改版（只新增执行机区块；整体布局整理另行排期）。
- 不动 IM 入口、手机 Web 真机验证（验收口径已剔除，见 2026-11-25 对话记录）。
- 不做「skill 级默认机器」「动作模板落点」等预设机制（未来加法，本特性不预设）。

## 未决问题

- **U1（实现路径，dev 第一步验证，spike 判据 v2）**：`@earendil-works/pi-durable@1.5.0` 六动作 schema 与参数透传的改动路径——路径 A（改框架包+发版，工具参数自然透传）vs 路径 B（本仓 defineExtension 包装工具集，参数在 wrapper 层路由）。**spike 判据（可执行）**：路径 B 可行 ⇔ wrapper 能透传三项框架能力且单测等价：①`prepare` 钩子（改 command/cwd/env）；②结构化输出（bash 的 output/exitCode/truncated/fullOutputPath）；③文件变更队列（edit/write 的 file-mutation-queue）。任一不完整 → 退路径 A；框架包不可控（非内部可发版）→ 路径 A 排除，接受路径 B 的能力边界并如实标注。
- **U2（存量数据）**：conversations 表 `current_machine_id` 的迁移方式——直接 DROP COLUMN（SQLite 迁移）vs 保留列弃用。倾向 DROP（避免僵尸列），实现时按迁移工具能力定。

## 方案设计

### 分层拆解（PR 序列）

| PR | 内容 | 依赖 |
|---|---|---|
| PR-1 感知层 | `list_execution_machines` deferred 工具 + 身份注入多机环境说明 | 无（可先行） |
| PR-2 动作级选择 | 六动作 `machine` 可选参数接通既有 `ConversationActionRouter.resolve(targetMachineId?)`（conversation-action-router.ts:30，显式目标优先于对话绑定——路由层无需新建）+ fail-closed 报错（含可用机器清单）。**核心不确定性=U1 工具 schema 层**（pi-durable bashSchema 无落点参数） | U1 路径判定 |
| PR-3 移除绑定 + 设置页 | current_machine_id 迁移移除、对话级 API/UI 移除、设置页执行机区块、配对面板迁移 | PR-1/PR-2（先有能力再拆绑定，过渡期绑定仍在但动作可覆盖） |
| PR-4 恢复衔接 | 恢复链按台账机器路由、离线挂 #2018 attempts 队列 | #2018 合入（进行中） |

### 感知层（PR-1）

- 新增 agent 扩展工具 `list_execution_machines`（deferred，进 tool_search 检索面）：返回 `[{id, name, online, lastSeenAt}]`，数据源复用 ExecutionMachineService（与 router.ts:329 `/api/execution-machines` 同源——local 恒在 + devices 表全量含离线）。
- 身份注入（BIG/SMALL_OTTER.md 或 pi-session-factory 组装层）补一句：多执行机环境说明 + 指向感知工具。**注入的是「存在性与查询方式」，不是机器清单本身**（清单动态变化，常驻注入必过期）。

### 动作级选择（PR-2）

- 需执行机的工具 schema 增 **必选** `machine: string`；不带参数→工具报错，错误文本含当前可用机器清单（id/名称/在线状态）——海獭自纠错重带参数。**工具分界**：bash/read/write/edit/workspace 系=执行机类；speak/记忆/产物/待办/信号/检索等纯中枢工具不涉 machine。
- 路由：**复用既有 `ConversationActionRouter.resolve(targetMachineId?)`**（显式目标优先——conversation-action-router.ts:14）；中枢自身作为池中一员注册（呈现名可自定义）；剩余工作在工具层把参数接到该入口（U1）。
- fail-closed 语义（不变量，沿用 #1934）：指定机器不存在/离线/未配对 → 工具返回明确错误，错误文本含：所指定机器 ID、当前在线机器清单（自纠错信息）、`不静默回落`。设备离线中断语义沿用 remote-execution-machine.ts:95 `graceful: interrupted`。
- 工具返回带落点标记（如 bash 结果头部 `machine: <id>`）：海獭与用户可核对该动作实际在哪台机器执行（深潜成本降低）。

### 移除对话绑定（PR-3）

- conversations 表 `current_machine_id` 列迁移移除（U2）；`setConversationMachine`/`getConversationMachine` 及 HTTP 端点移除。
- **消费方清单（对抗审视 v2 补全，均已核锚）**：schema.ts:163/171（列定义+迁移）、sqlite-conversation-repository.ts:175-183（读写实现）、conversation-action-router.ts（绑定回退路由）、router.ts:342/369（HTTP 端点）、app.ts:428/846/855（装配：ConversationActionRouter 构造、plumbing get/set 透传）、platforms.ts:97-98（env 回调同链路）、web ExecutionMachineModal（选择器）。PR-3 需逐处移除/改造，**「无孤儿消费」成立前提=本清单全覆盖，实现时以 grep 全量复核为准**。
- Web：ExecutionMachineModal 移除机器选择器与 ConnectorOnboardingPanel；远程动作状态列表保留（`GET /api/conversations/:id/remote-actions` 语义不变——按对话查动作台账）。ConversationPage 的 modal 触发按钮语义调整（保留动作状态入口）。
- 设置页新增执行机区块：在线列表（复用 `/api/execution-machines`）+ ConnectorOnboardingPanel 迁移复用。

### 恢复与审计（PR-4）

- remote_action_requests 台账已含机器维度（既有）。恢复链（resume-interrupted-service）重放动作时按台账机器路由，不再按对话绑定。
- 目标机器离线：动作挂 pending，走 #2018 链级 attempts 队列（1→5→exhausted + high healing），不换机器重放（「A 让 B 执行」的确定性）。

### 数据模型变更

- conversations.`current_machine_id`：删除（migration，U2 定方式；**列名为 current_machine_id 非 current_machine_id——对抗审视 v2 更正，照 schema.ts:163**）。**消费方声明（⑥）**：见 PR-3 节补全的消费方清单——随本特性一并移除/改造，无孤儿消费（前提：清单全覆盖+实现时 grep 复核）。
- 无新增表/字段。

## 影响范围

- **既有 skill 与习惯（B 口径下的断点与自愈）**：不带 `machine` 的执行机类调用首次踩错→报错含清单→海獭下轮自纠错（LLM 天然自愈循环，非人类 CLI 式永久断裂）；高频 skill 的用法文档由身份注入一句话+渐进更新覆盖。**工作区跟机器走**：选哪台机器，对话工作区就在那台机器的设备侧路径（planc 系列已验的 remote workspace 语义）；跨机操作时海獭需感知路径差异（工具返回带落点标记兑底）。
- **恢复链**：env 回调从 resolveForConversation 改 resolveForAction——#2018 刚修的 attempts 链语义不变（队列行结构不动）。
- **Web UI**：ExecutionMachineModal、ConversationPage 工具栏、settings 页。
- **对话 API 消费者**：GET/PUT execution-machine 端点移除（前端同步改，无第三方消费）。

## 风险与约束

- U1 框架路径不确定：若只能走 wrapper（路径 B），需验证 `prepare` 钩子、结构化输出、文件变更队列等框架能力的透传完整性——不完整处如实标注能力边界，不假称等价。
- 存量对话迁移：PR-3 落地瞬间，原绑远程机器的对话动作回落本机——呈报搭档后执行。
- 中间态安全：PR-2 合入后 PR-3 合入前，动作级参数与对话绑定并存——**不指定=对话当前绑定（ConversationActionRouter 既有回退序，存量行为零变化）**；显式指定走新参数。绑定移除（PR-3）是行为变化点：不指定从「对话绑定」变「中枢本机」，原绑远程机器的对话动作回落本机——呈报搭档后执行。
- 大爆炸风险控制：PR 序列小步走，每步 CI+对抗审视+真实验证（alpha 隔离实例 + 双 HOME connector 环境，planc 系列方法论复用）。

## 不兼容更新

- [Incompatible] 移除 `GET/PUT /api/conversations/:id/execution-machine` 端点（Web 同步改，无外部消费）。
- [Incompatible] conversations.`current_machine_id` 列删除（迁移）。
- agent 工具面向后兼容（可选参数，既有调用不变）。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 不指定 machine 的行为 | **强制每次显式（搭档 11:02 拍板选 B）+ 本机概念移除**：中枢机只是执行机池一员，无特权落点；不带 machine 的执行机类工具调用报错并附可用机器清单（海獭自纠错重带参数） | 落中枢本机（隐式）/可选参数 | 搭档原话「根本就没有本机概念，就是执行机」；架构纯度——「本机默认」会永久残留第二套语义；存量调用首次踩错→报错含清单→下轮带上，LLM 自纠错成本远低于人类 CLI 断裂；高频 skill 的用法文档渐进更新 |
| 对话绑定处理 | 彻底移除（搭档拍板「移除默认」） | 保留 current_machine_id 为默认值 | 对话↔机器绑定造成「切对话才生效」的间接层，与「海獭按动作思考用哪个」的模型冲突；保留即残留第二套语义 |
| 感知通道 | deferred 工具 + 一句话注入 | 常驻注入机器清单 | 清单动态变化，常驻注入必过期且占上下文；deferred 按需查询保真 |
| 离线时行为 | fail-closed 报错含可用清单 | 静默回落本机 | 沿用 #1934 不变量——回落破坏「A 让 B 执行」确定性；错误自带清单供海獭自纠错 |
| 恢复落点 | 按台账机器恢复，离线挂 attempts 队列 | 换可用机器重放 | 换机器=在错误机器上重放动作（读错文件/写错位置）；排队等待与 #2018 语义衔接 |

### 机制识别检查点（判定：涉及净新增机制）

- [x] 新增决策分支（动作级 machine 参数决定落点并写入台账——被记住且影响后续恢复）
- [x] 新增跨模块调用路径（agent 工具面 → ExecutionMachineService）
- [x] schema 变更（current_machine_id 删除；工具 schema 增参）
- [ ] 新增配置字段/枚举/开关、状态生命周期、定时任务、信号类型、持久化存储——均无

### 机制预算四问（动作级机器选择）

- **① 谁需要它**：海獭（agent）——跨机操作场景（查 B 机日志、跨机对比、远程部署验证）；用户间接需要（「A 发消息让 B 执行」由海獭在动作层兑现，而非人工切对话绑定）。
- **② 失败后果**：选错机器=动作在错误机器执行（读错文件/写错位置）——显式选择的自然责任，工具返回带落点标记可即时发现；fail-closed 保证不静默回落放大错误。
- **③ 后续机制**：机器名拼写错误→报错自带可用清单（自纠错）；机器时开时关→感知工具实时查；未来可能的「skill 默认机器」属新加法（非目标已排除），本机制不预设钩子。
- **④ 退役条件**：单执行机世界里参数自然休眠（可选参数向后兼容，不删）；框架层统一执行模型重构时随框架迁移。

### 机制提案准入三问（R8.5）

- **① 决策者变了么**：无。落点选择权从「人经 Web UI 切对话绑定」交还「海獭动作级选择」是搭档拍板的产品语义修正（权力归还，非机制代行）；机制不替任何角色做决定。
- **② 靠自觉还是靠守卫**：fail-closed 路由与授权校验是代码守卫（机械）；「海獭思考用哪个」是 agent 决策，语义不可机械判定——标注**半机械+异体审**（对抗审视覆盖）。
- **③ 深潜成本降了吗**：升。动作台账按机器落账+工具返回带落点标记，「哪个动作在哪台机器执行」从「拼对话绑定+切换历史」变为直接可查。
- **P0 负面清单**：不命中（无自动跳过/智能预审/替人排优先级——机器选择是海獭调用时的显式决策）。

## 验证

- **单测**：machine 参数分支（在线路由/离线 fail-closed 含可用清单/**缺参报错含清单**）；迁移（存量 current_machine_id 清除后对话正常）。
- **端到端**（alpha 隔离实例 + 双 HOME connector，复用 planc 方法论）：海獭感知查询→指定 B 机跑 bash→落点正确（结果带 machine 标记）；B 机离线时指定报错含清单；中断恢复按台账机器路由、离线挂 attempts 队列衔接 #2018。
- **兼容回归**：缺参报错文案含完整可用机器清单（自纠错闭环）；planc4 B1 零盲重放、B2 正向恢复回归（planc4/06、07 用例）在带参形态下重跑不退化。

## 改动范围（预估，实现时按实际路径修编）

| 文件/模块 | 操作 | 说明 |
|---|---|---|
| src/frameworks/agent/（新 extension + pi-session-factory.ts） | 增 | list_execution_machines 注册（deferred）；多机环境注入 |
| pi-durable（路径 A）或本仓 wrapper（路径 B） | 改 | 六动作 machine 参数（U1） |
| src/frameworks/agent/durable-session.ts | 改 | env 回调 resolveForConversation → resolveForAction |
| src/bootstrap/database.ts + 迁移 | 改 | current_machine_id 移除（U2） |
| src/usecases/conversation/conversation-repository.ts | 改 | set/getConversationMachine 移除 |
| src/interface-adapters/http/router.ts | 改 | 对话级 execution-machine 端点移除 |
| web/src/pages/conversation/ExecutionMachineModal.tsx | 改 | 选择器与配对面板移除，动作状态保留 |
| web/src/pages/settings/index.tsx | 增 | 执行机区块（在线列表+配对） |
| src/usecases/conversation/resume-interrupted-service.ts | 改 | 恢复按台账机器路由 |
