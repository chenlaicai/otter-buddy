---
id: F20261126expac
title: "执行机资源池 PR-4 原机恢复：实现、异常链与检视接续"
summary: "承载 PR-4 相对 PR-3 主方案快照的全部原始增量；主方案与 main 一致，恢复衔接记录独立保存。"
doc_type: feature
change_type: feature
capability_test: "n/a: 本文档只迁移 PR-4 的既有恢复实现、真实异常链与检视记录；行为验证仍由原测试与 CI 承载"
created_in_conversation: 6af46649-f93f-4c5b-a6d2-245a4ed33e9f
from:
  - F20261126expot
causal_links:
  - issue:#1868
tags: [execution-machine, recovery, documentation, stacked-squash]
modules: [usecases/conversation, frameworks/execution, usecases/execution]
created_at: 2026-11-26
intent:
  problem: "PR-1 squash 合入后，PR-4 不得再修改主方案历史快照，但原机恢复的设计、真实异常链、风险回滚与检视处置必须保留"
  expected_effect: "主方案与 main 逐字一致；PR-4 原始文档增量在本接续文档完整可检索，历史文档闸在 PR-4 base 下通过"
  verify_by:
    type: static_only
---

# 执行机资源池 PR-4 文档接续

## 迁移关系

- 主文档：`F20261126expot`；本文件承载 PR-4 接续记录，不改写主文档已合入内容。
- 原始已审 PR-4 树：`779889269574fa92e26403bd75f3bc6f7457d219`；原始文档对比 base：已审 PR-3 `90bc42bc887721ad57f49ee4cc187d3bd96ba818`。
- 主文档在整理后恢复为 main `31e407341bb115fd6b90aae3a1b16e8b3880b7dc` 的版本。本层的预检三关、设计取舍、实现清单、真实异常链、负向验收、最简检查、风险/回滚、未覆盖边界与首轮检视处置全部迁到本文件。
- #2018 的 `F20261124rscap` 文档不是主方案快照，仍作为本层独立新增文档原样保留，不并入本接续文档。

## 保留方式

为避免人工摘抄造成语义漂移，下面原样保存「原始已审 PR-3 文档 → 原始已审 PR-4 文档」的 unified diff。新增内容和原位置均保留；仅对 diff 文本自身的行尾空白机械去尾以满足 whitespace 闸，其他字符不变。这不是第二份完整方案，也不引入新设计。

