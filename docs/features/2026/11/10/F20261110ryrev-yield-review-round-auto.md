---
id: F20261110ryrev
title: yield 自动采集 PR 检视轮次
summary: 检视轮次不再依赖海獭调用 track_work 主动上报。yield 派工时携带 reviewer 角色，下一 invoke 从触发 entry 继承；检视者完成交棒时按 trace 找到原工作并按 invoke 幂等计一轮。面板仍只展示轮次总数，不回刷历史。
change_type: feature-update
capability_test: "n/a: 协作生命周期 A 类集成测试覆盖真实 SQLite + SendEntry + yield 工具；prompt 变更跑 golden-selftest"
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
causal_links:
  from: [F20261027hwl1]
  supersedes: []
tags: [health, work-ledger, review, yield, telemetry]
modules:
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/interface-adapters/agent-runtime/tools/work-ledger-tools.ts
  - src/usecases/conversation/send-entry.ts
  - src/usecases/conversation/yield-assignment.ts
  - src/usecases/conversation/dispatch-chain-engine.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/usecases/ports/agent-turn-port.ts
  - src/usecases/conversation/agent-dispatch-service.ts
  - src/interface-adapters/http/controllers/message-controller.ts
  - src/interface-adapters/http/controllers/invoke-controller.ts
  - src/usecases/ports/otter-tool-client.ts
  - src/bootstrap/clients.ts
  - src/usecases/health/work-ledger-binder.ts
  - src/frameworks/db/health/sqlite-work-ledger-repository.ts
  - src/entities/health/work-ledger.ts
  - web/src/api/client.ts
  - web/src/pages/health/WorkDetailDialog.tsx
created_at: 2026-11-10
intent:
  problem: "PR 检视轮次依赖 reviewer 主动调用 track_work(review_round)，漏调、另建审查工作及错误 workId 假成功使大量面板记录为空"
  expected_effect: "yield 派 reviewer 后，检视者每次完成发言并交回即由后端自动给原工作累计一轮；普通派工、自交棒与重复 invoke 不误计"
  verify_by:
    type: behavior_check
    bugfix_acceptance:
      - "真实 SQLite 集成链：大獭 yield assignmentRole=reviewer → 检视 invoke 继承角色 → 检视 yield 回来自动产生第 1 轮；第二次返工复核产生第 2 轮"
      - "普通派工不继承 reviewer、自交棒不计、相同 invokeId 重放不重复、无 trace 工作归属时交棒正常且后台记缺口"
      - "track_work 不再暴露 review_round，避免自动与手动双写；面板轮次总数来源不变"
    rollback: "git revert 本 PR 合入 commit；无 schema 变更、无历史数据迁移"
    risk_note: "轮次只表示完成的检视协作次数，不推断通过或需修改；未绑定 trace 的检视仍无法归属，仅写后台日志"
---

# yield 自动采集 PR 检视轮次

## 背景与决策

生产只读核查发现 122 件工作仅 30 件有轮次。根因不是 UI，而是手动 `track_work(review_round)` 上报链：漏调、检视另建工作、错误 workId 可能假成功。

搭档确认：聚焦新数据自动采集，不修复历史；监控面板只展示统计指标。最终选择 yield 而非 create_otter 作为角色传递点，因为角色属于本次派工，且已有参与者的重复派工不经过 create。

## 流程与代码锚点

1. `track_work start/resume` 沿用现有 trace↔work 绑定，不传提示词 workId。
2. 大獭调用 `yield({to, assignmentRole:'reviewer'})`；`SendEntry.createYieldEntry` 把角色写入 yield entry，同时写入派发方 invoke 的 `yieldAssignmentRole`。
3. `DispatchChainEngine` 从该 invoke 读取角色并逐 hop 显式传给 `InvokeFn.assignmentRole`；`AgentInvoker` 把角色与现有 traceId 写入下一 invoke metadata。原始 `triggerEntryId` 语义不变。角色由系统传递，不经 LLM 转述。
4. 检视者正常 speak/yield 交回；`createYieldTool` 在交棒成功后读取当前 invoke 角色。若为 reviewer 且非 self-yield，调用 `WorkLedgerBinder.recordCompletedReviewRound`。
5. binder 以当前 trace 查原工作，追加 `state=completed + completedInvokeId`；相同 invoke 重放幂等。面板仍按轮次数组显示总数。

轮次只表达“一次检视者完成交棒”，不分析通过/需修改，不扫描评论文本。初轮与每次 delta 各计一轮。

## 独立检视修正

初版仅从 trigger entry 继承角色，但生产链所有 hop 的 triggerMessageId 都是原始 user entry，角色永不触发。改为派发方 invoke `yieldAssignmentRole` → 链引擎下一 hop `assignmentRole` → 被派工 invoke metadata 的显式生产链，并新增判别测试锁定原始 user trigger 不变。并行 reviewer 完成时，roundNo 分配与 JSON 追加在 better-sqlite3 同步事务内完成，防读旧值互覆盖。

## Retirement handover

- `track_work review_round` 动作及其 reviewerOtterId/roundNo/roundState 参数退役，避免自动与手动双写；start/resume/complete/cancel 保留。
- 旧 `review_rounds` 记录与 UI 状态类型保留兼容；不迁移、不合并历史工作。
- `workId` 不存在时 repository 不再静默 return，自动采集失败仅写日志，不阻断协作。
- 自动完成记录以 `completedInvokeId` 为幂等键，避免不同检视者按 roundNo 相互覆盖。

## 验证

- 新增真实 SQLite + SendEntry + yield 工具集成测试，修复前失败于角色未传递与自动记录方法不存在；链引擎测试使用生产原始 user trigger 形状判别角色传递。
- 修复后覆盖两轮连续采集、角色继承、普通派工、自交棒、重复 invoke 与无归属降级。
- 既有工作账本聚合、详情与报告测试同步到自动轮次语义；生产 OtterToolClient 适配层有角色/metadata 透传回归。
- 全量 444 文件、5780 用例通过；`npm run check`、Web build、prompt golden-selftest 通过。

## 边界

不处理历史数据，不改变 token 公式，不新增面板异常栏；没有 trace↔work 绑定的协作仍不能归属轮次，后台日志保留缺口。

当前采集覆盖标准 dispatch-chain 的完成交棒；retry、重启恢复、busy follow-up、recruiting 等非标准路径可能漏记，方向是少记而非误计。`assignmentRole` 是派工方对本次协作的声明，系统不再从姓名或正文推断；若把作者派回为 reviewer，会按该声明计轮。缺 trace、binder 或工作绑定时允许业务继续，仅已有日志路径可诊断。
