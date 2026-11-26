---
id: F20261126expaa
title: "执行机资源池 PR-2 动作级选择：方案修订、实现与验证接续"
summary: "承载 PR-2 相对主方案文档的全部原始增量；主方案快照与 main 保持一致，不修改已合入历史文档。"
doc_type: feature
change_type: feature
capability_test: "n/a: 本文档只迁移 PR-2 的既有方案、实现、审视与验证记录；行为验证仍由原测试与 CI 承载"
created_in_conversation: 6af46649-f93f-4c5b-a6d2-245a4ed33e9f
from:
  - F20261126expot
causal_links:
  - issue:#1868
tags: [execution-machine, agent-tools, documentation, stacked-squash]
modules: [frameworks/agent, usecases/execution, interface-adapters/agent-runtime]
created_at: 2026-11-26
intent:
  problem: "PR-1 squash 合入后，PR-2 若继续修改主方案快照会违反历史文档不可变约束，但其方案修订与验证记录必须保留"
  expected_effect: "主方案与 main 逐字一致；PR-2 原始文档增量在本接续文档完整可检索，历史文档闸在 PR-2 base 下通过"
  verify_by:
    type: static_only
---

# 执行机资源池 PR-2 文档接续

## 迁移关系

- 主文档：`F20261126expot`；本文件是其 PR-2 接续记录，不取代主文档的目标与决策权归属。
- 原始已审 PR-2 树：`4ca36c0963d6a882532ff89bbb69d63fa5ecc70a`；对比 base：PR-1 squash 后的 main `31e407341bb115fd6b90aae3a1b16e8b3880b7dc`。
- 主文档在整理后恢复为上述 main 版本。本层新增的方案修订、U3/U1 spike、ALS 证伪、实现取舍、验收、负向验收与未覆盖边界全部迁到本文件。

## 保留方式

为避免人工摘抄造成语义漂移，下面原样保存「main 主文档 → 原始已审 PR-2 文档」的 unified diff。新增内容、被替换旧句和原位置均保留；仅对 diff 文本自身的行尾空白机械去尾以满足仓库 whitespace 闸，其他字符不变。这不是第二份完整方案，也不引入新设计。