```diff
diff --git a/docs/features/2026/11/26/F20261126expot-execution-machine-pool.md b/docs/features/2026/11/26/F20261126expot-execution-machine-pool.md
index 194d468b..48e8dd7e 100644
--- a/docs/features/2026/11/26/F20261126expot-execution-machine-pool.md
+++ b/docs/features/2026/11/26/F20261126expot-execution-machine-pool.md
@@ -249,6 +249,73 @@ spike 原型 = alpha 实例当中枢（隔离 HOME spawn 本机 connector），
 - 弃 ALS+beforeTool 标记的取舍：beforeTool 在 env 构造前跑且能改 args，理论可行；但其 per-call 隔离性依赖 SDK 调度的异步资源边界，静态读码无法排除共享链污染——一旦污染是**静默串机**（A 的命令跑上 B 指定的机器），fail-closed 架构下最坏故障形态。代理方案的失败形态全是吵闹失败（代理 api 守卫断言关键面齐全，spread 丢成员即抛错），并发绝对安全。
 - 三项透传判定不受影响：prepare 链/结构化输出/文件变更队列都在原 execute 链内，与 env 桥机制无关，委托即继承（实现与测试见 PR-2 实现记录节）。

+## PR-4 预检结论与实现取舍（2026-11-25，feat/F20261125expot-execution-pool-pr4）
+
+### 三关核实
+
+- **实际恢复路径**：PR-3 后 `ResumeInterruptedService` 已只读 central 台账生成摘要，但仍在认领后直接重启 invoke；没有按本次恢复链的动作记录检查原机，也没有设备上线后的恢复触发。需要补路由与触发，不重复建设 central 台账或恢复队列。
+- **机器标识映射**：`remote_action_requests.device_id` 由 `RemoteExecutionMachine.id` 写入；connector 上线时同一个 `device.id` 注册为 Registry key 并进入机器池快照。因此台账 deviceId 可直接对机器池做精确匹配，无需经对话或机器名转换。
+- **既有安全边界**：#2018 的 attempts 继承、认领、第 6 轮 exhausted + high healing 保持；succeeded 不重做、unknown 先检查、interrupted 才可重做的摘要裁决不变。整合只 cherry-pick 其三个提交，不改旧分支。
+
+### 设计面与机制判定
+
+- **核心接口**：central 台账增加按 invokeId 的只读查询；恢复服务沿 invoke.triggerEntryId 遍历祖先并收集全部原 deviceId，visited 防环。恢复引导与 invoke 参数携带 `requiredExecutionMachineIds`，经调度链、AgentInvoker、InvokeOptions 传入既有 invoke ALS。
+- **执行闸**：统一 `gateExecutionMachine` 在恢复上下文中只接受原 machine 集合，SDK 四工具、workspace 五工具和上传共用该闸；普通 invoke 不携带集合，动作级自由选择不变。
+- **离线语义**：认领前检查所有原机都在机器池且在线；离线、设备记录缺失、台账/invoke/机器池查询失败均保持 pending，不点火、不增加 attempts。connector 上线事件重入同一恢复服务，只处理包含该设备的恢复链。
+- **模块边界**：不新增表、队列、计时器或第二套恢复链；网关只新增上线通知，恢复编排仍在 ResumeInterruptedService，机器授权与执行仍归 Registry/gate。
+- **被否替代**：仅把原机写进提示词而没有 gate 约束，会把「不换机」降级成模型自觉；按当前可用机器重试则破坏「A 让 B 执行」的确定性；另建 offline 动作队列会与 restart_pending_resumes 双写。
+- **机制识别**：新增 device-online 到既有恢复服务的跨模块调用与恢复 invoke 的 machine 约束分支，属于本方案 T5 已定义的恢复衔接，不是新产品机制。复用既有 invoke 上下文、台账、机器池与恢复认领，无新增持久化状态。
+
+## PR-4 实现记录（2026-11-25，feat/F20261125expot-execution-pool-pr4）
+
+### 实现清单与栈归属
+
+- **恢复路由（commit `3c70b2af`，首轮检视后收紧）**：central 台账新增 `listByInvoke` 只读查询；恢复服务沿 `invoke.triggerEntryId` 遍历当前恢复轮及祖先动作，visited 防环，收集真实 `deviceId` 集合。普通首闯的入口 entry 由 `entryRepo` 证实后才作为正常终点；当前/祖先 invoke 记录缺失、任一 invoke 动作达到查询上限、台账查询失败、空 deviceId 或机器池查询失败均保持 pending，不认领、不点火、不增加 attempts。
+- **原机等待与上线触发（同 commit，首轮检视后补告警）**：所有原机都存在于统一机器池且在线才允许认领；离线或记录缺失时继续等待，其他机器在线也不替代。等待写 medium healing，context 含 invokeId 与不可用 machineIds，同进程按恢复项+机器集去重。connector 完成 hello、进入在线表后触发同一恢复服务定向重查；上线监听先于受管 connector 启动装配，避免首次 hello 丢事件。上线事件不重放动作，只重查既有恢复队列。
+- **恢复轮工具约束（同 commit）**：`requiredExecutionMachineIds` 经 DispatchChain、AgentInvoker、InvokeOptions 传入既有 invoke ALS；SDK 四工具、workspace 五工具和上传共用的 `gateExecutionMachine` 拒绝非原机。普通 invoke 不携带该集合，动作级自由选择不变。
+- **attempts 整合**：本 stacked 分支吸收 #2018 的三个提交（本栈为 `51439f7f`、`a57f8282`、`c8d479b2`），保留普通首闯 attempts=0、恢复者再崩溃继承、第五轮可恢复、第六轮 exhausted + high healing。最终栈接管 `Closes #2016`；#2018 不应再双重合入。
+
+### 验收断言与实测证据
+
+| 场景 | 操作 | 结果 |
+|---|---|---|
+| 原机离线等待 | 真实驱动在中断后同时杀中枢与原机，再仅重启中枢 | PASS：queue=pending、attempts=0、recoveryInvokes=[]；设备效果文件仍只有 `PR4_ONCE` 一行 |
+| 原机上线恢复 | 以同一独立 HOME 重启原 connector，观察恢复 invoke 与 central 台账 | PASS：queue=done、attempts=1；首轮处置后真实重跑的原机为 `connector-1cdce430`，恢复 invoke metadata 只含该原机，恢复动作落在该原机并成功 |
+| unsafe 不盲放 | 对账原 actionId、请求数与设备文件行数 | PASS：原 `shell.exec` actionId 只有一条且保持 unknown，初始请求数=1；恢复使用新 actionId，设备文件最终仍仅一行 |
+| 恢复者链级计数 | 跑 #2018 继承/第五轮/第六轮定向测试，并复用其真实第六轮证据 | PASS：普通首闯=0、第五轮允许、第六轮 exhausted + high healing；整合后进入全量回归。真实六次崩溃未在本栈重复执行 |
+| 缺失证据 fail-closed | 单测注入台账/机器池错误、当前/祖先 invoke 缺失、单 invoke 达到 1000 动作上限、设备记录缺失与其他机上线 | PASS：均保持 pending、attempts=0、零恢复调用，不带空/部分机器集换机 |
+| 原机等待告警 | 同一恢复项连续两次离线重查；真实异常链重启后查 healing | PASS：单测仅一条 medium healing；真实重跑同样仅一条，含 conversationId/invokeId/machineIds（`real-recovery-healing-review1.json`）；恢复仍 pending、attempts=0 |
+| 首轮检视补强 | 恢复服务 + 原机 gate + connector gateway 定向；tsc/eslint | PASS：3 文件 / 60 测试（`review1-targeted.log`） |
+| 全量后端 | `npx vitest run` | 首轮前 PASS：546 文件 / 6962 测试（`root-vitest.log`）；首轮处置后串行复跑 PASS：546 文件 / 6965 测试（`root-vitest-review1.log`） |
+| 构建与文档门 | `npm run build`、`npm run lint:intent` 及相关 lint/锚点检查 | PASS：TypeScript、connector closure、tarball/app 打包成功（`build-review1.log`）；intent 1110 docs OK、0 error（638 个存量 warning） |
+
+真实驱动结构化终账在对话工作区 `expool-pr4/real-recovery-summary.json`（首轮处置后已完整重跑），设备效果为 `original-effect.txt`，真实等待告警为 `real-recovery-healing-review1.json`，中枢与原机日志同目录。首次驱动曾把「恢复者再次崩溃才会产生的子队列」当成正向恢复必须出现的条件，因而在恢复轮尚未 settle 时判为不通过；修正驱动等待条件后**完整重跑**上述异常链得到 PASS，业务代码没有为迎合误判而修改。
+
+### 负向验收
+
+- **破坏的旧契约**：台账或原机证据不足时，不再退回无摘要旧文案继续恢复，而是保持 pending；祖先断链与动作数达到查询上限也不再使用 partial evidence。这是有意的 fail-closed 收紧；原机永久不可用需要人工核查动作终态与设备记录，不能靠换机自动恢复。
+- **绕过的既有保护**：无。未改 WSS 协议、unsafe unknown 裁决、一次性配对、恢复认领或五态收尾；新增 gate 只缩小恢复轮可选机器集合，设备上线通知本身不执行设备动作。
+- **数据与旧资源**：不新增表、列或第二套恢复队列；复用 `restart_pending_resumes`、central 台账、统一机器池和 invoke ALS，无旧文件或配置待清理。
+
+### 最简实现检查
+
+已过。恢复路由只新增一个纯查询/判定模块和中央台账按 invoke 的只读接口；上线触发、attempts、pending 队列与执行授权均复用既有机制。另建议备机队列或恢复专用执行协议会减少本 PR 的表面分支，却形成双写与第二真相源，弃。
+
+### 风险、回滚与未覆盖边界
+
+- 原机永久丢失或有动作台账但设备记录被删时，恢复项会有意长期 pending；medium healing 以 invokeId + machineIds 提供人工对账入口，同进程去重，不自动换机。跨重启可再报一次，不做跨进程持久去重。
+- 真实异常链覆盖远程原机的中断→离线等待→同身份上线→单次设备效果；中枢机 ID 与多机集合由单测覆盖，本轮未另做中枢机/多机链的真实崩溃演练。
+- 回滚到 PR-3 head `7d427bb4` 不需要数据库逆向迁移；但会同时失去原机路由约束和 #2018 链级 attempts 修复。回滚前必须停新版恢复服务并保留 pending/unknown 台账供人工对账，不能让旧版在证据不全时直接续跑。
+- Golden Gate：n/a（相对 PR-3 基线无 prompt、skill 或 tool description 行为语义改动）。
+
+### 首轮检视处置（2026-11-25）
+
+| 发现 | 更好/更差判断 | 处置与验证 |
+|---|---|---|
+| 祖先 invoke 缺失仍 break，可能用空/部分机器集恢复 | 改了更好，接受并修复 | 只有 entryRepo 中真实存在的入口 entry 才能正常终止；祖先 invoke 与入口均缺失即保持 pending。补「祖先缺失+当前无动作」判别测试，零 fire、attempts=0；普通用户入口恢复回归仍通过 |
+| 原机永久离线只有日志，人工对账缺触发信号 | 改了更好，接受并修复 | 既有 high healing 仅覆盖中枢受管 connector，普通远程原机无恢复项定位；新增 medium healing，含 conversationId/invokeId/machineIds，并按恢复项+机器集做进程内去重，重复重查只写一条 |
+| 单 invoke 达到动作查询上限仍带 partial evidence 恢复 | 改了更好，接受并修复 | 达到上限直接判证据不完整并保持 pending，不再只给摘要警告；补零 fire、attempts=0 测试，删除已不可达的 truncated 摘要分支 |
+
 ## PR-3 实现记录（2026-11-25，feat/F20261125expot-execution-pool-pr3）

 ### 实现清单
```
