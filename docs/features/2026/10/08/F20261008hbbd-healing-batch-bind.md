---
id: F20261008hbbd
title: healing 事件批量归口机制（batch_bind）
summary: "healing 侧照 RHI batch_bind 先例新增 batch_bind：按 errorType+ruleId 把 guard_intercept 同族事件批量归口到 GitHub issue（bind≠resolve，事件保持 open 直到修复合入后按 filterBoundIssue 收尾）。bound_issue/bound_at 字段化加列（可 SQL 聚合）+ 存量库幂等迁移 + high 批量闸归口豁免（已归口 high 可随 issue 收尾，未归口仍拦）+ daily-health-check 批量归口指引。"
created: 2026-10-08
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
change_type: feature
capability_test: "tests/interface-adapters/agent-runtime/tools/healing-batch-bind.test.ts"
status: active
modules:
  - src/entities/healing/
  - src/usecases/healing/
  - src/frameworks/db/healing/
  - src/frameworks/db/
  - src/interface-adapters/agent-runtime/tools/
  - prompts/scheduled/
tags: [healing, batch, bind, guard-intercept, tool, migration]
from: []
causal_links:
  - "#1271（本 issue）"
  - "#1253（F20260930gslog 结构化落账——ruleId 字段来源）"
  - "#1052（RHI batch_bind 先例，PR #1237）"
  - "#1361（healing 治本三层——层3 bind_issue 规则的消费端配套）"
intent:
  problem: "PR #1253 把 guard_intercept 落账升级为 ruleId 指纹分类器后消费端是空的：open 事件只能逐条 resolve/dismiss，单条 >5 次连续同构调用撞「连续同构调用」循环守卫；9/30 实证 63 resolved + 43 open，归类信息只活在 resolutionNotes 文本里无法聚合查询。10/8 生产库复测：157 open 中 135 条 guard_intercept（main_write 70 / sleep_block 11 / 旧无 ruleId 46），痛点仍在扩大。"
  expected_effect: "guard_intercept 同 ruleId 事件族可批量归口到 GitHub issue（bind≠resolve），归类信息从文本升为可 SQL 聚合的结构化列；修复合入后按 issue 收尾批量 resolve 形成闭环。消费端从逐条变批量，绕开循环守卫。"
  verify_by:
    type: capability_test
    note: tests/interface-adapters/agent-runtime/tools/healing-batch-bind.test.ts（14 用例：工具层校验/闸豁免/收尾环 + 仓储层 ruleId 过滤/幂等面 + 存量库迁移幂等）+ 生产副本真启动迁移验证（PR Verification 节）
---

# healing 事件批量归口机制（batch_bind）

## 背景与问题

- **来源**：issue #1271（三省吾身 10/1 每日健康检查发现），对话《issue处理》认领
- **前置已合入**：#1253（F20260930gslog）——guard_intercept 落账带 `context.ruleId/ruleLayer/commandHead/hasWorktreePath` 结构化字段（ruleId 指纹分类器）
- **痛点实证**（生产库 10/8 快照）：
  - 157 open 事件中 135 条 guard_intercept：`main_write` 70、`sleep_block` 11、`script_file_exec` 3、`data_destructive` 3、`self_kill_nonliteral` 2、旧格式无 ruleId 46
  - 逐条 resolve 单调重复，>5 次连续同构调用撞「连续同构调用」循环守卫
  - 归类信息只活在 resolutionNotes 文本——「哪些事件归了哪个 issue」无法聚合查询
- **RHI 对照**：signals 侧已有 batch_bind（PR #1237 修 #1052 同类问题，F20260929tbbd）；healing 侧只有 batch_resolve（同型处置 ≠ 归口聚合）

## 方案设计

照 RHI `batchBindIssue`（signal-repository.ts）成熟模式做 healing 版，三层改动：

