---
title: 远程执行通道层（阶段 4 C2）
id: F20261118remex
date: 2026-11-18
module: session
change_type: feature
summary: |
  落实 #1868 阶段 4 C2（执行通道层）：RemoteExecutionMachine（总闸三道→登记→下发→
  等待/超时落 unknown 不盲重试）+ remote_action_requests 五态登记表（requested→
  succeeded/failed/interrupted/unknown 幂等收口，R1 落点）+ 协议 v1 补 action.request/
  result 帧（actionId 请求-响应关联 + 30s 超时纪律）+ connector 侧动作执行栈
  （ConnectorActionDispatcher + 公共 WorkspaceActionExecutor + 独立数据目录本地台账，
  actionId 幂等快路径）+ R2 闭环（恢复摘要并入远程动作五态，conversation 维度关联）。
  ConnectorMachineProjection 占位退役（上线投影换真机器，单例缓存防 handler 累积）。
intent:
  problem: "C1 通道与会话层就绪后，远程动作执行链缺核心机器：中枢侧无登记落点（R1）、恢复链看不见远程动作（R2 数据源断裂）、connector 侧无执行栈（六动作无法远程执行）、断线在途动作无收尾裁决"
  expected_effect: "端到端六动作经 WSS 执行（中枢登记→下发→connector 执行入账→回执→中枢落终态）；重复 actionId 中枢 fail-closed 拒发 + connector 幂等快路径回已记录结果；断线/超时在途动作落 unknown（不盲重试）；恢复摘要含远程动作五态可裁决"
  verify_by:
    type: behavior_check
    evidence:
      - "tests/frameworks/execution/remote-execution-machine.test.ts：机器核心（总闸三道/登记幂等/回执分发/超时 unknown/会话下线批量收尾/registry 五态幂等）"
      - "tests/frameworks/execution/connector-execution-e2e.test.ts：端到端六动作 + 中枢幂等拒 + connector 幂等快路径 + 断线在途落 unknown + 超时落 unknown"
      - "tests/connector/action-dispatcher.test.ts：分发器（白名单/幂等快路径/降级执行）"
      - "tests/usecases/conversation/resume-claim-and-summary.test.ts：buildRemoteActionSummary 五态摘要"
      - "tests/usecases/conversation/resume-interrupted-service.test.ts：远程段并入恢复文案"
capability_test: "tests/frameworks/execution/connector-execution-e2e.test.ts"
---

# F20261118remex：远程执行通道层（阶段 4 C2）

## 背景

#1868 阶段 4 第二切片（方案 v3 §5 执行链路 + §8 C2 验收）。C1（F20261117cnnct）
已交付通道与会话（配对/WSS 协议 v1/总闸库层/闭包断言）；本切片在其上落执行：
中枢侧远程动作请求登记（R1）+ 远程执行机 + connector 侧执行栈 + 断线收尾 +
恢复链远程动作可见性（R2——方案 v3 阶段内闭环承诺）。

## 交付

### 协议 v1 扩展（C2 帧）

- `action.request`（S→C）：`actionId`（幂等锚=请求-响应关联）+ action {type, input}
- `action.result`（C→S）：回带原 actionId + 五态（succeeded/failed 为执行结论；
  interrupted/unknown 为收尾裁决）+ result/error
- `CONNECTOR_ACTION_TIMEOUT_MS = 30s`：回执等待上限（文件动作量级秒级覆盖慢盘；
  无进度流——bash 流式属阶段 7）

### 数据层：remote_action_requests（R1 落点 + R2 数据源）

五态登记：`requested → succeeded/failed/interrupted/unknown`（CHECK 约束），
actionId PK。列含 online_session_id/device_id/action_type/status/error/result/
created_at/settled_at + **conversation_id/invoke_id 关联维度**（R2：conversation
取自六动作 input.conversationId；invoke 取 hub 进程内 invoke 上下文——恢复链按
conversation 并入）。

repo 语义（SqliteRemoteActionRegistry）：
- `recordRequest`：PK 冲突返回 false（调用方 fail-closed 拒重复下发）
- `settleRequest`：**幂等——仅 requested 行可落终态**（先到真相保持，晚到回执
  不改写；`COALESCE` 保已有 error）
