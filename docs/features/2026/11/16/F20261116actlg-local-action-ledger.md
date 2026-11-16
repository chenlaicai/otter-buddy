---
id: F20261116actlg
title: 本机动作记录与恢复（动作台账机制层）
doc_type: feature
summary: |
  落实 #1868 阶段 3 机制层（PR-A）：给本机执行机的副作用动作（文件写/追加/改名/删除、
  bash 执行）建每机一库的动作台账——五态真实状态 + content hash + 开机清扫裁决；
  机器侧文件写改临时文件+rename 原子落位；ActionRunner 增 actionId 去重协议位。
  pi-durable 仍是恢复主干（transcript/task 状态/unsafe 不重放全不动），台账是它
  明确划出边界不管的那一层：机器侧副作用真相。
change_type: feature
tags: [execution-machine, action-ledger, atomic-write, durable, recovery]
modules:
  - src/entities/execution/action-record.ts
  - src/usecases/ports/action-ledger.ts
  - src/usecases/ports/execution-machine.ts
  - src/frameworks/execution
  - src/frameworks/file-system/node-workspace-gateway.ts
  - src/frameworks/agent/durable-session.ts
  - src/frameworks/agent/model-runtime-registry.ts
  - src/app.ts
capability_test: "n/a: 纯执行机记录层，工具名称/参数/输出与本机行为不变，LLM 决策路径不参与；台账契约由单测+真实 durable 工具链回归覆盖"
created_in_conversation: 6af46649-f93f-4c5b-a6d2-245a4ed33e9f
created_at: 2026-11-16
intent:
  problem: "pi-durable 的中断结算只敢说 may have partially run（tool.js:152）——崩溃后「写命令执行到一半到底成没成」对话持久层结构上无法回答；文件写非原子会留半截文件；invoke 级恢复（restart_pending_resumes）续跑时不知道哪些动作实际已完成"
  expected_effect: "副作用动作入账可查（五态+hash+归属）；开机清扫把「可能跑了一半」核成确定裁决（hash 命中→succeeded / 不中→interrupted / bash→unknown）；写动作原子落位；已完成动作按 actionId 去重不重做"
  verify_by:
    type: behavior_check
---

# F20261116actlg：本机动作记录与恢复（动作台账机制层）

## 背景

阶段 1（F20261113exmch）建立执行机抽象，阶段 2（F20261113uaccs）统一接入登录。阶段 3
按 #1868 阶段表：「local 接统一动作状态+本地台账，原子写/actionId 去重/五态」。

**与 pi-durable 的分工（搭档 2026-11-16 质询后定调，源码证据）**：
- pi-durable 提供并继续承担：ToolTask 执行前 checkpoint（`{phase:"execute", arguments, replay}`，
  tool.js:108）、恢复期 replay 规则（safe 自动重跑/unsafe 不重跑，tool.js:113-121）、中断结算
  文案自带诚实边界（"may have partially run"，tool.js:152）、restarts+restartLimit、durable
  transcript、whenBusy 单 writer。
- 它结构上不管（ExecutionEnv 即其划出的边界）：副作用是否真的发生/在哪个设备/结果文件在哪/
  跨轮次逻辑去重。#1868 §3.D 原文分层：「云端 durable checkpoint 保存对话、工具调用、编排
  进度；执行机本地保存轻量动作台账（动作真实状态与结果），不保存第二份主记忆。」

本 PR（PR-A 机制层）交付台账/原子写/去重/清扫；恢复链接线（claim 三列扩展 + 恢复摘要内嵌）
在 PR-B 交付，不改本 PR 任何恢复行为。

## 目标

- T1 动作台账：`data/execution-machines/local/actions.db`（每机一库，sqlite/WAL），副作用动作
  五态 + hash + 归属（invoke/对话/toolCall）。
- T2 原子写：机器侧全量文件写（RecordingNodeExecutionEnv.writeFile 与
  NodeWorkspaceGateway.writeFile）改临时文件→rename 原子落位，mode 保留、symlink 跟随。