| 层 | 文件 | 改动 |
|---|---|---|
| 实体 | entities/healing/healing-event.ts | `boundIssue?: number \| null` + `boundAt?: string \| null` 字段 |
| 接口 | usecases/healing/healing-event-repository.ts | `batchBindIssue(filter, issueNumber, opts)` + `BatchBindResult` + filter 扩展 `ruleId`/`boundIssue` |
| 仓储 | frameworks/db/healing/sqlite-healing-event-repository.ts | 单事务 count+match+update 原子执行；LIMIT 100 单批；truncated/totalMatched；dryRun 预览；`buildBatchWhere` 扩 ruleId（`json_valid`+`json_extract`）与 boundIssue（null=未归口面）条件 |
| schema | frameworks/db/schema.ts | 新库直建 `bound_issue INTEGER`/`bound_at TEXT` 两列 + `idx_healing_events_bound_issue` 索引 |
| 迁移 | frameworks/db/migration.ts | `ensureHealingEventsBoundIssueColumns`（PRAGMA table_info 幂等加列 + 索引补建） |
| 工具 | interface-adapters/agent-runtime/tools/healing-tools.ts | `batch_bind` action：issueNumber 必填 + 至少一个过滤条件（防异质归口）；batch_resolve 透传 `filterRuleId`/`filterBoundIssue`；high 批量闸加归口豁免 |
| prompt | prompts/scheduled/daily-health-check.md | 「healing events 消费即处置」段补一行同族批量归口指引（该文件 #1361 未触碰，无冲突） |

### 归口语义（bind ≠ resolve）

**对齐 RHI 并与 #1361 层3 兼容**：bind 后 `bound_issue`/`bound_at` 写列，**状态保持 open**。

依据：#1361（healing 治本三层，open PR）层3 给 self-healing-analysis.md 写入的硬规则是「high 必须 bind_issue 归口，不得直接 dismiss/resolve；bind 后事件在 issue 内讨论关闭」。这预设了：
1. bind 是「结构化认领」——事件被送进 issue 跟踪面，但没有被处置
2. 终态仍是 resolve/dismiss——在修复合入后执行
3. 因此 healing 侧 bind_issue 的正确语义 = 写归口列 + 保持 open（与 RHI bind 后 triage_status='triaged' + status='open' 同构）

**生命周期**：`open`（未归口）→ `batch_bind` → `open + bound_issue=N`（已归口待修）→ 修复合入 → `batch_resolve + filterBoundIssue=N` → `resolved`。

**issue 关闭 → 事件自动 resolve 联动：不做（YAGNI）**。理由：
- issue 关闭时机 ≠ 修复合入时机（issue 常在验证后关闭），自动联动会把「合入但未验证」的事件误终结
- 收尾动作已有批量路径（filterBoundIssue），一步操作成本低
- GitHub webhook 监听属新机制（网络依赖 + 新失败面），本期收益不覆盖成本
- #1361 的规则文本也未预期自动联动（「bind 后在 issue 内讨论关闭」= 人工决策）

### 存储（加列 vs 复用 context JSON）

**加列**。理由：
- RHI 字段化先例：signals 的 `issue_number`/`triage_status` 都是列（可 SQL 聚合、可索引、类型安全）
- context 是**事发快照**（谁、什么命令、什么规则拦的）——处置状态信息混入会污染快照语义，且 `json_extract` 过滤无法建索引（本 PR 的 ruleId 过滤已用 json_valid 防御，若 bound 也走 context，收尾查询会更慢）
- 迁移成本可控：两列全 nullable，幂等加列对齐 `introduced_by_pr`（F20260827he2f）既有模式

### 批量闸（high 是否允许 batch_bind）

**允许，不设闸**——与 batch_resolve 的 high 闸相反且有意为之：

- batch_resolve 的 high 闸（F20260908gfrc）语义是「禁批量**静默**」——high 是升级信号，一键 resolve 会淹没它
- batch_bind 是「结构化认领」：把升级信号送进 GitHub issue 跟踪面，是放大信号不是静默它
- #1361 层3 恰要求「high 必须 bind_issue」——若 batch_bind 设闸，high 事件族（往往最大）反而不能批量归口，机制自我矛盾
- **batch_resolve 的闸加归口豁免**：探测面叠加 `boundIssue: null`（只数未归口 high）。已归口 high 可随 issue 收尾批量 resolve——否则 high 族修复合入后永远无法批量终结，正是 #1271 要治的堆积病。用户显式传 `filterBoundIssue=N` 时更新面已限定在已归口域，探测跳过（避免闸面外溢误拦：更新面外的未归口 high 不该阻塞本次收尾）
- 未归口 high 仍全量拦截——闸本体语义不变，双向语义见测试「收尾环」用例

### 过滤条件（防异质归口）

