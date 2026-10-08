---
id: F20261008gduc
title: bash 守卫 P0 双修复——V1 兜底链 cd 豁免 || 误伤修正 + 熔断同规则 3 连降级通道
summary: V1 兜底链 hasRealCdSegment 裸 \| 正则把 || 备用链当管道杀 cd 豁免（#1170 修复只落 V2 复发面，近 7 天 main_write 误拦 93 条）修正为 lookaround 形态 + 熔断同规则 3 连判疑似误拦走降级通道（通知搭档 + invoke failed + suspected_false_positive 落账），治 #1353 獭失联半小时；异规则/unknown/查询失败仍 abort 不误判
type: BugFix
date: 2026-10-08
capability_test: "n/a: 守卫正则修正与熔断降级分支逻辑，验证走单测（bash-safety-guard P0-1 6 例 / agent-invoker-guard-bounce P0-2 4 例），无独立 LLM 能力面"
intent:
  problem: "#1170 修复只落在 V2 段级语义，V1 兜底链 hasRealCdSegment 裸 \\| 正则把 || 备用链首字符当管道杀 cd 豁免，多行载荷 parseOk=false 落 V1 链时同一形态复发误拦（近 7 天 main_write 误拦 93 条，39 条含 worktree 路径）；guard bounce 熔断只数次数不看规则标识，连续 3 次命中同一 ruleId（同一误拦面）时自动重试注定失败却静默 abort，#1353 实证獭失联半小时"
  expected_effect: "|| 备用链不再被当管道杀 cd 豁免（与同函数切分正则语义对齐），cd 豁免生效后仍过 cdExemptionWithVeto 负门（#1240 不旁路）；同规则 3 连判疑似误拦走降级通道（通知搭档含命令摘要/命中规则/重试次数 + invoke failed 终态 + suspected_false_positive high 落账），异规则/unknown/查询失败仍走原 abort 终态"
  verify_by:
    type: behavior_check
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
status: implemented
pr: ""
related_issues: ["#1170", "#1207", "#1240", "#1304", "#1353"]
causal_links: ["F20261008gfrc", "F20260928grv2", "F20261006c1240"]
---

# bash 守卫 P0 双修复：双链统一 + 熔断降级通道

## 背景

近 7 天 healing_events 台账实证：bash 守卫 main_write 误拦 93 条（其中 39 条命令明明含 worktree 路径）。根因是**「修复-回归循环」结构性问题**——#1170（管道杀 cd 豁免）修复只落在 V2 模型段级语义（`modelCdExemption`），V1 兜底链（parseOk=false 时全量兜底）的 `hasRealCdSegment` 未同步，导致多行载荷 parseOk=false 落 V1 链时同一形态复发误拦。

同时，guard bounce 熔断（#731，GUARD_BOUNCE_MAX=3）在命中**同一守卫规则**的自动重试耗尽时静默 abort 整条发言——3 次重试若命中同一条误拦面，自动重试注定失败，abort 是错杀（#1353 实证「獭失联半小时」）。

## 机制识别检查点（未经 RA 流程，动手前判定）

按 troubleshooting skill 修法决策树逐项判定：

| 检查项 | 判定 | 理由 |
|--------|------|------|
| **是机制缺口还是实现 bug？** | 双者皆是 | P0-1：V1 链 `\|` 正则 bug（实现层）+ V1/V2 语义割裂（机制层——#1170 修复时未同步兜底链）。P0-2：熔断只数次数不看规则标识，同规则反复命中无法区分「顽固违规」与「稳定误拦」（机制层设计缺口） |
| **修法收窄还是扩面？** | 收窄 | P0-1：`\|` → `(?<!\|)\|(?!\|)` 收窄误伤面，不新增豁免面。P0-2：同规则 3 连从 abort 改为降级通知，异规则/unknown/查询失败仍 abort——收窄「误杀」面，不放宽「真违规」面 |
| **Modification-Class** | narrow-fix | P0-1 是既有语义内 bug 修复（|| 本应像 && 一样拆开判定，同函数切分正则 :1530 已认识 `\|\|`）；P0-2 是结构性补位（熔断通道新增同规则判定分支，abort 语义对真违规保持不变） |
| **修复会否引入新豁免面？** | 否 | P0-1：修复后 cd 豁免仍需过 `cdExemptionWithVeto` 负门（#1240 heredoc 体绝对路径落主仓不豁免）——负门不因 \|\| 修复而旁路，回归测试固化。P0-2：降级通道要求 ruleId 同且非 unknown，且查询失败 fail-closed 回 abort——真违规路径语义零变化 |

## 方案设计

### P0-1：V1 兜底链 cd 豁免 `||` 误伤修正

**根因锚点**：`src/frameworks/agent/bash-safety-guard.ts:1529` `hasRealCdSegment` 的裸 `\|` 分支会把 `||` 备用链首字符当管道命中，杀 cd 豁免。同函数下一行 :1530 的切分正则 `basis.split(/&&|\|\||[;\n]/)` 明明认识 `\|\|`，同函数两处语义不一致。

**修法**（治本，消割裂）：把裸 `\|` 改为带 lookaround 的负向断言 `(?<!\|)\|(?!\|)`——只命中真管道，不误伤 `||`。与同函数切分正则语义对齐。

