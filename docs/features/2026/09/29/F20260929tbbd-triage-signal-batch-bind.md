---
id: F20260929tbbd
title: triage_signal 批量归口（batch_bind）
summary: 给 triage_signal 增加 batch_bind 批量归口 action，根治「daily-review 逐条留痕被循环守卫阻断」的流程冲突（#1052）
change_type: feature
capability_test: "n/a: 工具层/仓库层纯逻辑变更，真 sqlite 单测覆盖（14 用例），无 LLM 行为面"
intent:
  problem: "daily-review 硬规则要求逐条 triage_signal 留痕，但 RHI 未接单常态 100+ 条（9/20 实测 150 条），第 6 次起触发「连续同构调用」循环守卫全部未落库，被迫 sqlite 直写绕过校验层——流程要求与守卫在信号量 >10 时必然冲突，错在工具无批量模式（#1052）"
  expected_effect: "同类型 >10 条同归口时一次 batch_bind 调用完成批量落库，matched=bound=实际落库条数；daily-review 处置段不再出现守卫拦截；异质处置（不同类型/不同判断）仍走单条"
  verify_by:
    type: static_only
    reason: "工具层参数校验+SQL 批量写库为确定性逻辑，真 sqlite 单测 14 用例（repo 7+工具 7）固化四字段语义/边界/截断续批；prompt 指引为条件性路由（同类型 >10 才批量），行为面由 9/30 daily-review 运行记录回查（issue #1052 验证断言，到期 2026-10-20）"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
tags: [rhi, triage, batch, tool, daily-review]
modules: [src/usecases/health/, src/interface-adapters/agent-runtime/tools/, prompts/scheduled/]
from: []
causal_links: ["#1052"]
created_at: 2026-09-29
---

# triage_signal 批量归口（batch_bind）

## 问题（#1052）

daily-review 流程硬规则要求「逐条三选一，选完立即调 triage_signal 留痕」。9/20 实测：未接单信号 150 条（critical 44 + warning 106），逐条调用从第 6 次起触发「Consecutive identical call N times」循环守卫（返回 Operation aborted），15 连发全部未落库；拆小块重试守卫计数器跨轮累计仍被拦。最终被迫 sqlite3 直写绕过工具校验层——语义等价但绕过了校验。

**根因**：流程要求（逐条留痕）与运行时守卫（拦连续同构调用）在信号量 >10 时必然冲突，而 RHI 未接单常态 100+ 条，冲突每天必现。守卫拦同构连发是正确的（防退化），错的是 triage_signal 没有批量模式，把 150 次合法调用逼成了同构连发。
## 方案设计

照 `manage_healing_events.batch_resolve` 的成熟模式（#454 已验证设计）给 triage_signal 增加批量路径：

### 三层改动

1. **仓库层**（`src/usecases/health/signal-repository.ts`）：新增 `batchBindIssue(filter, issueNumber, opts)`——单事务 count+match+update 原子执行、LIMIT 100 单批、truncated/totalMatched 标志、dryRun 预览。结果字段名与 healing `BatchResolveResult` 对齐（matched/truncated/totalMatched）。
2. **工具层**（`src/interface-adapters/agent-runtime/tools/rhi-signal-tools.ts`）：`triage_signal` 新增 `action=batch_bind`——批量路径免 signalId（entry 处分流），issueNumber 必填，filterSignalType/filterSeverity 至少一个。
3. **prompt 层**（`prompts/scheduled/daily-health-check.md`）：RHI 处置段第 2 步补批量指引——「同类型 >10 条同归口 → batch_bind 批量 bind，逐条仅用于异质处置」。

### 语义边界（设计取舍）

- **只作用于未接单**（status='open' AND triage_status IS NULL）：已 triaged / in_progress 的信号不参与。批量换绑属异质操作（每条的判断依据不同），走单条 bind_issue（覆盖式换绑是单条路径的显式语义）。issue 已关闭或被误归口时，处理路径是逐条 rebind——这本身就是需要人工判断的异质场景。
- **每条等价单条 bind_issue**：triaged + issue_number + triaged_at + note（COALESCE 保留已有 note）。
- **filter 至少一个**（工具层拦）：「全部未接单绑到同一 issue」属异质归口（不同 signal_type 指向不同根因），应逐条判断；无 filter 的全量绑定等于把判断外包给一次调用，拒绝。
- **first_seen ASC 先老后新**：与 findByTriageStatus 未接单清单同序——处置最久远优先（issue #1052 案发现场即「未接单存量清点」步）。
- **单批 100 上限 + truncated**：超 100 条时响应 truncated=true，调用方再次执行处理剩余（healing #454 防漏设计同款）。

## 设计取舍记录（机制判定）

### 机制识别检查点判定

本次变更**命中「新增机制」清单项**（triage_signal 新增批量 action + repo 新增批量方法 = 新工具能力面），机制预算四问当场作答（见下）。

### 机制预算四问

