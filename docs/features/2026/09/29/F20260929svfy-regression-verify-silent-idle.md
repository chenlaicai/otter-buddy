---
id: F20260929svfy
title: regression-verify 静默空转根修：动态 skip 落账 + 回归验证心跳 + issue 生命周期契约
module: scheduler
type: BugFix
change_type: feature
capability_test: "tests/usecases/scheduler/scheduler-service.test.ts"
modification_class: narrow-fix
modules: [src/usecases/scheduler/scheduler-service.ts, prompts/scheduled/daily-health-check.md]
intent:
  problem: regression-verify 任务 11 天零执行记录——skip 不落账不刷指标导致「任务死了」与「没事干」不可区分，且 reconcile 误报掩盖真实状态
  expected_effect: 任何 skip 路径落 skipped execution 行 + 刷 last_triggered_at；regression-verify 心跳（写入即 resolved）让「活着但没活干」可查询；issue 产出补关闭标准必填 + 断言豁免标注
  verify_by:
    type: behavior_check
    reason: 新增纪律段有可观察行为（skip 落账/心跳/断言豁免），非纯文案
status: draft
created_at: 2026-09-29
created_in_conversation: f4402db8-9dee-4979-82b9-f0d46ed4f195
closes_issue: 1208
summary: |
  regression-verify 创建 11 天零执行记录——不是 restart/模型问题，是设计性空转 +
  指标盲区：任务每天在跑但 resolveEffectiveBody 每天返 null（上游无断言段 issue /
  gh 故障）→ skip 不落 execution、不刷 last_triggered_at → reconcile 误报「错过触发
  窗口」。根修三层：① skip 落 skipped execution 行 + 刷 last_triggered_at（消除 NULL
  指标盲区）② 心跳写入即 resolved（#751 先例）让「活着但没活干」可查询
  ③ daily-health-check prompt 补关闭标准必填 + 断言豁免标注（issue 生命周期契约落点）。
---

# regression-verify 静默空转根修

## 问题

issue #1208：regression-verify 定时任务创建 11 天（9/18–9/29）零执行记录——`scheduled_task_executions` 0 行、`last_triggered_at` 永远 NULL。搭档体感「断言到期回查机制空转」，但无任何告警指向真实原因。

## 根因（证据链闭环）

**不是 restart/模型问题**（大獭假说被推翻），是**设计性空转 + 指标盲区**：

1. **任务每天在跑**：`skipped before claim (dynamic skip)` 日志 9/20–9/29 每天 11:00 各 1 条（10 条实证）。
2. **skipped 原因**：`buildRegressionVerifyBody()` 返 null——
   - 上游：验证断言规范（`断言/检查方式/到期`三字段）F20260917pbgg 才于 9/17 加入 daily-health-check prompt；62 天扫描窗内 closed 的 daily-review issue 全是规范前创建，**无断言段** →「no due assertions」。
   - 另一成因：9/22–9/27 gh CLI failure（`fetchClosedDailyReviewIssues` 失败兜底返 null）。
3. **skipped 不落账**：`resolveEffectiveBody` 返 null 后直返 `executionId: ''`——不落 execution 行、不刷 `last_triggered_at`。
4. **reconcile 误报**：#814 调度对账只比对 `last_triggered_at`（NULL）与 cron 应触发点 → 每天落「错过触发窗口」healing event（5+ 条），**把正常 skip 误报为任务死了**。
5. **误报压制真信号**【凭任务简报转述，代码未核实】：「`/heartbeat` REGRESSION_GH_FAILED_24H 与重复误报同去重键」——全库 grep 无此端点/符号，唯一出处是任务简报工作区文件。reconcile 误报（发现 4）属实且严重（5+ 条 healing event），但「压制 gh 故障告警」链条未在代码中验证。本 PR 不依赖此条论证——根修价值由发现 1-4 独立成立。

**一句话**：任务活着、每天在跑、每天没事干（上游无断言段 issue），但「没事干」与「死了」在指标上不可区分，且对账误报让人以为任务死了。

## 修复（三层）

### ① 动态 skip 落账（根修）

`triggerTask` 中 `resolveEffectiveBody` 返 null 或 claim 被拒时：

- 落 `skipped` execution 行（`executionId` 提前生成，skip 前建行），`errorMessage` 记录跳过原因
- 刷新 `last_triggered_at`（claim 占位 + catch 块兜底补刷）——reconcile 的 reference 点不再 NULL，误报消除

**例外**：对话不存在/非 active → 任务被 disable，skip 落账无意义（任务已停），不落。

### ② regression-verify 心跳（可见性）

`buildRegressionVerifyHeartbeat()` 模块级函数：

- 每次 due-assertion skipped 落心跳 healing event（**写入即 resolved**，#751 先例 `circuit-break-support.ts:92-101`——「探针是心跳不是问题」，落账只为管道自证，不进 open 池等待处置）
- 去重：查近 24h 内同 taskId + 同 reason 的已落心跳（`findAll('resolved')` + 时间窗判定），有则跳过
- `gh-cli-failure` 与 `no-due-assertions` 独立计数不互压——前者是故障信号，后者是正常空转
- 连续多日「无到期断言」→ suggestion 提示排查上游断言覆盖或收窄 cron 频率

### ③ prompt 断言纪律（上游闭环）

`prompts/scheduled/daily-health-check.md` issue 产出规范补：

- **关闭标准必填**（搭档拍板）：每个 issue 含「关闭标准」段——可验证的关闭条件
- **断言豁免标注**：无法写断言的 issue 显式标注 `暂不验证：<原因>`——regression-verify 回查跳过该 issue，不因无断言段而静默漏检