- `listByConversation`：恢复摘要数据源（含在途 requested 行——按 unknown 对待）
- `markSessionRequestsUnknown`：断线批量收尾（该 onlineSession 全部 requested →
  unknown）

### RemoteExecutionMachine（中枢侧执行机）

- **总闸三道**（S1）：① online_sessions 表 status=online 直查（唯一事实源）→
  ② Registry 投影（装配处单例缓存）→ ③ 通道已连接（sendToDevice）——全过才发
- actionId：调用方透传（幂等协议位复用）或自铸 `<hubBootEpoch>-<uuid>`（跨重启
  防碰撞）
- 下发前登记 requested → `action.request` → 等 result；**超时/通道断/会话下线 →
  落 unknown 不盲重试**（五态纪律）
- `wireChannel()`（装配处一次）：result 帧分发（pending 等待者兑现 + 登记行落
  终态）+ 会话下线钩子（批量 unknown + 等待者 reject）
- `createExecutionEnvironment` 不支持（SDK 文件/bash 面只在 local——阶段 5/7 语义）

### connector 侧执行栈

- `ConnectorActionDispatcher`（src/connector/action-dispatcher.ts，可测模块）：
  action.request → **幂等快路径**（台账 getByActionId 已 succeeded → 回已记录结果
  不重执行）→ 白名单六动作校验 → WorkspaceActionExecutor 执行 → action.result
  回执；台账读失败降级执行（记账降级语义）
- main.ts `buildRuntime`：数据目录 `~/.otter/connector/<deviceId>/`（台账
  action-ledger.sqlite + workspaces/）——ledger.open() 清扫旧纪元 running 行后
  才开始执行（崩溃恢复兜底）；deviceId 归属台账行（阶段 3 表结构预留维度）
- 回执发帧读当前连接（执行期间重连 → 回执带新 sid 被 hub 旧 sid 校验丢弃——
  语义正确：旧会话动作对新会话回答无意义，hub 已落 unknown）

### WorkspaceActionExecutor 归因注入（闭包收口）

otter-invoke-context 的 `OtterPromptConfig` import 拖 api-contract（src 外文件进
不了 connector 构建树——TS6059）。归因读取改构造注入：中枢 local 传真实
`otterInvokeStorage` 读取（行为零变化）；connector 传缺省 `() => undefined`
（connector 进程无 invoke 上下文——远程动作归因在中枢侧登记表，语义天然正确）。

### 装配（app.ts）

- 投影工厂换 `RemoteExecutionMachine`（占位 ConnectorMachineProjection 退役删除，
  C1 测试改 inline fake）；**单例缓存** per deviceId（重连=同实例 replace 幂等，
  wireChannel 只接一次——防 gateway handler 数组随重连累积）
- `hubBootEpoch = Date.now()`（buildApp 内，进程纪元）
- ResumeInterruptedService 传 `remoteActions`（R2 摘要数据源）

### R2：恢复摘要并入（阶段内闭环承诺）

- `buildRemoteActionSummary`（action-ledger-summary.ts）：远程动作五态折叠文本
  （unknown/requested 优先呈现 + 处置指引 + error 详情 + 设备标识）
- ResumeInterruptedService.buildLedgerSummary：本机台账段 + 远程段并行查询拼接
  （registry 缺席/查询失败 → 远程段静默缺席，恢复不阻断）
- 摘要语义：pi-durable transcript 说「调用中断了」；本机台账说「本机磁盘成了没」；
  remote_action_requests 说「远程那边回了什么」——三层合成恢复指令。

### 闭包断言白名单扩展

`@usecases/ports/(workspace-gateway|action-ledger)` 加入放行（公共执行器依赖面）；
白名单外 usecases 节点仍禁。构建产物 import 图保持零 agent/llm/embedding/memory。

## 设计取舍