- T3 actionId 去重协议：ActionRunner 增可选 `options.actionId`；同 id 已 succeeded 直接返回
  已记录结果不执行（阶段 4 connector 重投递的幂等底座）。
- T4 开机清扫：旧 bootEpoch 的 running 行裁决——文件写 hash 核对（命中→succeeded 且回执修复），
  幂等类→interrupted，bash→unknown（转检查）。
- T5 归属传播：OtterInvokeContext 增 currentInvokeId/currentToolCallId（ALS），DurableSession
  prompt/beforeTool 写入，记录层读取。

## 非目标（阶段 3 整体的其余部分 + 明确不做）

- PR-B 内容：restart_pending_resumes 三列迁移（claim_token/boot_epoch/recovery_invoke_id）、
  恢复消息内嵌台账摘要——本 PR 不动恢复链任何行为。
- 远程执行机/connector/onlineSession（阶段 4）：表结构已预留 device_id/online_session_id 列。
- Web 执行记录 UI、LLM 台账查询工具（阶段 5）。
- unknown 动作自动处置引擎（只呈现+提示检查；处置决策归獭/人）。
- 只读操作不入账；中枢直写路径（HTTP 工作区 API/记忆/文档同步）不入账（非 invoke 归属）。
- 不动 pi-durable unsafe replay 语义、不动守卫链（beforeTool 拦截=动作不发生=无台账行）。
- SDK `replay:"safe"` 自动重跑机制存在但本阶段不启用（recoverAfterReopen abort-all 保持），
  列为后续演进项。

## 方案设计

### 模块切分

- `src/entities/execution/action-record.ts`：ActionRecord/五态/StartActionInput/SettleVerdict。
- `src/usecases/ports/action-ledger.ts`：台账端口（start/settle/getByActionId/listByInvoke/sweepStaleBoot/close）。
- `src/frameworks/execution/ledger/sqlite-action-ledger.ts`：实现（WAL；meta.boot_seq 单调
  纪元；清扫裁决；终态行 14 天/10 万行修剪，非终态永不修剪）。
- `src/frameworks/execution/recording-node-execution-env.ts`：RecordingNodeExecutionEnv extends
  NodeExecutionEnv——拦截 writeFile（原子化+hash）/appendFile/truncateFile/renameFile/remove/
  createDir/exec 入账，只读直通；台账失败绝不打断真实动作（recordQuietly）。
- `src/frameworks/execution/local-execution-machine.ts`：ledger 注入；workspace.write/delete
  入账（source=workspace，conversationId 归属）；createExecutionEnvironment 返回记录 env。
- `src/usecases/ports/execution-machine.ts` + registry：ActionRunner 增可选 `options?: {actionId?}`。
- `src/frameworks/file-system/node-workspace-gateway.ts`：writeFile 原子化（temp+rename+mode 保留+realpath）。
- `src/frameworks/agent/model-runtime-registry.ts` + `durable-session.ts`：ALS 两字段；
  prompt 写 invokeId（顺带摘除原 scope.currentInvokeId 死分支 fallback）、beforeTool 写 call.id。
- `src/app.ts`：组合根开台账（失败降级无台账运行，动作照常）+ await open()（清扫先于恢复链）
  + dispose 关闭。

### 关键数据结构

```sql
execution_actions (
  action_id PK, device_id, online_session_id NULL,   -- 阶段 4 前恒 'local'/NULL
  invoke_id, conversation_id, tool_call_id,          -- ALS 归属
  source 'sdk-env'|'workspace'|'internal', kind,     -- file.write/append/truncate/rename/remove/mkdir | shell.exec | workspace.write/delete
  target, content_hash, content_bytes,               -- hash 核对依据
  status running|succeeded|failed|interrupted|unknown,
  error, result_summary, boot_epoch, pid, started_at, settled_at
)
```

五态：行态四（running/succeeded/failed/interrupted/unknown）+ 查询态一（not_found=按
actionId 查询无行）。语义对齐 #1868 §3.D：interrupted=确认未完成可安全重做；unknown=无法
判定转检查（bash 崩溃且回执）；bash 非零退出码记 succeeded——「动作跑完了」是事实，退出码是数据。

