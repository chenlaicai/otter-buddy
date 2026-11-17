---
id: F20261117resum
title: 恢复链接线层（阶段 3 PR-B：claim 认领绑定 + 恢复摘要内嵌）
doc_type: feature
summary: |
  落实 #1868 阶段 3 PR-B：恢复链消费 PR-A 动作台账——restart_pending_resumes 认领
  绑定 claim_token/boot_epoch/claim_pid（同 boot 拒重认领防双跑、旧纪元残留可重认领
  防恢复者崩溃死锁且重认领前判旧持有者 pid 死活、持有者 token 收口终态、
  attempts 上限不放松）+ 恢复消息内嵌台账摘要（机器真相：succeeded 别重做/
  unknown 先检查/interrupted 可重做）+ 恢复轮 invoke 审计链（追加式，多次恢复全历史）。
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

- T1 认领绑定：`claim_token`/`boot_epoch`/`claim_pid` 三列 + 认领 CAS 写入——同 boot 内已认领
  拒重认领（防双窗口双跑）；旧纪元残留可被新开机重认领（恢复者崩溃不留死锁，重认领前
  旧持有者 pid 死活预检——仍存活则不抢防双跑）；attempts 每次认领（含重认领）自增，
  上限 5 不放松。
  检视轮 S1 补强：认领 token 全程传递，持有者终态收口走 settleResumeHeld（token 校验，
  他人不覆盖、无主行可兜底）——认领失败分支的 exhausted 不会误吞旧持有者在途恢复
  （持有者后续 settle 覆盖收口）。
- T2 摘要内嵌：`buildRestartResumeMsg(actionLedgerSummary?)`——台账行折叠为
  「机器台账（unknown×N、interrupted×N、succeeded×N）」块，unknown 优先呈现，
  附处置指引（succeeded 别重做/unknown 先检查/interrupted 可安全重做）；台账缺席
  或无行动作时退回旧版文案（兼容）。
- T3 审计链：`recovery_invoke_id` 列——恢复轮点火的 invoke **追加式**记录（检视轮 S2：
  崩溃重启多次恢复全历史不丢；originalInvokeId=行 PK 跨世代不变，best-effort；
  attempts 上限锄住链长 ≤5）。
- T4 存量库迁移：四列 ALTER（幂等 PRAGMA 探测；表缺失时跳过——分步建库场景由
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
| boot epoch 判定 | 进程构造时定格 Date.now()，认领写库；跨进程互异即够 | 复用动作台账 boot_seq | 两个库各自单调，不跨库耦合；同毫秒双开铸相同 epoch 时同 boot CAS 仍拒重认领（防双跑不失效，代价是该纪元内恢复由先认领者独占），attempts 上限只守跨 boot 无限重试，不参与此场景 |
| 同 boot 重认领 | 拒绝（boot_epoch=本次且已有 token 即 CAS 失败） | 允许覆盖 | 同 boot 双恢复窗口=真双跑风险；跨 boot 重认领已覆盖崩溃场景 |
| 旧纪元重认领（S3） | 预检旧持有者 pid 死活——存活不抢（防双跑），已死/NULL 才重认领 | 无条件重认领 | 旧持有者还活着时抢=真双跑；CAS 互斥仍由 UPDATE 原子保证（预检只收紧准入，不引入竞态）。已知失真源（两个方向性质不同，分开记）：① pid 复用 → probe 误判存活 → 拒抢无界（不耗 attempts 不 settle，有 warn 可观测）——后果是恢复延迟非数据丢失，方向安全，自愈条件为误判 pid 释放；② 跨 pid 命名空间（容器化部署）→ 持有者在另一命名空间存活时本进程探不到（ESRCH）→ 误判死亡 → 重认领 → 真双跑——方向不安全，后果等价于 S3 前的无条件重认领基线（S3 单向 best-effort 非本 PR 引入回归；当前单机单命名空间部署不可达）；未来容器化时需换 liveness 机制（如启动时间戳比对），勿依赖 S3 防双跑 |
| 终态收口（S1） | 持有者 token 校验 settle（settleResumeHeld）；无主行（token NULL）可兜底 | 无条件 settle | 防非持有者误吞在途持有者的终态；认领失败分支的 exhausted 兜底只对无主行生效，持有者后续可覆盖收口 |
| 审计链（S2） | 追加式（逗号分隔，链长 ≤ attempts 上限） | 单槽覆盖 | 多次崩溃重启的恢复全历史不丢；「审计链」命名与实际行为一致 |
| 摘要注入点 | executeChain 的 userMessageContent（合成文本，triggerSenderType=system 沿用不进安全词扫描） | 新增系统 entry / 工具注入 | 与既有续跑指令同通道同语义，最小增量 |
| 摘要排序 | unknown > running > interrupted > failed > succeeded | 时间序 | unknown 需人/獭检查最优先可见；running 是清扫漏网按 unknown 对待 |
| 旧文案兼容 | 无摘要时退回旧版（仅「发言中断」→「执行中断」措辞更新） | 强制摘要 | 台账缺席/空动作时不应阻塞恢复；措辞更新覆盖工具执行中断语义 |

