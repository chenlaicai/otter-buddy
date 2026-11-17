---
id: F20261117resum
title: 恢复链接线层（阶段 3 PR-B：claim 认领绑定 + 恢复摘要内嵌）
doc_type: feature
summary: |
  落实 #1868 阶段 3 PR-B：恢复链消费 PR-A 动作台账——restart_pending_resumes 认领
  绑定 claim_token/boot_epoch（同 boot 拒重认领防双跑、旧纪元残留可重认领防恢复者
  崩溃死锁、attempts 上限不放松）+ 恢复消息内嵌台账摘要（机器真相：succeeded 别重做/
  unknown 先检查/interrupted 可重做）+ 恢复轮 invoke 审计锚回填。
change_type: feature
tags: [recovery, resume, action-ledger, execution-machine]
modules:
  - src/entities/conversation/pending-resume.ts
  - src/usecases/conversation/resume-pending-repository.ts
  - src/usecases/conversation/resume-interrupted-service.ts
  - src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts
  - src/usecases/execution/action-ledger-summary.ts
  - src/frameworks/db/conversation/sqlite-resume-pending-repository.ts
  - src/frameworks/db/schema.ts
  - src/frameworks/db/migration.ts
  - src/app.ts
capability_test: "n/a: 恢复编排与消息构造，LLM 决策路径不参与；认领 CAS/摘要构造/回填均由单测与既有恢复回归覆盖"
created_in_conversation: 6af46649-f93f-4c5b-a6d2-245a4ed33e9f
created_at: 2026-11-17
intent:
  problem: "恢复链（F20260916b1ea）续跑时不知道哪些动作实际已完成——pi-durable transcript 只能说『调用中断了』；恢复者自身崩溃会留 attempts 残留；无恢复轮审计锚"
  expected_effect: "续跑指令内嵌机器真相（台账五态裁决），獭不再靠回忆决定重做；认领绑定纪元使恢复者崩溃后新开机可重认领；recovery_invoke_id 串起恢复世代审计链"
  verify_by:
    type: behavior_check
---

# F20261117resum：恢复链接线层（阶段 3 PR-B）

## 背景

PR-A（F20261116actlg，#1900）建立了本机动作台账（五态/hash/开机清扫/去重协议），
但恢复链尚未消费它：`restart_pending_resumes` 的认领只有 attempts CAS（恢复者自身
崩溃 → 残留认领无纪元信息）；续跑指令（buildRestartResumeMsg）不携带机器真相。

本 PR 按计划书（#1868 阶段 3 交付切分 B）做接线：**扩展恢复链，不建平行链**。

## 目标

- T1 认领绑定：`claim_token`/`boot_epoch` 两列 + 认领 CAS 写入——同 boot 内已认领
  拒重认领（防双窗口双跑）；旧纪元残留可被新开机重认领（恢复者崩溃不留死锁）；
  attempts 每次认领（含重认领）自增，上限 5 不放松。
- T2 摘要内嵌：`buildRestartResumeMsg(actionLedgerSummary?)`——台账行折叠为
  「机器台账（unknown×N、interrupted×N、succeeded×N）」块，unknown 优先呈现，
  附处置指引（succeeded 别重做/unknown 先检查/interrupted 可安全重做）；台账缺席
  或无行动作时退回旧版文案（兼容）。
- T3 审计锚：`recovery_invoke_id` 列——恢复轮点火的 invoke 回填（originalInvokeId=
  行 PK 跨世代不变，best-effort）。
- T4 存量库迁移：三列 ALTER（幂等 PRAGMA 探测；表缺失时跳过——分步建库场景由
  schema 建表自带新列）。

## 非目标

- 不改 attempts 语义/上限、429 退避、并行恢复、参与者检查、「獭已恢复」判据
  （F20260916b1ea/F20260917rscr 语义全部保留）。
- 不动 pi-durable 恢复语义（unsafe 不重放等）。
- unknown 自动处置（摘要只呈现事实与指引，决策归獭/人）。
- 不新增 LLM 工具/Web 界面（阶段 5）。

## 设计取舍

| 取舍 | 决策 | 被否替代 | 理由 |
|---|---|---|---|
| boot epoch 判定 | 进程构造时定格 Date.now()，认领写库；跨进程互异即够 | 复用动作台账 boot_seq | 两个库各自单调，不跨库耦合；同毫秒双开概率可忽略且 attempts 上限兜底 |
| 同 boot 重认领 | 拒绝（boot_epoch=本次且已有 token 即 CAS 失败） | 允许覆盖 | 同 boot 双恢复窗口=真双跑风险；跨 boot 重认领已覆盖崩溃场景 |
| 摘要注入点 | executeChain 的 userMessageContent（合成文本，triggerSenderType=system 沿用不进安全词扫描） | 新增系统 entry / 工具注入 | 与既有续跑指令同通道同语义，最小增量 |
| 摘要排序 | unknown > running > interrupted > failed > succeeded | 时间序 | unknown 需人/獭检查最优先可见；running 是清扫漏网按 unknown 对待 |
| 旧文案兼容 | 无摘要时退回旧版（仅「发言中断」→「执行中断」措辞更新） | 强制摘要 | 台账缺席/空动作时不应阻塞恢复；措辞更新覆盖工具执行中断语义 |

## 机制识别检查点

- 新增持久化存储：否（既有表加三列）。
- 新增状态生命周期：是（认领令牌持有期：pending+token → 终态）。
- 新增信号/消息格式：是（恢复消息内嵌台账摘要块）。
- 新增决策分支：是（同/旧纪元认领判定）。
- 新增跨模块路径：是（resume service → actionLedger 只读面）。

结论：修法决策树②既有机制内扩展（恢复链既有骨架上加列与喂数），无新机制。

## 验收标准

| 场景 | 预期 |
|---|---|
| 首次认领 | attempts+1，token/epoch 落库 |
| 同 boot 重认领 | CAS 失败，原 token 保持，attempts 不变 |
| 旧纪元残留重认领 | 成功，token/epoch 更新，attempts 续增 |
| attempts 上限 | 含重认领路径同样守卫（=5 后不可再认领） |
| 摘要注入 | unknown 优先 + 计数 + 处置指引；超 20 行折叠 |
| 台账缺席 | 旧版文案（无摘要块） |
| 审计锚 | 恢复轮 invoke 回填 recovery_invoke_id |
| 既有恢复语义 | 14 例服务回归 + 全量 478 文件全绿 |

## Verification

| 验证 | 结果 |
|---|---|
| `npx tsc --noEmit` / `npm run lint`（含 lint:tests） | PASS（allow-ddl 豁免 16→17 显式上调，本测试建旧形态表属迁移回归同类） |
| 认领/摘要/迁移单测（resume-claim-and-summary） | PASS：8 用例 |
| 服务级注入/回填（resume-interrupted-service 新增 2 例 + 既有 14 例） | PASS：真实 sqlite + stub 链，含台账缺席兼容路径 |
| `npm test` | PASS：478 files 全绿（含 SIGKILL unsafe 不重放回归） |
| `npm run check` | PASS：EXIT 0 |
| GitHub CI | PR 创建后运行（见 PR checks） |