actionId 铸造：sdk-env 面 `${toolCallId}:${opSeq}`；workspace 面 `${attribution}:ws:${seq}`；
ALS 外 `internal:${seq}`。去重协议仅对 succeeded 生效（interrupted/failed/unknown 重开新一轮，重做合法）。

### 设计取舍

| 取舍 | 决策 | 被否替代 | 理由 |
|---|---|---|---|
| 台账存储 | 每机独立 sqlite | 主库加表 / JSONL | 「执行机本地真相」语义（远程机各自持有，中枢经机器接口查询）；热路径与主库隔离；状态更新需索引 |
| 台账 vs pi-durable | 裁决层不重建恢复 | 自实现任务恢复 | pi-durable 已有 transcript/task 状态/unsafe 不重放；台账只补它管不了的副作用验证（伙伴质询后定调） |
| 去重范围 | 仅 succeeded 去重 | 全终态去重 | interrupted=确认未完成，重做是完成它的合法路径；failed 同理可重试 |
| 原子写位置 | env 子类 + gateway 双改 | patch SDK | SDK writeFile 直接覆写（已核实 node.js 源码）；patch 维护成本高于本仓包装 |
| symlink 处理 | realpath 跟随写真实文件 | rename 替换链接 | 保持「写链接指向的文件」语义，不悄悄改变路径性质 |
| 记录失败语义 | 静默降级+warn（动作照常） | 台账失败阻断动作 | 台账是恢复增强面不是控制面；阻断会把观测故障放大成业务故障 |
| bash 退出码 | 非零也是 succeeded | 非零记 failed | failed 留给确定性未达成（spawn 失败从未跑起来）；退出码是结果数据 |
| timeout/abort 杀进程 | interrupted | failed / unknown | 我们主动确定性停止：未完成确定，重做合法；unknown 留给崩溃且回执（清扫裁决） |

### 机制识别检查点

- 新增持久化存储：是（每机 actions.db + meta 表）。
- 新增状态生命周期：是（动作行五态）。
- 新增信号/消息格式：是（actionId 铸造格式、resultSummary JSON）。
- 新增会被记住的决策分支：是（去重仅 succeeded、清扫裁决规则）。
- 新增定时任务/后台进程：否（清扫随开机 open() 同步完成）。
- 新增配置字段：否（保留策略为固定缺省，未暴露配置）。
- 新增跨模块调用路径：是（app→ledger→machine→env/gateway）。

结论：修法决策树④新增机制。既有机制内修无法回答「副作用到底成没成」——pi-durable 立场
上不验证磁盘，invoke_events 是对话观察层，均无机器侧真相载体。

### 机制预算四问

1. **谁需要它**：#1868 已拍板的可恢复执行地基；PR-B 恢复摘要、阶段 4 connector 幂等重投递、
   阶段 5 Web 执行记录都消费台账。
2. **失败后果**：台账失败→记录降级（动作照常，warn 日志）；原子写失败→返回 err 不留半截文件；
   清扫误判上限=把 succeeded 误判 interrupted（重做幂等写）或反之（hash 误命中需要 sha256 碰撞）。
3. **后续机制**：保留策略/去重协议/清扫规则漂移风险由单测钉死；远程机接入时 ledger 接口即
   connector 查询面，无需迁移。
4. **退役条件**：若 pi-durable 未来原生提供副作用验证层（ExecutionEnv 级 receipt/hash），
   且所有调用方迁移，本台账可退役；replay:"safe" 路径成熟后部分幂等工具可切 SDK 原生恢复。

### 机制提案准入三问

1. **决策者变了么**：没有。台账只记录不决策；清扫裁决是机械规则（hash 比对）；unknown 的
   处置决策留给人/獭（PR-B 摘要只呈现不指令）。
2. **靠自觉还是靠守卫**：五态迁移/去重/清扫/原子性/mode 保留/symlink/降级均有单测；真实
   durable 工具链回归钉死 ALS 归属穿透。
3. **深潜成本降了吗**：是。副作用真相集中一张表+一个端口，恢复摘要/执行记录/connector 幂等
   三个未来消费者不再各自挖 transcript。
