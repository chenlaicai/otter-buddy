---
title: 恢复链 attempts 跨 invoke 继承与上限告警
id: F20261124rscap
date: 2026-11-24
module: session
change_type: fix
summary: |
  修复 #2016（#1868 阶段 3）：恢复者再崩溃产生新 invoke_id 时 attempts 从 0 重计，
  导致链级恢复次数上限失效。入队从父恢复行继承 attempts，第 6 轮拒绝认领并落
  exhausted 与 healing 告警；不新增表列，不改变零盲重放、claim 与恢复审计语义。
intent:
  problem: "恢复 invoke 自己崩溃后作为新队列行从 attempts=0 入队，逐行 MAX_RESUME_ATTEMPTS 无法约束整条崩溃恢复链，可能无限重启烧配额"
  expected_effect: "同一恢复链跨 invoke_id 单调继承 attempts；第 5 轮可恢复，第 6 轮拒绝并落 exhausted + high healing；普通首闯仍从 0 开始，unknown 动作不盲重放"
  verify_by:
    type: behavior_check
    evidence:
      - "tests/bootstrap/restart-resume-enqueue.test.ts：父行继承、普通首闯、第6轮拒认领"
      - "tests/usecases/conversation/resume-interrupted-service.test.ts：上限终态与 healing"
      - "planc4 真实 hub 连续崩溃：第6轮 exhausted + healing，B1/B2 正向证据不回归"
created_in_conversation: 6af46649-f93f-4c5b-a6d2-245a4ed33e9f
---

# F20261124rscap：恢复链 attempts 跨 invoke 继承与上限告警

## 背景与失败证据

`planc4` 真实双崩溃证明：恢复 invoke 再崩溃后，`reconcileRunningInvokes` 把它作为
新行以 attempts=0 插入；连续两轮认领实测为 1、1。仓库原有 `attempts<5` 只约束单个
invoke_id，注释所称「钳住链长 ≤5」不成立。

修复前定向测试固化（`planc4/04-before-fix-tests.log`）：

- 新入队测试：期望子恢复行继承父行 attempts=4，实际 0；
- 新告警测试：期望上限 healing，实际无事件；
- 合计 2 failed / 31 passed。

## 设计取舍

选择：**入队继承父恢复行 attempts，不改 schema**。恢复 invoke 的
`trigger_entry_id` 已指向父恢复 invoke；查询该父行的 attempts 即可保留链计数。
普通用户 invoke 的 trigger 是用户 entry，父行不存在，仍按 0 起步。

被否替代：新增 `root_invoke_id/chain_attempts` 表列与迁移。当前父行已经足以表达
本链，新增列会带来迁移、双写与生产副本启动成本，不是本缺陷的必要条件。

### 机制识别与预算四问

命中「新增决策分支」与「跨 bootstrap/usecase 路径」，但**不涉净新增机制**：
复用既有 attempts、trigger_entry_id、claim SQL 与 healing，无新存储、状态、消息格式。
因此 Modification-Class 为 `narrow-fix`。

1. **不变量全集**：普通首闯 attempts=0；链内跨 invoke_id 单调继承；最多 5 次自动恢复；
   第 6 轮 exhausted + healing；claim token/boot epoch/PID 接管不变；成功恢复
   `recovery_invoke_id` 追加不变；unknown/unsafe 动作禁止自动重放。
2. **已有接管机制**：bootstrap 入队负责链计数继承；既有 repository 认领闸负责拒绝；
   ResumeInterruptedService 负责 exhausted 和 healing，不另建计数器或恢复队列。
3. **后续机制**：若未来删除父行历史、跨链合并或支持多父恢复，需显式 root/chain 模型；
   当前单父链且父行持久保留，不预先扩建。
4. **退役条件**：若迁移到显式 root/chain 计数，只需替换 bootstrap 的父行查询；
   链级行为测试与第 6 轮验收必须继续通过。

## 实现

- `src/bootstrap/database.ts`：`INSERT OR IGNORE ... SELECT` 从
  `trigger_entry_id` 对应父恢复行读取 attempts，缺失时 `COALESCE(...,0)`；父行已
  exhausted 也可继承，幂等语义不变。
- `sqlite-resume-pending-repository.ts`：订正链长注释，明确链级语义由入队继承保证。
- `resume-interrupted-service.ts`：上限拒绝后除 exhausted 外，写 warn 与 high
  healing（含 invokeId/attempts/reason）；healing 写失败不阻断终态。
- 未触碰动作执行/重放代码；B1 的 unknown 语义与恢复摘要继续作为安全边界。

## 验收标准

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 普通首闯 | running user invoke 重启入队 | attempts=0 |
| 恢复者再崩 | 父行 attempts=4，子恢复 invoke 入队 | 子行 attempts=4，认领后 5 |
| 第 6 轮 | 第 5 轮恢复 invoke 再崩并入队 | 新行 attempts=5，认领 false，服务落 exhausted + high healing |
| 链审计 | 成功恢复 R2 | `recovery_invoke_id` 追加不回归 |
| 回执丢失 | 设备 succeeded、hub 丢 result | hub unknown，重连同 actionId 不重发，设备副作用不重复 |
| 告警失败 | healing 写异常 | 仅 warn，不影响 exhausted 终态 |

## Verification

- 修复前：`planc4/04-before-fix-tests.log`，2 failed / 31 passed。
- 修复后定向：`planc4/04-after-fix-tests.log`，33 passed；最终扩展定向 3 文件 **46 passed**。
- 链级单测：覆盖普通首闯、父行继承、第 5 轮认领与第 6 轮拒绝。
- `npx tsc --noEmit`、变更文件 eslint、`npm run build` PASS；`lint:intent` 1101 docs OK、0 error。
- **真实 hub 第 6 轮终验**：`planc4/05e-attempt-limit-driver.log` 五轮 attempts=1→2→3→4→5，随后 `deed6ba9-c3a2-4ac3-976a-ac1ec46829fb` 不再产生恢复 invoke；queue=exhausted。`05e-healing.json` 含 high 事件 `03a7e29c-6ff1-4626-ab75-dd5f1ef4042b`、attempts=5；设备追加文件仍一行。
- **B1 回归**：`06-b1-regression-analysis.json` 设备 succeeded / hub unknown，同 actionId 请求=1，追加文件一行，零盲重放。
- **B2 正向回归**：`07-positive-recovery-analysis.json` claim token/boot epoch 轮换，R2 完成后 `recovery_invoke_id=e7767ba5-f8b5-45be-82ff-d5bfa04d8c16`，设备文件一行。
- pre-commit 全量 check PASS（build、eslint、schema、双形态 smoke、脚本探针）；CI 结果见 PR。

## 负向验收与最简检查

本次不得破坏：普通首闯计数、受限外部 invoke 排除、同 boot 防双跑、旧持有者 PID
存活预检、成功恢复审计追加、unknown 动作禁止盲重放。不得通过重放动作换取测试通过。

已过最简检查：复用现有父行与 attempts，仅改一条入队 SQL、一个告警分支和测试；
不新增表、列、依赖、状态或第二套恢复链。

## Rollback

Revert 本 PR 即恢复旧的逐 invoke attempts 行为；无 schema 变更，无数据迁移。
已产生的 exhausted/healing 历史保留。回滚会重新暴露 #2016 的链级计数缺口。