**关键设计取舍**：V1 链 cd 豁免判定仍经 `modelCdExemption`（guard-model-judge.ts:639）入口，parseOk=false 时回 v1Fallback=修正后的 `hasRealCdSegment`。选「修正 V1 fallback 正则」而非「V1 链完全走 modelCdExemption 段级判定」的理由：

1. `modelCdExemption` 的段级语义已在 V2 链生效，V1 链回退时调用它会把解析失败形态的判定耦合到词法解析器——解析失败恰恰是 modelCdExemption 自己回 v1Fallback 的场景，无增益。
2. 修正 V1 fallback 正则是最小变更：只改一个字符级 bug（`\|` → `(?<!\|)\|(?!\|)`），不引入新判定路径，风险面最小。
3. 与 #1170 修复同构：#1170 在 V2 用段级语义解决「管道杀豁免」，V1 链只需要「`||` 不被当管道」——两个修复正交，分别落在各自层。

**负门约束**：cd 豁免生效后仍须过 `cdExemptionWithVeto`（bash-safety-guard.ts:1676）负门——#1240 heredoc 体绝对路径落主仓时不豁免。修复不旁路负门，回归测试固化。

### P0-2：熔断同规则 3 连降级通道

**根因锚点**：`retry-policy.ts:104` `GUARD_BOUNCE_MAX=3`，滑窗内连续 3 次被拦 → `buildGuardBounceEscalationMsg` → 静默 abort。命中同一 ruleId 时自动重试注定失败（同一误拦面），abort 是错杀。

**修法**（降级通道，不是取消熔断）：连续 N 次命中**同一 ruleId/同一规则**时，判定「疑似误拦」：

1. 中断当前自动重试循环（本轮不再回发）
2. 给搭档发「疑似误拦」通知（含被拦命令摘要 + 命中规则 + 已重试次数 + 「请人工核实或临时放行」）
3. 会话内给獭降级提示（引导换写法/报告搭档，而非继续撞同一规则）
4. invoke 终态化 failed（非 aborted——保留手动重试空间，与真违规 abort 语义区分）
5. 落账 suspected_false_positive high（守卫可信度问题需人工跟进）

**真违规路径不变**：异规则反复撞、ruleId=unknown、事件查询失败（台账失明）→ 仍走原 `escalateGuardBounce` abort 终态。

**关键设计取舍**：为什么同规则 3 连判误拦？

- **同一规则命中说明命令形态稳定**——獭在正确的命令上反复撞墙（如 `cd <worktree> && git commit` 被 main_write 误拦），不是在乱试不同危险命令。
- **真违规的特征是异规则/探索性**——獭在试探不同写法时会命中不同规则（kill 族、写族、sleep 族混杂），规则标识的熵高。
- **#1353 实证**：獭已经 cd 了 worktree，引导文案说「请 cd worktree 再执行」但獭已经 cd 了——死路循环，abort 后獭失联半小时。

**数据源**：healing_events context 已有的 ruleId（F20260930gslog 台账结构化，guard-intercept-classify.ts 分类）。新增 `getRecentGuardBounceEvents` 回调（TurnCallbacks 可选），复用 `countRecentGuardBounces` 查询路径，返回完整事件（含 ruleId/commandHead）而非仅计数。

## 影响范围

- `src/frameworks/agent/bash-safety-guard.ts`：`hasRealCdSegment` :1529 正则修正（1 处字符级变更）
- `src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts`：新增 `GUARD_BOUNCE_SAME_RULE_MAX` + `buildGuardBounceSuspectedFpMsg` + `buildGuardBounceSuspectedFpRetryMsg`
- `src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts`：`handleGuardBounce` 插入同规则判定分支 + 新增 `detectSameRuleBounce` / `deescalateGuardBounceSuspectedFp` 两方法
- `src/usecases/conversation/agent-turn-orchestrator/types.ts`：`TurnCallbacks` 新增可选 `getRecentGuardBounceEvents`
- `src/interface-adapters/agent-runtime/circuit-break-support.ts`：新增 `recentGuardBounceEvents` 查询
- `src/interface-adapters/agent-runtime/agent-invoker.ts`：`createTurnCallbacks` 注入 `getRecentGuardBounceEvents`

## 验证

- P0-1 回归测试（6 例）：
  - 修复面：`cd wt && node -e 多行只读 2>/dev/null || node 备用链`（parseOk=false 落 V1 兜底链）放行；`cd wt && git status || echo fallback` 放行
  - 不误伤面：`cd wt & git commit`（后台子 shell）仍拦；引号假 cd 仍拦；`cd .` 平凡目标仍拦；cd 前写命令仍拦；#1240 heredoc 负门仍拦
- P0-2 回归测试（4 例）：
  - 同规则 3 连（ruleId 同且非 unknown）→ 降级通道：疑似误拦通知 + invoke failed 终态 + suspected_false_positive high 落账
  - 异规则 3 连（mixed ruleId）→ 仍走原 abort 终态
  - unknown ruleId 3 连 → fail-closed 走 abort
  - 事件查询失败（台账失明）→ fail-closed 走 abort
- 全仓 `npx vitest run`：5022 例全绿（基线 3941 → 修复后 5022，新增 81 例含本特性 10 例）
- `npx tsc --noEmit`：通过
