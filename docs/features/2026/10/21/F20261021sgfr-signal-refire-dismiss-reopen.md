---
id: F20261021sgfr
title: "信号 upsert re-fire 缺口修复：dismiss 后同键 re-fire re-open 原行，孪生行归零"
summary: "SignalRepository.upsert 只匹配 open 行，dismiss 后同键 re-fire 新开孪生行旁路处置留痕（#1563，PR #1560 现场 9 对孪生行实证）。修正为：同键有 open 行累加；无 open 行且最新行 dismissed → re-open 原行（occurrences+1、triage_note 保留历史）；resolved 命中保持新开行（历史保留契约不回退）。"
change_type: fix
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
doc_type: feature
tags: ["health", "signals", "rhi", "upsert", "bugfix"]
modules: ["src/usecases/health/signal-repository.ts", "tests/usecases/health/signal-repository.test.ts"]
created_at: 2026-10-21T11:23:36+08:00
---

## 背景与需求

Issue #1563（搭档 2026-10-20 卡片回执点名立案）：`SignalRepository.upsert` 只匹配 `status='open'` 行，无匹配则新开一行——被 dismiss 的信号若再次触发（旧口径扫描持续运行 / 口径变更窗口期），同键孪生行被创建，**dismiss 留痕与新行并存**。

现场实证（2026-10-19，PR #1560 修复轮）：恢复 9 条误 dismiss 信号时每条都冒出同键孪生行（id 501-510 回指原行），dismiss 窗口期内旧口径扫描给每条新开了一行，共 9 对；同窗口 20 分钟内 open density 信号 16 → 28。

危害：dismiss 处置结论被旁路（「关了又开」）、计数与验收断言被污染、留痕可信度受损。`scripts/sweep-stale-signals.mjs`（PR #1560）可清扫存量但治标不治本。

## 方案设计

### 修复语义（设计取舍，L1 拍板）

同键 re-fire 分派三分支：

| 同键命中情形 | 行为 | 理由 |
|---|---|---|
| 有 open 行 | 累加（occurrences+1、last_seen/evidence 刷新） | 原有行为，头注释声明的设计意图 |
| 无 open 行，最新行 dismissed | **re-open 原行**：occurrences+1、status='open'、resolved_at=NULL，triage_note 保留历史痕迹 | dismiss=「判断不处置」，新开行旁路该判断致无限孪生；re-open 让重新活跃信号回未接单队列重审 |
| 无 open 行，最新行 resolved（或无同键行） | 新开一行 | 复发=新事件（F20260917trig §3），既有测试「历史保留」契约锁定，不回退 |

**弃「统一 re-open 任意终态」方案**：破既有测试契约（resolved 后新开行是显式设计）且损失复发历史语义；issue 立案现场（9 对孪生行）与关闭标准的「孪生行」上下文均为 dismiss 场景。

**匹配序刻意优先 open 行而非「同键最新行」**（issue 修复方向的字面是「任意状态的最新行」，此处取防御变体）：存量库存在 open/dismissed 并存孪生对（PR #1560 现场），优先累加 open 行避免 re-open 再制造双 open 并存。

### 机制识别检查点判定（issue 驱动，动手前完成）

逐项打勾：新增配置字段/枚举/开关 ✗｜新增状态生命周期 ✗（复用既有 open/dismissed/resolved 状态机，re-open 是 dismissed→open 的既有状态迁移面修正，不引入新状态）｜新增定时任务/后台进程 ✗｜新增信号类型/消息格式 ✗｜新增持久化存储 ✗（无新表新字段）｜新增决策分支 △ 边缘（见下）｜新增跨模块调用路径 ✗。

边缘项「新增决策分支」论证：upsert 已有 UPDATE/INSERT 双分支，本次修正 UPDATE 分支匹配条件并把 dismissed 命中并入 UPDATE（reopenDismissed 复用与 UPDATE 分支同构的列刷新 SQL），无新分支类型、无新持久化结构、无被记住的新决策面——不涉净新增机制。**修法决策树①（既有语义内修，narrow-fix）**：signal-repository.ts 头注释声明「相同 signal_type + feature_id/file_path 的重复触发做 occurrences 累加而非新开一行」是设计意图，dismiss 后新开行是实现偏离声明语义的缺口，修回语义而非新增机制。