4. **P0 负面清单**：未命中；不自动重试任何动作（含 unknown）、不替人裁决、不自动巡检。

## 影响范围

- 行为变化：机器侧文件写原子化（rename 替换 inode；watcher 收到路径变更语义兼容；mode 保留；
  symlink 跟随）。
- 台账文件：`data/execution-machines/local/actions.db`（WAL，随 data 目录，不迁移不备份语义）。
- workspace 工具/durable coding tools 的名称、参数、输出完全不变；恢复链行为零变化（PR-B 前台
  账只写不读）。

## 风险与约束

- rename 原子写替换 inode：依赖 inode 的外部观察者理论上受影响（盘点未发现消费者）。
- 同毫秒动作的台账排序退化 action_id 字典序（listByInvoke ORDER BY started_at, action_id）。
- ALS 外（internal）动作归属为空——SDK 内部若直接用 env 做文件操作会记 internal 行，属预期。
- 台账记命令与路径（截断 512B）——只落本机 data/，不上云不入主记忆，14 天修剪。

## 验收标准

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 副作用入账 | 真实 durable write/bash（faux 驱动） | 行含 invokeId/toolCallId，actionId=`${toolCallId}:${seq}`，succeeded+hash/exitCode |
| workspace 入账 | machine.run workspace.write/delete | source=workspace、conversationId 归属、deleted 摘要 |
| 五态 | start→settle / abort→interrupted / spawn 失败→failed / 清扫 exec→unknown | 状态机单测全覆盖 |
| 去重 | 同 actionId succeeded 后再执行 | 不执行、返回已记录结果、文件未变；interrupted/failed/unknown 重开新一轮 |
| 清扫 | 旧纪元 running：写 hash 命中/不中、append 尾核对、幂等类、bash | succeeded(receiptRecovered)/interrupted/unknown 各就各位 |
| 原子写 | 写失败（目标是目录）/覆盖/symlink | err 无临时残留、mode 保留、链接未被替换 |
| 降级 | ledger 抛错 / ledger=null | 动作照常执行，仅 warn |
| 行为不变 | 既有 workspace/durable/registry 测试 + 全量回归 | 全绿 |

## Discovered Issues

- 测试暴露（非本 PR 引入的存量脆弱点）：DurableSession 直接调用路径下 ALS store 存在但
  haltRegistry 缺失时，haltToolCallGuard 会以 `Cannot read properties of undefined` 阻断全部
  工具；生产组合根恒装配 haltRegistry，测试已补桩。如后续要支持裸 DurableSession 场景需
  加缺省守卫，本 PR 不扩面。

## Verification

| 验证 | 结果 |
|---|---|
| `npx tsc --noEmit` | PASS |
| 台账单测（sqlite-action-ledger） | PASS：13 用例——生命周期/去重协议/清扫五路裁决/修剪/纪元单调 |
| 记录 env 单测（recording-node-execution-env） | PASS：12 用例——原子写四路/append/exec 语义/ALS 归属/去重/降级 |
| 机器入账单测（local-execution-machine-ledger） | PASS：6 用例——workspace 入账/失败上抛/去重/null 降级 |
| 真实 durable 工具链（faux 驱动） | PASS：write/bash 副作用入账且 invokeId/toolCallId 归属穿透 SDK 执行链 |
| `npm run build` / `lint` | PASS：0 problems（复杂度拆分后） |
| `npm test` | PASS：477 files / 5999 tests |
| `npm run check` | PASS：EXIT 0（build+lint+schema+smoke:boot+探活三场景） |
| `lint:intent` / `lint:capability` / `lint:docs` | PASS：本 PR 文档 intent 1/1；capability 存量警告 80/80 未新增；docs 1046 OK |
| alpha 实启（scripts/alpha.sh，端口 3132 隔离数据根） | PASS：启动→健康→停止全走脚本；台账 actions.db 随 boot 创建（boot_seq=1、0 行，无 invoke 无副作用符合预期）；实例零残留 |
| GitHub CI | PR 创建后运行（见 PR checks） |

（PR-B 合入时本表补充：恢复链扩展与摘要注入的验证行。）