```diff
diff --git a/docs/features/2026/11/26/F20261126expot-execution-machine-pool.md b/docs/features/2026/11/26/F20261126expot-execution-machine-pool.md
index e71d1b60..903bb48a 100644
--- a/docs/features/2026/11/26/F20261126expot-execution-machine-pool.md
+++ b/docs/features/2026/11/26/F20261126expot-execution-machine-pool.md
@@ -37,6 +37,10 @@ intent:

 > 2026-11-25 11:02（口径拍板）：「选 b；海獭系统后面根本就没有本机概念，就是执行机！但是也不是所有的动作都要执行机啊，只有那些需要在执行机上操作的工具才需要的啊」

+> 2026-11-25 14:12：「为啥会有本机的概念？我记得一开始的架构图中，提过web或者其他方式登录 来接入到海獭系统；然后执行机是后台的 启动进程注册执行机，这两者之间，我理解不需要构建匹配为本机 这种处理吧」
+
+> 2026-11-25 14:18（方向确认+工作模式）：「方向ok。然后你来实现；就算你给了pr，但咱们一起在对齐设计思路，所以我不认可你已实现的这些pr，我只看到最终的，你不要给我过期的/老旧的/错误的东西让我审视」
+
 现状与目标的差距（代码锚点，2026-11-25 摸底；经对抗审视修订 v2）：

 - **对话级绑定**：conversations 行持有当前执行机（列名 `current_machine_id`，schema.ts:163/171；`GET/PUT /api/conversations/:id/execution-machine`，router.ts:342/369；conversation-repository set/get），六动作整体按对话路由（durable-session.ts:121-129 env 回调 `resolveForConversation`；platforms.ts:97-98 同链路）。**动作级路由底座已存在**：ConversationActionRouter.resolve(targetMachineId?) 显式目标优先于对话绑定（conversation-action-router.ts:14/30）——缺口只在工具层没有把参数传进来。
@@ -48,7 +52,8 @@ F20261118crtgr 当时选对话级是**实现轻量取舍**（设计取舍表：
 ## 目标

 - **T1 感知**：海獭可随时查询机器池（机器 ID、名称、在线状态、最近在线时间），不占常驻上下文。
-- **T2 动作级选择**：需要执行机的工具（bash/读/写/编辑/工作区系——OS/文件系统操作类）`machine` 参数**必选**：海獭每次显式指定落点，不带参数报错（错误含可用机器清单，支持自纠错）；**本机特权概念移除**——中枢所在机器只是执行机池中的一台（呈现名可自定义，如 hub-local），选它与其他机器平权。不涉文件系统/OS 的工具（speak/记忆/产物/待办/信号等纯中枢操作）不引入 machine 参数。指定离线/不可用机器时明确报错（fail-closed，不静默回落）。
+- **T2 动作级选择**：需要执行机的工具（bash/读/写/编辑/工作区系——OS/文件系统操作类）`machine` 参数**必选**：海獭每次显式指定落点，不带参数报错（错误含可用机器清单，支持自纠错）；选任何机器（含中枢机器）平权。不涉文件系统/OS 的工具（speak/记忆/产物/待办/信号等纯中枢操作）不引入 machine 参数。指定离线/不可用机器时明确报错（fail-closed，不静默回落）。
+- **T6 统一注册制（v5 新增，搭档 14:12/14:18 拍板）**：所有执行机一律由后台进程注册而来，中枢机器也不例外——中枢启动时自动拉起本机 connector 子进程、自动配对注册、掉线自动重启（自愈管理，用户无感）；内置 local 特例移除（app.ts:417-424 硬注册删除）；快照源统一为「全部已注册设备」；本机动作与远程动作同一份台账（现在 local 动作不走台账），恢复链与审计同步统一。
 - **T3 移除对话绑定**：对话不再持有「当前执行机」；绑定列、切换/查询 API、Web 选择器移除。
 - **T4 系统级管理界面**：设置页新增执行机区块（在线列表 + connector 配对下载入口）；对话内配对面板移除，远程动作状态保留（按对话查台账，语义不变）。
 - **T5 恢复与审计按落点走**：动作台账记录实际执行机器（既有）；恢复链重放按台账机器路由，机器离线时挂入 #2018 的 attempts 恢复队列。
@@ -65,6 +70,7 @@ F20261118crtgr 当时选对话级是**实现轻量取舍**（设计取舍表：

 - **U1（实现路径，dev 第一步验证，spike 判据 v2）**：`@earendil-works/pi-durable@1.5.0` 六动作 schema 与参数透传的改动路径——路径 A（改框架包+发版，工具参数自然透传）vs 路径 B（本仓 defineExtension 包装工具集，参数在 wrapper 层路由）。**spike 判据（可执行）**：路径 B 可行 ⇔ wrapper 能透传三项框架能力且单测等价：①`prepare` 钩子（改 command/cwd/env）；②结构化输出（bash 的 output/exitCode/truncated/fullOutputPath）；③文件变更队列（edit/write 的 file-mutation-queue）。任一不完整 → 退路径 A；框架包不可控（非内部可发版）→ 路径 A 排除，接受路径 B 的能力边界并如实标注。
 - **U2（存量数据）**：conversations 表 `current_machine_id` 的迁移方式——直接 DROP COLUMN（SQLite 迁移）vs 保留列弃用。倾向 DROP（避免僵尸列），实现时按迁移工具能力定。
+- **U3（统一注册制生命周期，v6 新增，spike 判据）**：①配对凭据：生成/存储（持久化形态待定——可能新增表或文件，「无新增表」声明作废）/轮换/过期恢复；②启动顺序：凭据中枢签发 vs connector 需凭据上线的鸡生蛋（设计答案已给：启动→签发→拉起，窗口内按离线同构）；③停止级联：中枢退出时 connector 子进程同步终止（防 #2015 SIGKILL 孤儿复发——设计目标：任一退出路径不残留孤儿）；④退避参数与连续失败告警（如 5 连败 high healing）。spike 验收：模拟 4 类异常（kill 子进程/kill 中枢/凭据过期/端口占用）全部自愈或 fail-closed，无孤儿、无死循环。

 ## 方案设计

@@ -74,7 +80,7 @@ F20261118crtgr 当时选对话级是**实现轻量取舍**（设计取舍表：
 |---|---|---|
 | PR-1 感知层 | `list_execution_machines` deferred 工具 + 身份注入多机环境说明 | 无（可先行） |
 | PR-2 动作级选择 | 六动作 `machine` 可选参数接通既有 `ConversationActionRouter.resolve(targetMachineId?)`（conversation-action-router.ts:30，显式目标优先于对话绑定——路由层无需新建）+ fail-closed 报错（含可用机器清单）。**核心不确定性=U1 工具 schema 层**（pi-durable bashSchema 无落点参数） | U1 路径判定 |
-| PR-3 移除绑定 + 设置页 | current_machine_id 迁移移除、对话级 API/UI 移除、设置页执行机区块、配对面板迁移 | PR-1/PR-2（先有能力再拆绑定，过渡期绑定仍在但动作可覆盖） |
+| PR-3 移除绑定 + 设置页 + **统一注册制（v5 扩展）** | current_machine_id 迁移移除、对话级 API/UI 移除、设置页执行机区块、配对面板迁移；**中枢机器 connector 化（自动拉起/自动配对/掉线重启）、内置 local 移除、快照源与台账统一**；#2036 随此步微调 rebase | PR-1/PR-2 + v5 审视通过 |
 | PR-4 恢复衔接 | 恢复链按台账机器路由、离线挂 #2018 attempts 队列 | #2018 合入（进行中） |

 ### 感知层（PR-1）
@@ -96,15 +102,24 @@ F20261118crtgr 当时选对话级是**实现轻量取舍**（设计取舍表：
 - Web：ExecutionMachineModal 移除机器选择器与 ConnectorOnboardingPanel；远程动作状态列表保留（`GET /api/conversations/:id/remote-actions` 语义不变——按对话查动作台账）。ConversationPage 的 modal 触发按钮语义调整（保留动作状态入口）。
 - 设置页新增执行机区块：在线列表（复用 `/api/execution-machines`）+ ConnectorOnboardingPanel 迁移复用。

-### 恢复与审计（PR-4）
+### 统一注册制（v5 新增，PR-3 扩展核心；v6 按审视补全）
+
+- 中枢机器 connector 化：中枢启动流程自动拉起本机 connector 子进程（同机回环连接，自动配对凭据——不经人工配对）；进程管理挂入中枢启动/停止生命周期；掉线自动重启（退避策略）；**中枢 connector 掉线= P0 级可观测性（掉线即 high healing 告警，不等动作 fail 才暴露——审视采纳）**。
+- **启动顺序（鸡蛋问题设计答案）**：中枢启动 → 签发/读取持久化凭据 → 拉起 connector 子进程 → connector 注册上线。就绪窗口内中枢自身动作按「目标机器离线」同构处理（fail-closed 报错/排队）——启动窗口与掉线重启窗口同语义，一致性好。
+- **内置 local 移除破坏面清单（v6 补全，大獭抽验锚点）**：①`LOCAL_EXECUTION_MACHINE_ID="local"` 硬常量（ports/execution-machine.ts:22）；②Registry 默认机「恒为 local」语义（execution-machine-registry.ts:50）；③LocalExecutionMachine 类本身（local-execution-machine.ts）；④SqliteActionLedger 默认 deviceId（ledger/sqlite-action-ledger.ts）+每机一库路径 `execution-machines/local/actions.db`（app.ts:409）；⑤app.ts:417-424 Registry 构造+local 硬注册；⑥durable-session.ts env 回调与 workspace-action-executor 对 local 的读取链。PR-3 逐处移除/改造，实现时 grep 全量复核。
+- **无对话后台任务的落点（v6 设计）**：与对话动作同构——系统内部后台任务显式指定机器；无法指定的落中枢 connector（注册制下它就是一台普通机器，无特权语义）。
+- 快照源统一：machinePoolSnapshot 从「local（内置）+ devices」变为「全部 devices」——**#2036 状态：挂起不合入不腐化（搭档 14:18 工作模式），随 PR-3 微调 rebase：local:true 判别符与 local 字段随快照源统一移除，Web 判别改机器元数据，工具面不变**。
+- **台账统一（v6 修正表述+迁移语义）**：现状事实——local 动作走独立 SqliteActionLedger（每机一库 actions.db，五态+hash），非「不走台账」；不进 central 的 remote_action_requests。迁移语义：①存量 actions.db 保留只读（历史审计，不迁移合并）；②新动作全进 central registry（local 动作获得 remote 语义：中断可恢复）；③Web「远程动作状态」列表在 local 并入后显示全部机器动作，更名「动作状态」（口径重定义随 PR-3）。
+- 可靠性语义变化（已呈搭档知情）：中枢机器的执行依赖本机 connector 存活；自动重启兑底，重启窗口（秒级至几十秒）内动作 fail-closed 报错+恢复链排队。

-- remote_action_requests 台账已含机器维度（既有）。恢复链（resume-interrupted-service）重放动作时按台账机器路由，不再按对话绑定。
-- 目标机器离线：动作挂 pending，走 #2018 链级 attempts 队列（1→5→exhausted + high healing），不换机器重放（「A 让 B 执行」的确定性）。
+### 恢复与审计（PR-4，v5 简化）
+
+- 注册制下台账已统一（全动作同一份），恢复链重放统一按台账机器路由；目标机器离线挂 pending，走 #2018 链级 attempts 队列（1→5→exhausted + high healing），不换机器重放（「A 让 B 执行」的确定性）。

 ### 数据模型变更

 - conversations.`current_machine_id`：删除（migration，U2 定方式；**列名为 current_machine_id 非 current_machine_id——对抗审视 v2 更正，照 schema.ts:163**）。**消费方声明（⑥）**：见 PR-3 节补全的消费方清单——随本特性一并移除/改造，无孤儿消费（前提：清单全覆盖+实现时 grep 复核）。
-- 无新增表/字段。
+- 无新增表/字段（自动配对凭据形态待 U3 定——可能新增表或文件，见机制识别检查点同口径）。

 ## 影响范围

@@ -116,8 +131,8 @@ F20261118crtgr 当时选对话级是**实现轻量取舍**（设计取舍表：
 ## 风险与约束

 - U1 框架路径不确定：若只能走 wrapper（路径 B），需验证 `prepare` 钩子、结构化输出、文件变更队列等框架能力的透传完整性——不完整处如实标注能力边界，不假称等价。
-- 存量对话迁移：PR-3 落地瞬间，原绑远程机器的对话动作回落本机——呈报搭档后执行。
-- 中间态安全：PR-2 合入后 PR-3 合入前，动作级参数与对话绑定并存——**不指定=对话当前绑定（ConversationActionRouter 既有回退序，存量行为零变化）**；显式指定走新参数。绑定移除（PR-3）是行为变化点：不指定从「对话绑定」变「中枢本机」，原绑远程机器的对话动作回落本机——呈报搭档后执行。
+- 存量对话迁移：PR-3 落地时，原绑远程机器的对话的绑定列随迁移移除——其后续动作需海獭显式选机器（缺参报错含清单，自纠错）。
+- 中间态安全：PR-2 合入后 PR-3 合入前，动作级参数与对话绑定并存——**缺参一律报错含完整可用机器清单（文案统一，不分过渡期）**，海獭自纠错时自然参考对话绑定的机器；绑定移除（PR-3）后语义不变，仅 UI 选择器与绑定列消失。
 - 大爆炸风险控制：PR 序列小步走，每步 CI+对抗审视+真实验证（alpha 隔离实例 + 双 HOME connector 环境，planc 系列方法论复用）。

 ## 不兼容更新
@@ -133,17 +148,34 @@ F20261118crtgr 当时选对话级是**实现轻量取舍**（设计取舍表：
 | 不指定 machine 的行为 | **强制每次显式（搭档 11:02 拍板选 B）+ 本机概念移除**：中枢机只是执行机池一员，无特权落点；不带 machine 的执行机类工具调用报错并附可用机器清单（海獭自纠错重带参数） | 落中枢本机（隐式）/可选参数 | 搭档原话「根本就没有本机概念，就是执行机」；架构纯度——「本机默认」会永久残留第二套语义；存量调用首次踩错→报错含清单→下轮带上，LLM 自纠错成本远低于人类 CLI 断裂；高频 skill 的用法文档渐进更新 |
 | 对话绑定处理 | 彻底移除（搭档拍板「移除默认」） | 保留 current_machine_id 为默认值 | 对话↔机器绑定造成「切对话才生效」的间接层，与「海獭按动作思考用哪个」的模型冲突；保留即残留第二套语义 |
 | 感知通道 | deferred 工具 + 一句话注入 | 常驻注入机器清单 | 清单动态变化，常驻注入必过期且占上下文；deferred 按需查询保真 |
-| 离线时行为 | fail-closed 报错含可用清单 | 静默回落本机 | 沿用 #1934 不变量——回落破坏「A 让 B 执行」确定性；错误自带清单供海獭自纠错 |
+| 离线时行为 | fail-closed 报错含可用清单 | 静默换机重放 | 沿用 #1934 不变量——换机重放破坏「A 让 B 执行」确定性；错误自带清单供海獭自纠错；中枢 connector 掉线同构（另加 P0 告警） |
 | 恢复落点 | 按台账机器恢复，离线挂 attempts 队列 | 换可用机器重放 | 换机器=在错误机器上重放动作（读错文件/写错位置）；排队等待与 #2018 语义衔接 |
+| 中枢机器执行环境（v5） | **统一注册制（搭档 14:12/14:18 拍板）**：中枢自动拉起本机 connector 子进程注册，内置 local 移除 | 保留内置环境（仅 UI/语义去「本机」化） | 搭档架构模型里执行机一律由后台进程注册，无内置特例；台账/恢复链随统一简化；代价=中枢执行依赖 connector 存活（自动重启兑底+重启窗口 fail-closed，已呈知情） |

-### 机制识别检查点（判定：涉及净新增机制）
+### 机制识别检查点（判定：涉及净新增机制；v6 更新——覆盖 T2 与 T6 两个机制）

-- [x] 新增决策分支（动作级 machine 参数决定落点并写入台账——被记住且影响后续恢复）
+- [x] 新增决策分支（T2 动作级 machine 参数决定落点并写入台账——被记住且影响后续恢复）
 - [x] 新增跨模块调用路径（agent 工具面 → ExecutionMachineService）
-- [x] schema 变更（current_machine_id 删除；工具 schema 增参）
-- [ ] 新增配置字段/枚举/开关、状态生命周期、定时任务、信号类型、持久化存储——均无
+- [x] schema 变更（current_machine_id 删除；工具 schema 增参；U3 自动配对凭据持久化形态待定）
+- [x] 新增状态生命周期/后台进程（T6：connector 子进程拉起/在线/掉线/重启）
+- [x] 定时任务模式（T6：掉线自动重启退避）
+- [x] 持久化存储待定（T6：自动配对凭据——U3 spike 定形态，「无新增表」声明已作废）
+
+### 机制预算四问（T6 统一注册制，v6 新增；T2 四问见下节）
+
+- **① 谁需要它**：全系统——架构一致性（执行机一律注册制，无内置特例）；海獭受益（machine 参数统一语义，无需理解「内置 vs 设备」两套模型）；用户受益（机器列表无本机/设备之分，一份台账一份审计）。
+- **② 失败后果**：中枢执行依赖 connector 子进程存活——新单点，比任何远程机离线更严重（reviewer 指出）；兑底三层：自动重启（秒级窗口）+ fail-closed 报错（绝不静默回落）+ P0 级掉线告警（不等动作 fail 才暴露）。
+- **③ 后续机制**：它创造的新状态与可错点——子进程孤儿（设计目标任一退出路径不残留，防 #2015 复发）；凭据过期/丢失（过期恢复流程）；重启死循环（连败 high healing+人工介入点）。
+- **④ 退役条件**：若未来中枢架构改为云原生容器编排（connector 生命周期由编排器管理），中枢内 spawn 逻辑退役；若撤销注册制回到内置环境（搭档翻案），随翻案回滚。

-### 机制预算四问（动作级机器选择）
+### 准入三问（T6 补充，v6）
+
+- **① 决策者变了么**：无。落点选择权仍在海獭（T2），机器生命周期管理权仍在系统（同 remote connector 现状）；中枢机器从「特权内置」变「普通注册成员」不改变任何决策归属。
+- **② 靠自觉还是靠守卫**：凭据持久化/自动重启/级联终止是代码守卫（机械）；「无对话后台任务落点」是 agent/系统显式决策（半机械+异体审）。
+- **③ 深潜成本降了吗**：升——一份台账全机器动作，搭档对「哪个动作在哪台机器执行」的可查性从「两套系统拼图」变为单点查询；掉线即告警（P0）消除了「靠动作失败才暴露」的盲区。
+- **P0 负面清单**：不命中（统一注册制是基础设施生命周期管理，非替人做决策/预审/排优先级）。
+
+### 机制预算四问（T2 动作级机器选择）

 - **① 谁需要它**：海獭（agent）——跨机操作场景（查 B 机日志、跨机对比、远程部署验证）；用户间接需要（「A 发消息让 B 执行」由海獭在动作层兑现，而非人工切对话绑定）。
 - **② 失败后果**：选错机器=动作在错误机器执行（读错文件/写错位置）——显式选择的自然责任，工具返回带落点标记可即时发现；fail-closed 保证不静默回落放大错误。
@@ -160,13 +192,16 @@ F20261118crtgr 当时选对话级是**实现轻量取舍**（设计取舍表：
 ## 验证

 - **单测**：machine 参数分支（在线路由/离线 fail-closed 含可用清单/**缺参报错含清单**）；迁移（存量 current_machine_id 清除后对话正常）。
-- **端到端**（alpha 隔离实例 + 双 HOME connector，复用 planc 方法论）：海獭感知查询→指定 B 机跑 bash→落点正确（结果带 machine 标记）；B 机离线时指定报错含清单；中断恢复按台账机器路由、离线挂 attempts 队列衔接 #2018。
+- **端到端**（alpha 隔离实例 + 双 HOME connector，复用 planc 方法论）：海獭感知查询→指定 B 机跑 bash→落点正确（结果带 machine 标记）；B 机离线时指定报错含清单；中断恢复按台账机器路由、离线挂 attempts 队列衔接 #2018；**v6 新增（T6）：中枢 connector 自动拉起上线、kill 子进程后自动重启+P0 告警、kill 中枢后无孤儿残留、凭据过期后自愈、台账统一后 local 动作可中断恢复（U3 spike 四异常场景）**。
 - **兼容回归**：缺参报错文案含完整可用机器清单（自纠错闭环）；planc4 B1 零盲重放、B2 正向恢复回归（planc4/06、07 用例）在带参形态下重跑不退化。

-## 改动范围（预估，实现时按实际路径修编）
+## 改动范围（预估，实现时按实际路径修编；锚点基准：main `e5ed5232`，分支上因 PR-1 行号漂移 +21~31——一律以 grep -n 输出 + commit sha 为准，审视澄清采纳）

 | 文件/模块 | 操作 | 说明 |
 |---|---|---|
+| **新模块：hub-connector-spawn（中枢自动拉起）** | 增 | 中枢 connector 子进程生命周期：自动拉起/自动配对/掉线重启退避/停止级联/P0 掉线告警（U3 spike 先行） |
+| **app.ts 内置 local 移除** | 改 | Registry 硬注册与 LocalExecutionMachine 构造移除（S2 清单六处逐项） |
+| **台账统一** | 改 | local 动作并入 central registry（存量 actions.db 只读保留；Web 列表更名「动作状态」） |---|
 | src/frameworks/agent/（新 extension + pi-session-factory.ts） | 增 | list_execution_machines 注册（deferred）；多机环境注入 |
 | pi-durable（路径 A）或本仓 wrapper（路径 B） | 改 | 六动作 machine 参数（U1） |
 | src/frameworks/agent/durable-session.ts | 改 | env 回调 resolveForConversation → resolveForAction |
@@ -177,6 +212,89 @@ F20261118crtgr 当时选对话级是**实现轻量取舍**（设计取舍表：
 | web/src/pages/settings/index.tsx | 增 | 执行机区块（在线列表+配对） |
 | src/usecases/conversation/resume-interrupted-service.ts | 改 | 恢复按台账机器路由 |

+### U3 spike 结论（2026-11-25 实测，分支 feat/F20261125expot-execution-pool-pr2）
+
+spike 原型 = alpha 实例当中枢（隔离 HOME spawn 本机 connector），驱动脚本在对话工作区 `spike-u3.mjs`；实测记录四场景：
+
+- **凭据形态选型（U3①）**：复用设备侧身份文件机制——supervisor spawn 时覆写 `HOME` env 指向中枢数据目录专用子目录（身份文件 device.json + instance.lock 全随 homedir，与用户手装 connector 天然隔离，**中枢侧零新增表/文件**；devices 表已有记录 = 中枢侧持久化，配对码走既有 createPairingCode 10min TTL）。选型理由：零新机制——核销/重连/心跳/重试全部复用既有协议面。
+- **场景 1 kill 子进程（SIGKILL）**：PASS——respawn 后 1.5s 内重新上线（新 sessionId、版本协商 v2）。P0 掉线告警挂点：设备 offline 投影处（gateway/session 清扫），实现时接入 high healing。
+- **场景 2 kill 中枢/supervisor（孤儿风险实证）**：纯 spawn 模式下 **孤儿成立**——supervisor 死后 connector 被收养（ppid=1）且永不退出（无限重连退避）。**解法原型 PASS**：connector 进程内 ppid watch（周期 `process.ppid === 1` → 自退，实测父死后 200ms 内退出、扫描零残留）。产品化：PR-3 在 connector main.ts 加 ppid watch（覆盖 supervisor 自身被 SIGKILL 的场景）+ supervisor graceful 退出链 kill 子进程（覆盖正常退出）双保险。
+- **场景 3 凭据撤销**：PASS——supervisor 检测「身份在册但设备被撤销」→ 删身份文件 → 重走自动配对 → 新 deviceId 上线（旧设备行保留 offline，不互踢）。自愈闭环成立。
+- **场景 4 端口不可达（fail-closed）**：PASS——connector 自带退避指数拉开（实测 1s→2s→4s→8s 封顶），进程存活低频重试，不退出不死循环不刷屏；supervisor 层 respawn 退避同构待实现（连败 high healing 阈值建议 5 连败）。
+- U3 spike 全部异常路径自愈或 fail-closed，无孤儿（有解法）、无死循环、无互踢。
+- **PR-3 需实现的新面**（spike 原型 → 产品）：HubConnectorSupervisor（spawn/首启配对/掉线重启/P0 healing/级联终止）+ connector main.ts ppid watch + 凭据自愈检测三件。
+
+### U1 路径判定（2026-11-25 实测，分支 feat/F20261125expot-execution-pool-pr2）
+
+**结论：路径 B（本仓 wrapper）可行，路径 A（改框架包发版）排除**。判据逐项：
+
+- **①prepare 钩子透传 ✓**：wrapper 不重建执行链——`defineTool` 壳内截留 machine 参数后**委托原工具 execute（同 api 透传）**，createBashTool 的 prepare 链（command/cwd/env 改写）完整保留。证据链：bash.js:49 `requireEnv(api)` 在 execute 内取环境；prepare 是 createBashTool 构造参数（bash.d.ts:48），透传即继承。
+- **②结构化输出透传 ✓**：原 ToolRegistration 的 structuredOutputSchema 经展开复制（shellStructuredOutputSchema 同构），execute 原样返回——output/exitCode/truncated/fullOutputPath 不变。
+- **③文件变更队列透传 ✓**：edit/write 的 file-mutation-queue 在原 execute 链内，委托即继承。
+- **machine 参数→env 工厂的桥：AsyncLocalStorage**。**[已被证伪——现行方案见下节「U1 判定修正」（env 重建+api 代理）；本段保留为判定过程原貌，不按此实现]**。关键事实（源码锚点）：env 是惰性 getter（scheduler.js:2482 `env: (context) => this.#read(...)`——每次 `api.env(context)` 调用时才构造）；bash 等工具在 execute 内取 env（requireEnv）。故 wrapper 在 `machineStore.run(machine)` 内调原工具 execute，env 工厂求值时必在 ALS 栈内 → `machineStore.getStore()` 读到本次调用的 machine。本仓先例：durable-session.ts:124 env 工厂已用 otterInvokeStorage（ALS）读 conversationId，同构通道成熟。
+- **实现形态**：本仓自建 coding-tools 工厂（createBashTool/createReadTool/createWriteTool/createEditTool 均已导出，tools/index.d.ts:2-5）逐个 defineTool 包壳——schema 加必选 machine（bashSchema 未导出但同构重建，pi-schema 在依赖内）+ execute 委托。workspace 五工具（workspace_* 系，本仓 AgentTool）加参更直：parameters 加必选 machine，execute 里 `actionRunner.run(action, machine)`（ActionRunner 第二参 targetOverride 既有）。
+- **fail-closed 报错**：缺 machine → 工具报错含可用机器清单（list_execution_machines 同源快照）；指定机器不存在/离线 → 同清单报错，不静默回落（文案统一不分过渡期——大獭 12:25 自查修正口径）。
+
+### U1 判定修正（2026-11-25 下午，fresh 轮次实测证伪 ALS 桥，大獭裁决改路径）
+
+**ALS 桥不成立，修正为「wrapper 内 env 重建 + api 代理」**。证伪证据链（诚实资产，保留）：
+
+- 前世判定的穿透链是「scheduler.js:2482 env 惰性 getter → bash.js:49 execute 内 requireEnv → wrapper 在 machineStore.run() 内调原工具 execute 时 env 工厂必在 ALS 栈内」。
+- 决定性反证在 SDK 的工具执行时序（pi-durable 1.5.0 harness/tool.js，主仓与 worktree 两份拷贝一致核实）：`:388 env = await runtime.env(context)` —— env 工厂在工具 execute **之前**被调用；`:391 result = await tool.execute(args, api, context)` —— wrapper 的 execute 在此之后才跑。
+- 前世引用的「惰性」只是函数形态（`env: (context) => this.#read(...)`），tool 链路在 execute 外层主动调用了它；前世只验证了「env 取用点在 execute 内」（bash.js:49），漏验证「构造点在 execute 前」。ALS 栈里永远没有 machine 信息。
+- 若按原判定实现，产出 machine 参数恒无效的假实现（env 恒走对话绑定机），stub 测试测不出来。
+
+修正方案（大獭 15:15 裁决）：wrapper execute 内 gate 通过后按显式目标 `resolver.resolve(machineId)` 重建 env（`createExecutionEnvironment` 为轻对象构造——local/remote 两个机器实现均只 new，无连接/台账副作用），以 `{ ...api, env }` 代理对象委托原工具 execute；SDK 先构造的默认 env 被丢弃（一次轻量浪费）。SDK 会话 cwd 由 durable-session env 工厂记录（`lastEnvCwd`，tool.js:388 先于 :391 的时序由 SDK 保证）。
+
+- 弃 ALS+beforeTool 标记的取舍：beforeTool 在 env 构造前跑且能改 args，理论可行；但其 per-call 隔离性依赖 SDK 调度的异步资源边界，静态读码无法排除共享链污染——一旦污染是**静默串机**（A 的命令跑上 B 指定的机器），fail-closed 架构下最坏故障形态。代理方案的失败形态全是吵闹失败（代理 api 守卫断言关键面齐全，spread 丢成员即抛错），并发绝对安全。
+- 三项透传判定不受影响：prepare 链/结构化输出/文件变更队列都在原 execute 链内，与 env 桥机制无关，委托即继承（实现与测试见 PR-2 实现记录节）。
+
+## PR-2 实现记录（2026-11-25，feat/F20261125expot-execution-pool-pr2）
+
+### 实现清单
+
+- `src/usecases/execution/execution-machine-gate.ts`（新）：执行机落点 fail-closed 闸——三失败路径（缺参/不在池/离线）统一文案骨架（原因 + fail-closed 声明 + 机器池全量清单 + 重试指引），池快照与 list_execution_machines 工具、/api/execution-machines 同源；池回调缺省时降级为形态校验 + 指向感知工具；池回调抛错 fail-loud 拒绝执行。
+- `src/frameworks/agent/machine-scoped-coding-tools.ts`（新）：SDK 四工具（bash/read/write/edit）逐个包壳——schema 重组加 machine 参数（opt(str)，description 承载必选语义；不进 required——pi-schema obj 重组会让非 opt 字段隐式必选，required 拦截走 harness 通用文案丢清单）；execute 前置 gate → 显式 resolve → env 重建 → 代理 api 委托；prepareArguments 透传并保全 machine 字段（edit 单 edit 形态修复后回填）；落点标记走 api.diagnostic（code=execution_machine）。
+- `src/frameworks/agent/durable-session.ts`：machinePool 装配时四工具换执行机壳（缺省退 SDK 原生——旧测试/旧装配零变化；生产装配恒注入池）；env 工厂记录 `lastEnvCwd`（壳重建 env 的同源 cwd）。
+- `src/bootstrap/platforms.ts` + `pi-session-factory.ts`：machinePool 装配链透传（createAgentGateway → initAgentSessionFactory → DurableSessionOptions）。
+- `src/interface-adapters/agent-runtime/tools/workspace-tools.ts`：五工具（info/list/read/write/delete）加 machine 参数（JSON Schema 形态，同样不进 required）；execute 先 gate 再 `actionRunner.run(action, machineId)`（显式目标位，ConversationActionRouter 显式优先）；落点标记——info 的 JSON 加 machine 字段、list/write/delete 返回文本头部 machine 行、read 不加（内容原样返回可直接解析，读内容的落点核对走清单与动作台账）。
+- 身份注入句（BIG/SMALL_OTTER.md）：多机环境说明 + machine 必选语义 + 感知工具指引（见「身份注入与 ratchet 拼接」节处置记录）。
+
+### 增量设计取舍
+
+| 取舍 | 决策 | 理由 |
+|---|---|---|
+| machine 不进 schema required | opt(str) + description 声明必选，运行时 gate 强制 | required 拦截的错误走 harness 通用校验文案，机器清单丢失——「缺参报错含完整可用清单（自纠错闭环）」必须在工具返回层兑付 |
+| 缺池装配退 SDK 原生工具 | machinePool 条件装配（同 list_execution_machines 注册条件模式） | 旧测试/旧装配零变化；生产装配恒有池（app.ts PR-1 已接），生产语义恒为机器必选；wrapper 自身行为由单测独立兑付 |
+| 落点标记形态 | SDK 四工具走 diagnostic（不污染结构化输出流）；workspace_info 包 JSON 字段、list/write/delete 头部行、read 不加 | diagnostic 是 SDK 原生的 model-visible 通道；read 返回的文件内容需可直接 JSON.parse/复制，头部行有真实破坏性 |
+| 代理 api 守卫 | 每次委托前键存在性检查（非值检查——outputWindow 在真 SDK 本就有合法 undefined 态），缺键即抛错 | spread 复制依赖 SDK api 对象枚举面；SDK 升级改内部形态时吵着失败而非静默丢功能 |
+
+### 验收断言（机械可验证）
+
+| 场景 | 操作 | 预期结果 |
+|---|---|---|
+| gate 单测 | `npx vitest run tests/usecases/execution/execution-machine-gate.test.ts` | 7/7 PASS（三失败路径文案/通过路径/池抛错 fail-loud/缺池降级） |
+| 壳行为单测 | `npx vitest run tests/frameworks/agent/machine-scoped-coding-tools.test.ts` | 11/11 PASS（schema 面/三失败路径/env 重建真链 bash 真跑/TOCTOU 吵闹失败/代理守卫/write 真链/edit 修复保全） |
+| workspace 工具单测 | `npx vitest run tests/interface-adapters/agent-runtime/tools/workspace-tools.test.ts` | 17/17 PASS（三态/targetOverride 透传/落点标记/既有安全边界不退化/缺池降级） |
+| 全量回归 | `npx vitest run` | 546 文件 6971 测试全绿（exit=0） |
+| alpha 端到端 | alpha 实例真实 invoke：缺 machine 调 bash → 报错含清单 → 带 machine 自纠错重试成功 + 落点标记 | 证据落对话工作区 expool-pr2/ |
+| tsc/eslint | 全量 | PASS |
+
+### 最简实现检查
+
+已过：更简路径是重写四工具执行逻辑直接用 ActionRunner（shell.exec/file.* 动作）——放弃 prepare 链/截断/图片/edit diff/file-mutation-queue 全部框架能力，能力不等价，弃。gate 单点复用（SDK 壳与 workspace 工具同一函数），文案单一真相源。
+
+### 负向验收
+
+- **本次变更破坏的旧契约**：workspace 五工具与 SDK 四工具的调用面新增必选 machine 参数（不带即报错）——这是特性目标本身（搭档拍板的动作级显式选择），受影响的既有测试已随行为更新（conversation-scope / workspace-tools）；不带 machine 的历史调用形态在合入后首次踩错会得到含清单的报错（自纠错闭环）。
+- **绕过的既有保护**：无。gate 是新增校验层；env 重建不绕过 BashGuard（守卫在 beforeTool 层照常拦截）与 RecordingNodeExecutionEnv 的副作用入账（壳构造的 env 同为 RecordingNodeExecutionEnv/RemoteExecutionEnv）。
+
+### 未覆盖边界（如实）
+
+- 远端 connector 机器的 env 重建真链未在 alpha 验证（alpha 无已配对设备）——remote 侧由 ConversationActionRouter.resolve 既有测试与单测 stub 覆盖；双 HOME connector 端到端随特性整体验收推进。
+- 代理 api 守卫覆盖的是当前 SDK api 字面量的枚举面——SDK 大版本升级若改变 api 形态，守卫会吵着失败（设计预期），届时按新形态扩关键面清单。
+- compaction 期间 SDK 内部工具（若有）不经壳，走 SDK 原生链路——未验证，预期不受影响。
+
 ## PR-1 感知层实现记录（2026-11-25，feat/F20261125expot-execution-pool-pr1）

 ### 实现清单