| 取舍 | 决策 | 被否替代 | 理由 |
|---|---|---|---|
| 中枢侧 unknown 落点 | 下发前登记 requested（先登记后下发） | 回执到达才落行 | 崩溃/断线窗口也有登记行可收尾（R1：中枢对在途请求始终有真相投影）；超时/下线钩子都有明确落点 |
| 登记 settle 幂等 | 仅 requested 可落终态（先到真相保持） | 后到覆盖 | 断线批量 unknown 后晚到 succeeded 回执不该改写（重连≠恢复）；connector 台账仍是机器侧真相源可核对 |
| connector 幂等深度 | 台账 succeeded 快路径 + executor 内部 dedupe 兜底 | 全五态快路径 | unknown/interrupted 行语义是「可重做/需检查」——正常重发（中枢不重发，防测试/异常路径）走执行语义正确；五态纪律在台账侧兜底 |
| 归因读取 | 构造注入（local 真读取/connector 恒 undefined） | 类型搬 api-contract 或拆 storage | connector 进程本就无 invoke 上下文，拖 AsyncLocalStorage 全家桶为取恒空值不值；语义更准（归因属中枢数据） |
| 投影 machine 生命周期 | per-deviceId 单例缓存 + 同实例 replace | 每次上线新建 | gateway handler 数组随重连累积（空转 handler 也是泄漏）；wireChannel 幂等只在真首建时接线 |
| R2 关联键 | conversation_id（动作 input 直取）+ invoke_id（可空） | 仅 invoke_id | 阶段 4 远程调用方尚无 invoke 归因链（工具路由阶段 5 开放）；conversation 维度恢复链已可用，invoke 精确归因列预留 |

## 机制识别检查点

- 新增持久化存储：是（remote_action_requests 表 + 两索引，schema.ts 单点幂等）
- 新增状态生命周期：是（requested→四终态，settle 幂等收口）
- 新增信号/消息格式：是（action.request/result 帧对——协议 v1 内扩展）
- 新增决策分支：是（总闸三道/幂等快路径/超时裁决/下线收尾）
- 新增跨模块路径：是（RemoteExecutionMachine ↔ gateway 通道面 ↔ dispatcher ↔
  公共执行器 ↔ 本地台账；恢复链 ↔ remote registry）

结论：修法决策树②既有机制内扩展（C1 协议帧族 + 执行机 Registry + 台账记账协议
复用；R2 摘要走既有 action-ledger-summary/恢复链管线）。

## 验收标准（方案 v3 §8 C2）

| 场景 | 预期 |
|---|---|
| 端到端六动作 | write/read/exists/list/path/delete 经 WSS 执行成功；中枢登记行全 succeeded；connector 台账同步入账 |
| 重复 actionId（中枢） | 登记 PK 冲突 → fail-closed 拒发（不二次下发） |
| 重复 actionId（connector） | 台账已 succeeded → 幂等快路径回已记录结果，不重执行 |
| 超时（30s 纪律） | 登记行落 unknown + 等待者 reject（不盲重试） |
| 断线在途 | 该会话全部 requested 行批量落 unknown + 等待者 reject |
| 设备离线发动作 | 总闸①拒（connector device offline） |
| 通道刚断 | 总闸③拒 + 登记行落 unknown（channel closed before send） |
| 恢复摘要 | 远程动作五态并入（unknown 优先 + 处置指引 + 设备标识）；registry 缺席静默兼容 |
| connector 产物闭包 | 零 agent/llm/embedding/memory 节点（白名单扩展后仍硬断言） |
| 本机行为不变 | local 机器/恢复链全量回归全绿（归因注入零行为变化） |

## Verification

| 验证 | 结果 |
|---|---|
| `npx tsc --noEmit` | PASS |
| remote-execution-machine.test.ts | PASS：10 用例 |
| action-dispatcher.test.ts | PASS：6 用例 |
| connector-execution-e2e.test.ts（真 http+ws+执行栈双端） | PASS：5 用例 |
| resume-claim-and-summary / resume-interrupted-service | PASS：13+26 用例（含 R2 并入 2 例） |
| `npm run build:connector` | PASS：闭包断言零违禁 |
| `npm test` 全量回归 | 见 PR checks |
| alpha 实启端到端 | 见 PR comment |
| GitHub CI | PR 创建后运行 |

## Rollback

Revert 本 PR：remote_action_requests 为新增表（留存无害）；协议动作帧中枢侧
不再下发（未知帧 C1 语义已兜底 error/protocol）；归因注入回退为直读 storage
（LocalExecutionMachine 单点改回）；ConnectorMachineProjection 已删（回退需
恢复占位类或回滚整个装配块）。connector 独立产物不受影响（通道层 C1 保留）。