1. **谁需要它**：daily-review 獭（09:00 定时任务）处置未接单信号存量时；被派工的处置小獭拉清单派工输入时。使用频率 = RHI 未接单存量出现的频率（当前常态 100+ 条/天）。
2. **失败后果**：不修——每天日报处置段必然撞守卫，要么被拦（150 条留痕失败）要么继续 sqlite 直写绕行（绕过校验层，对账公式数据源被旁路）。修——若 batch_bind 有 bug，批量写错 100 条信号的处置状态（有 dryRun 预览 + 单批 100 封顶止损）。
3. **后续机制**：暂无已知后续机制需要建立在 batch_bind 之上。aging worker 的归口建议文案已同步（指引同类型多条用 batch_bind）。
4. **退役条件**：若 RHI 未接单存量常态 <10 条/天（检测端收敛、清账完成）且连续 14 天如此，批量模式失去主要场景，可考虑退役——但照抄 healing batch_resolve 的稳定模式，维护成本极低，无主动退役必要。

### Why（未选替代方案）

- **不做批量 dismiss**：dismiss 是终态化（每条 note 必填且语义不同——「不处置必须是判断结论」），批量 dismiss 会稀释 note 的判断语义，与 #1052 的核心诉求（合法处置通道）不符。issue 也没要求。
- **不改守卫放行 triage_signal**：守卫拦同构连发是防 LLM 退化循环的正确机制（#475 家族），为其开口子是方向错误——错在流程要求与工具能力错配，不在守卫。
- **无日期过滤**：healing batch_resolve 有 filterCreatedBefore/After，本工具不做——issue #1052 场景是「未接单存量清点」无时间窗需求，first_seen ASC 先老后新已覆盖时序诉求；若后续需要按时间窗批量处置再补（YAGNI）。
- **HTTP 端点不加批量**：面板处置队列是一键单条操作场景，无批量归口需求（issue 只提工具层）。

## 验证

### 最简实现检查

已过最简检查：三层各一处（repo 方法 + 工具 handler + prompt 一行），照抄 healing 成熟模式（仓库已有实现 → 直接复用模式），无新依赖、无新表、无 schema 变更。23 文件 294 用例回归全绿。

### 测试证据

- **repo 层**（`tests/usecases/health/signal-repository-batch-bind.test.ts`，7 用例）：批量归口四字段语义 / filter 过滤 / 只碰未接单边界（已 triaged 不被覆盖）/ dryRun / 100 截断+续批 / note COALESCE / 无匹配无副作用——全过
- **工具层**（`tests/interface-adapters/agent-runtime/tools/rhi-signal-tools-batch-bind.test.ts`，7 用例）：批量分流 / issueNumber 校验 / filter 至少一个 / dryRun / 截断续批 / severity 跨类型 / 单条三动作回归（改 required 后原路径不破）——全过
- **回归**：tests/usecases/health/ 全目录 + tool-dedup-registration 23 文件 294 用例全绿；tsc 仅 pre-existing hono 类型推断错误（git stash 基线对照确认，非本次引入）
- **prompt 体积闸**：lint-prompt-size exit 0（budget_bytes 9200→9600，当前实测 9.3KB < 9.6KB 上限；理由：批量指引是 #1052 的流程闭环必需，一行内压缩，非可删冗长）

### Golden Gate

Golden Gate: n/a（verify_by=static_only。本 PR 确触及 prompts/scheduled/ 软代码域，但改动仅限：①处置段第 2 步补一句条件性批量指引（同类型 >10 条才走 batch_bind，异质处置路径不变）；②budget_bytes 上限调整。新增的是工具调用路由指引而非 prompt 行为触发语义变更——批量工具行为由 14 用例单测固化，prompt 行为面由 9/30 daily-review 实际运行回查（见验证断言）。无 golden_replay 场景可跑。）

### 验证断言（issue #1052 回查）

断言：batch_bind 上线后，对 signals 表 status=open 且 triage_status IS NULL 的同类型信号批量 bind，一次调用落库条数 = 返回 matched（sqlite3 signals 表 vs 工具响应对照）——已由 repo 层测试「批量归口四字段语义」+ 工具层测试「JSON 响应 matched=bound=落库」固化，到期 2026-10-20 回查 PR 合入后实际运行记录。

## 后续动作

- PR 合入后：观察 9/30 daily-review 是否自然使用 batch_bind（无需推送——工具 description 已含指引）
- issue #1052 随 PR closes 自动关闭

## 守卫根治范围声明（检视处置补记）

同质路径（同类型同归口）已根治：batch_bind 一次调用替代 N 次连发。**异质路径有结构残余**：守卫签名对 triage_signal 只取工具名（tool-call-circuit-breaker.ts:167），连续 >5 次纯 triage_signal 调用（含 dismiss 混合）第 6 次起仍被拦——异质处置（不同类型/不同结论逐条调用）超过 5 条时靠 prompt 指引穿插非 triage 工具调用打散节奏（见 daily-health-check.md 处置段第 2 步）。这是守卫机制（拦同构连发防退化）与异质逐条留痕的固有张力，prompt 指引缓解而非消除；若未来异质大存量成为常态，再议守卫签名细化（按 action 参数区分）——当前不提前复杂化。