@@ -203,6 +321,8 @@ F20261118crtgr 当时选对话级是**实现轻量取舍**（设计取舍表：

 **裁决**：注入句推迟到 PR-2——届时工具带 machine 必选语义，注入文案一遍写对；按实现者建议方案（删 BIG 黑话表低频词条+宁提预算也不碰「来源核验」安全语义）执行，属 SYSTEM.md 注入面+CI 守卫参数变更（高杠杆），届时单独呈搭档拍板。PR-1 不注入，此项解除阻塞。

+**PR-2 落地处置（2026-11-25）**：已按裁决方案执行——BIG 删黑话表低频词条（ToolContext/otterCard.submit/卡片高度，约 200B）+ 新增「执行机（动作落点）」节；SMALL 在「我的位置」节追加 machine 必选条目 + 压缩「记忆先行」段（约 90B，保留语义骨架）。剩余增量走 ratchet 预算提升（闸内建通道）：BIG 16143→16350（+207）、SMALL 8442→8643（+201），lint-prompt-size.mjs 注释处已记录理由；未触碰「来源核验」安全语义。高杠杆面变更随本 PR 单独 commit，由大獭单独呈搭档确认。
+
 以下为原始分析存档：

 方案 T1 要求「身份注入补一句多机环境说明」（中性存在性陈述 + 查询方式）。实现时撞 lint-prompt-size.mjs 核心常驻 prompt 只降 ratchet：BIG_OTTER.md 16143B / SMALL_OTTER.md 8442B（= main 现值，任何增长即红，本次注入句 +438B/文件）。闸立法背景是拦「修 bug 顺带加一段」的纯加法膨胀，同时内建「提升预算须单独评审」通道。处置：**注入句拆出本 PR**（工具注册/检索/执行不依赖它，功能主体完整），选项呈大獭裁决：
```