- `filterErrorType`（已有）+ `filterRuleId`（新）+ `filterSeverity`（新，bind 用）/ `filterCreatedBefore`/`filterCreatedAfter`
- **至少一个过滤条件**才允许 bind（对齐 RHI batch_bind 门槛）——无过滤全量 bind 会把不相关事件族归到同一 issue
- guard_intercept 标准归口法：`filterErrorType=guard_intercept + filterRuleId=<指纹>`（同 ruleId = 同根因事件族）
- 旧格式无 ruleId 事件（46 条）：可按 `filterErrorType + filterCreatedBefore` 时间窗归口，或升级落账来源后自然消化（存量事件不回填 ruleId——context 是事发快照，不可篡改）

## 设计取舍（机制识别检查点 + 四问）

**机制识别命中**：新增持久化字段（bound_issue 列）✓、新增工具 action（batch_bind）✓、新增决策分支被持久化消费（bound 状态影响 high 闸判定）✓ → Modification-Class: **mechanism-addition**。

**机制预算四问**：

1. **谁需要它？** healing 事件消费端（daily-health-check / daily-review / self-healing-analysis 定时任务 + 大獭日常处置）。没有它，guard_intercept 事件族只能逐条处置（撞循环守卫）或文本留痕（无法聚合）。
2. **失败后果？** batch_bind 失败 = 归口不生效，事件仍 open 未归口——**零数据风险**（bind 不改 status/resolution，只写两列；写列失败事务回滚）。最坏情形是「该归口的没归口」，回到现状。
3. **后续机制？** 出错面三种：① bind 错 issue → 新 issue 重 bind？**不支持批量换绑**（boundIssue:null 强制未归口面，宁拒不猜）——错绑需逐条判断，防误操作级联；② issue 编号不存在 → GitHub 侧无效链接，事件状态无恙（编号校验留给调用方，工具层已校验正整数格式）；③ ruleId 拼写错误 → matched=0 自然暴露（dryRun 先行可预览）。
4. **退役条件？** guard_intercept 事件族清零且落账机制不再产生堆积时。机制本身与 batch_resolve 同生命周期，不需要独立退役。

**被否方案**：
- 归口即 resolved：与 #1361 层3 语义冲突（high bind 后在 issue 内讨论，修复合入才终态）✗
- 复用 context JSON 存 bound 信息：污染事发快照 + 无法索引聚合 ✗
- issue 关闭自动联动 resolve：YAGNI（上文论证）✗
- 批量换绑（bind 覆盖 bound_issue）：误操作级联风险，宁拒不猜 ✗
- 监听 GitHub webhook 验证 issue 存在性：新网络依赖 + 失败面，编号格式校验已足够 ✗

## 影响范围

| 面 | 影响 |
|---|---|
| 存量行为 | **零变化**——新列全 nullable，旧读写路径（SELECT * 自动带新列，mapper 容缺省）不受影响；batch_resolve 不传新 filter 时行为与 main 完全一致 |
| high 批量闸 | 微调：未归口 high 仍拦（本体不变）；已归口 high 可随 filterBoundIssue 收尾（新增豁免面，见测试锁定） |
| 循环守卫 | batch_bind 单次调用归口 ≤100 条——同族 >100 条时 truncated=true 提示再次执行，天然绕开「逐条同构调用」守卫 |
| #1361 撞车 | 同 healing 域且**重叠 3 文件**（sqlite-healing-event-repository.ts / healing-event-repository.ts / rhi-signal-aging-worker.test.ts，r1-S3 订正：首版「文件不重叠」宣称失实）。#1361 时间序先合，本 PR rebase 兜底——三文件冲突面已预判（本 PR 触仓储尾部 append + 接口扩展，#1361 触告警/提醒链路，语义区隔但同文件需手工合并） |
| prompts 范围 | 只补 daily-health-check.md 一行（#1361 未触碰该文件）；self-healing-analysis.md **不动**（#1361 正在改，PR 合入后其 bind_issue 规则文本与本工具语义已兼容） |

## 已知边界