## 机制识别检查点

- 新增持久化存储：否（既有表加四列）。
- 新增状态生命周期：是（认领令牌持有期：pending+token → 终态）。
- 新增信号/消息格式：是（恢复消息内嵌台账摘要块）。
- 新增决策分支：是（同/旧纪元认领判定 + 旧持有者死活预检）。
- 新增跨模块路径：是（resume service → actionLedger 只读面）。

结论：修法决策树②既有机制内扩展（恢复链既有骨架上加列与喂数），无新机制。

## 验收标准

| 场景 | 预期 |
|---|---|
| 首次认领 | attempts+1，token/epoch/pid 落库 |
| 同 boot 重认领 | CAS 失败，原 token 保持，attempts 不变 |
| 旧纪元残留重认领（持有者已死） | 成功，token/epoch/pid 更新，attempts 续增 |
| 旧纪元持有者仍存活（S3） | 预检拒抢，行保持 pending 归旧持有者，attempts 不变 |
| 持有者终态收口（S1） | 持有 token 可 settle；他人 token 不覆盖；无主行可兜底 |
| attempts 上限 | 含重认领路径同样守卫（=5 后不可再认领） |
| 摘要注入 | unknown 优先 + 计数 + 处置指引；超 20 行折叠 |
| 台账缺席 | 旧版文案（无摘要块） |
| 审计链（S2） | 每轮恢复 invoke 追加不丢；多次恢复全历史可查 |
| 既有恢复语义 | 14 例服务回归 + 全量文件全绿 |

## Verification

| 验证 | 结果 |
|---|---|
| `npx tsc --noEmit` / `npm run lint`（含 lint:tests） | PASS（allow-ddl 豁免 16→17 显式上调，本测试建旧形态表属迁移回归同类） |
| 认领/摘要/迁移单测（resume-claim-and-summary） | PASS：10 用例（含 S1 持有校验 settle 三态、S2 审计链追加不丢、claim_pid 写入） |
| 服务级注入/回填（resume-interrupted-service 新增 10 例 + 既有 14 例） | PASS：真实 sqlite + stub 链，含台账缺席兼容路径、S3 旧持有者存活拒抢/已死接手/同 boot 不进预检、S2 二轮恢复链追加 |
| `npm test` | PASS：479 files 全绿（含 SIGKILL unsafe 不重放回归；rebase main #1903/#1905 后） |
| `npm run check` | PASS：EXIT 0 |
| alpha 验证环境实启（5683b5f1） | PASS：旧形态 8 列表重启 ALTER 逐列补四列（日志留痕）；播种中断现场→重启→认领写入（token/epoch/pid=进程 PID 一致）→恢复 invoke 点火→审计链追加→invoke 终态直读→持有者 token 收口 failed→失败提示消息落对话（证据见 PR comment） |
| GitHub CI | PR 创建后运行（见 PR checks） |