## 设计取舍

| 决策 | 选择 | 理由 |
|------|------|------|
| skipped execution 落行 vs 不落行 | **落行** | execution 行是「任务本轮是否跑过」的唯一可查凭证；NULL 指标（last_triggered_at 永远 NULL）是本次事故第一盲区——落行后「死了」与「没事干」在 DB 层可区分 |
| 防呆 24h 未触发自动开 issue | **被 ① 取代** | ① 落行后 `last_triggered_at` 有值 + execution 行可查——「任务是否活着」可通过 sqlite3 直查验证，无需新增 issue 生成机制；重复误报事件由 reconcile 修好（① 刷 last_triggered_at 后不再误报）后压住 |
| claim 被拒时 last_triggered_at 补刷 | **catch 块 + skip 路径双兜底** | claim 被拒可能发生在 claimTask 之前（running execution 检查），原 claimTask 未执行；两处显式 `claimTask(id, now, now)` 幂等兜底 |
| 心跳写入形态 | **写入即 resolved（#751 先例）** | open 事件会被次日 self-healing-analysis 的 findOpen(20) 消费（废掉其「no open events」skip 机制）、污染 dismiss 率统计；心跳是状态记录不是要处置的问题 |
| 心跳去重窗口 | **24h** | 与任务 cron 周期（每天 11:00）对齐；同 reason 24h 内只落 1 条，不刷屏 |

### 心跳子机制四问（发现 9）

| 问题 | 回答 |
|------|------|
| 谁需要 | regression-verify 任务运维者（搭档/大獭）——「任务活着但没活干」状态可查询 |
| 失败后果 | 心跳落账失败仅 console.warn，不阻塞 skip 主路径；无心跳时回退到 ① 的 execution 行可查（指标盲区已消除） |
| 后续机制 | 若上游断言覆盖率提升（10/17 后断言到期），心跳自然停落；若连续 30 天心跳全「no-due-assertions」，提示收窄 cron 或下线任务 |
| 退役条件 | skip 落账使 execution 行指标完备后，心跳可删（execution 行已含 skip 原因）；或 regression-verify 任务本身下线时随删 |

## 影响范围

| 文件 | 变更 |
|------|------|
| `src/usecases/scheduler/scheduler-service.ts` | triggerTask skip 落账（含对话停用排除）+ claim 被拒双兜底（skip 路径 + catch 块）+ `buildRegressionVerifyHeartbeat` 模块函数（写入即 resolved #751 先例）+ `lastRegressionSkipReason`/`conversationDisabledInClaim` 实例字段（消费后即复位防泄漏） |
| `prompts/scheduled/daily-health-check.md` | issue 产出规范补「关闭标准必填」+「断言豁免标注」段 |
| `tests/usecases/scheduler/scheduler-service.test.ts` | #823 既有断言反转 + #1208 新 describe（3 用例：claim 被拒落账 / self-healing skip 不落心跳 / 发现 1 组合场景）+ #641 断言更新 + makeHealingRepoNullBody 补 getStats + makeObservableHealingRepo 补 findAll |
| `tests/usecases/scheduler/regression-verify.test.ts` | #1208 心跳 describe（3 用例：落账+resolved 断言 / 24h 去重 / reason 独立） |
| `tests/usecases/scheduler/healing-analysis-template.test.ts` | skip executionId 断言更新 |
| `tests/usecases/scheduler/daily-health-check-prompt-discipline.test.ts` | 关闭标准必填段锁定（1 用例） |

## 验证

- `tests/usecases/scheduler/` 6 文件 **129/129 通过**（含 #1208 新增 7 用例 + 存量 5 用例断言反转 + 发现 1 组合测试 1 用例）
- 全量 vitest **4266/4266 通过**（303 文件零失败，独立复跑核实）
- `tsc --noEmit` 干净
- 特性文档验证段计数：scheduler-service.test.ts 79 用例（含 #1208 新增 3 + #823 反转 1 + #641 更新 1）+ regression-verify.test.ts 11 用例（含 #1208 新增 3）+ healing-analysis-template.test.ts 8 用例（含 #1208 更新 1）+ daily-health-check-prompt-discipline.test.ts 7 用例（含 #1208 新增 1）

## PR Verification

Golden Gate: n/a——本 PR 属 scheduler 内部机制修复（skip 落账/心跳），无 prompt 层行为变更可跑 golden 场景（prompt 变更部分为 issue 产出规范补段，属文档纪律非交互场景）；verify_by 声明 behavior_check 已由 129/129 单测覆盖（含 7 个新增用例锁定 skip 落账/心跳去重/旗标复位语义）。

## 补跑（合入后执行）

修复合入后手动触发一次 regression-verify：

1. 本地构建 prompt：`node -e "import('./src/usecases/scheduler/scheduler-service.js').then(m => m.buildRegressionVerifyBody())"`（或合入后等次日 11:00 自动触发）
2. 回查 9/18–9/29 到期的验证断言（`gh issue list --state closed --label daily-review --search "closed:>=2026-07-30"` 逐条提取断言段）
3. 到期断言结果回写对应 issue 评论（含 `<!-- regression-verify: ... -->` 标记）

## 关联

- 根因 issue：#1208
- 上游规范：F20260917pbgg（验证断言三字段加入 daily-health-check prompt）
- 调度对账：#814（reconcile 误报源头）、#823（skip 吞 claim 饿死根修）、#913（前置炸点 healing）
- 同类事故：#1068（定时任务模型绑定 429 终态）