- **批量换绑不支持**：已归口事件换 issue 需逐条判断（设计取舍，防误操作级联）
- **issue 存在性不校验（r1-S2 订正）**：工具层只校验正整数格式。幻觉 issue 编号的两步链风险（bind 到不存在 #N → filterBoundIssue=N 收尾 → high 静默终结）确实可达——缓解：工具 description 已提示「bind 前 gh issue view 确认」；收尾动作本身是「修复合入已验证」的显式声明。机棧性校验（bind 时 gh 查询）属新网络依赖与失败面，本期不承载，消费端纪律承担
- **ruleId 过滤依赖落账质量**：46 条旧格式无 ruleId 事件不能按指纹归口，只能时间窗归口或随来源升级自然消化
- **query action 未透出 bound 字段过滤**：query 走 findAll 内存过滤，batch 面（dryRun/countByFilter）已覆盖聚合需求；query 加 filter 属锦上添花，本期不做
- **#1361 语义交互（r1-S3 声明）**：#1361 层3 的超龄 high 推 alert-registry 逻辑不识别 bound_issue——已归口的超龄 high 仍会被推提醒（预期内：issue 内讨论是它们的归宿，但提醒不会因归口而止）。若需感知归口状态属 #1361 后续演进，不在本 PR 范围

## 验证

- 单测 14/14 绿（healing-batch-bind.test.ts）：工具层校验矩阵（issueNumber/防异质/dryRun/bind≠resolve/防换绑/只作用 open/truncated/high 无闸）+ 收尾环（已归口 high 可批量 resolve、未归口仍拦、h3 不误伤）+ 仓储层（ruleId 过滤含非法 context 防御/boundIssue 双向计数/时间窗组合/filterBoundIssue 收尾）+ 迁移（DROP COLUMN 模拟旧库 → 补列 + 索引 + 幂等重跑 + 旧库行可 bind）
- 聚焦域 479/479 绿（tools + db + healing 域 51 文件）；tsc rc=0；eslint rc=0
- 全量 5028/5033：5 个失败均为 pre-existing flaky（guard-intercept-classify 的动态 import 竞争超时——main 基线 stash 复现同样超时，与本 PR 无关；cost-output-collector/lint-historical-docs 系列单跑全绿，全量并行 IO 争抢超时）
- **生产副本真启动**：主库 1.17GB 一致性复制 → 新代码 migrateDatabase 101ms 完成补列 + 索引 → 幂等重跑 65ms 不炸 → main_write 可归口面 71 条行为验证通过 → 副本删除
- 修复前失败证据：main 基线上 batch_bind action 不存在（工具返回「未知操作」）、ruleId/boundIssue 过滤不存在（countByFilter 不识别）

## r1 对抗审视处置记录（检视獭-1365，mimo-pro）

**结论：需要修改（3 严重 + 3 建议）→ 全部处置（处置 commit 见 PR）**

| 发现 | 定级 | 处置 |
|---|---|---|
| S1 探测面/更新面 WHERE 不对称——普通 batch_resolve 顺带终结已归口 high | 严重（PoC 实锤） | ✅ 修复：batch_resolve 未传 filterBoundIssue 时 filter 强制 `boundIssue: null`（更新面与探测面对称）。已归口事件必须走显式 filterBoundIssue=N 收尾——收尾动作本身就是「修复合入已验证」的声明。+场景 X 锁定用例（h1 已归口 high + l1 low → 普通批量 → resolved=0，h1 保持 open+bound） |
| S2 假 issue 两步链静默处置 high | 严重 | ✅ 最低处置（按检视建议）：工具 description 补「issueNumber 须真实存在，bind 前 gh issue view 确认」+ 已知边界订正（首版「事件状态无恙」在 bind→resolve 链下失实，已改写）。机械校验属新网络依赖，本期不承载 |
| S3 B5 描述宣称失实——与 #1361 实际重叠 3 文件 | 严重 | ✅ 特性文档影响范围表订正（重叠文件清单 + 冲突面预判）+ PR 描述订正。顺序承诺（#1361 先合）不变 |
| A1 dryRun matched 语义与真实执行不一致 | 建议 | ✅ batchResolveByFilter dryRun 分支补 truncated/totalMatched，matched=min(count,limit)——150 条时消费端看到分批预告而非以为一次干完。+用例（工具层+仓储层双验） |
| A2 schema.ts 双 ALTER 共用单 try/catch | 建议 | ✅ 每列独立 try/catch——半迁移状态不再被整体吞掉 |
| A3 B7 机械不通过（golden results 无记录） | 建议 | ✅ 环境事实声明：本机 LLM 未配置（OTTER_TEST_LLM_API_KEY 缺失），golden 采样在 CI/搭档环境执行——与 #1254 F20260930esqu 同款声明 |