## 实现要点

- `upsert` 匹配拆两步：先查同键 open 行（原有 SQL，变量更名 openRow）；无命中再查同键最新行（任意状态）按 status 分派——dismissed 走 `reopenDismissed`，其余走 `insertNew`
- `reopenDismissed`：UPDATE 刷新 status='open'、resolved_at=NULL、last_seen/occurrences/evidence/evidence_detail(COALESCE)/confidence(COALESCE)/severity/suggested_action(COALESCE)——列集与 open 累加分支同构；first_seen/created_at 不动（原行历史时间轴保留）；triage_note 保留（F20260917trig §6 抹平语义下 dismiss 时 triage_status/issue_number 已置 NULL，re-open 后即「未接单」，走完整处置流程）
- 返回值拼装复用 `coalesceExisting` + status/resolved_at 覆写
- 存量孪生行清扫仍由 `scripts/sweep-stale-signals.mjs` 承担（本修复管增量不产孪生，存量治理脚本继续有效）

## 验证

### 失败证据链（bugfix 硬规则）

- 修复前（固化失败，改动仅测试文件）：`Tests  5 failed | 22 passed (27)`——5 个新用例全红且因预期原因（dismiss 后 re-fire 新开行 r2.id≠r1.id、triage_note=null、同键行数 6/16、孪生组 9、first_seen 被重置）
- 修复后：`Tests  27 passed (27)`
- 全量回归：`npm test` → `Test Files 410 passed (410) / Tests 6555 passed | 6 skipped (6561)`
- 新用例清单：dismiss re-fire re-open 原行｜triage_note 历史保留｜dismiss↔re-fire 循环行数恒 1｜口径变更窗口重放孪生行 0（9 组模拟 PR #1560 现场）｜re-open 不回改 first_seen｜resolved 后 re-fire 仍新开行（回归锁定，修复前天然绿，不计入失败证据——#1583 计数口径）
- 既有测试零改动（含「resolved 后同键再触发新开一行（历史保留）」契约测试）

### 验收标准（断言化）

| 场景 | 操作 | 预期结果 |
|---|---|---|
| dismiss 后 re-fire 不开孪生行 | `npx vitest run tests/usecases/health/signal-repository.test.ts -t "dismiss 后同键 re-fire"` | PASS：r2.id=r1.id、status=open、occurrences=2 |
| 口径变更窗口重放孪生行 0 | 同上 `-t "口径变更窗口重放"` | PASS：GROUP BY 同键 HAVING cnt>1 结果为空、findOpen=9、dismissed=0 |
| resolved 契约不回退 | 同上 `-t "resolved 后同键 re-fire"` | PASS：新行 id 不同、resolved 历史保留 |
| 全量回归 | `npm test` | 410 文件全过（6555 passed） |

### 最简实现检查

已过阶梯：无新依赖/新表/新字段/新配置，改动收敛在 upsert 一个方法 + 一个私有方法（reopenDismissed，列刷新 SQL 与既有 UPDATE 分支同构复用 coalesceExisting）；无更简实现可弃——已确认最简。

### 负面向验收条目（刹车二）

- **本次变更破坏了什么旧契约**：「dismiss 后 re-fire 新开行」的行为契约被改写为 re-open——该行为正是本 issue 要修的缺口本身，无其他契约被破坏；「resolved 后 re-fire 新开行（历史保留）」契约显式保留并有回归锁定测试。
- **绕过了什么既有保护**：无——不绕过任何守卫/兜底；triage 状态机的终态保护（resolve/dismiss 只作用 open 行）不动；re-open 只走 upsert 单一入口，不为其他入口开口子。

### 影响面当场自检

- F20260917trig §3「复发新行不继承旧行绑定/note」注释：resolved 复发仍新行 ✓ 未失效
- signal-repository.ts 头注释「重复触发做 occurrences 累加而非新开一行」：本修复使实现兑现声明 ✓
- `scripts/sweep-stale-signals.mjs`（PR #1560 过渡缓解）：存量孪生行仍需它清扫，继续有效 ✓
- issue #1563 修复方向「或引入同键去重约束」：取语义修正路径（或选项之一）✓ 不矛盾

## 能力测试建议

无（代码逻辑修复，verify 不涉 prompt/skill 层，Golden Gate n/a）。
