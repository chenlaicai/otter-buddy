---
id: F20260901sgn4
title: "零成本检测器与指标：环比骤变 + behavior_defect 窗口化 + 修复半衰期 + 僵尸链阶梯"
summary: "Issue #645 落地：score_jump 环比骤变检测器（快照 |Δ|≥10 报警）、behavior_defect 7 天窗口化升级（历史事件不再永久累计 + 聚合排序）、修复半衰期派生指标（trend 快照行供 sparkline）、僵尸链 30/60/90 阶梯文案。全确定性零 LLM。"
change_type: feature
status: development
created_at: 2026-09-01
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
capability_test: "n/a: 纯确定性信号层改动（检测器纯函数+快照行+DB 查询方法），无 LLM 行为涉及"
intent:
  problem: "合议定稿（review-lunheng.md Issue B）指出的四个检测盲区：1) 五维/综合分单日骤变无人报警，每日检查任务无触发器可消费；2) behavior_defect 全量聚合无窗口，历史遗留事件永久累计（实查 degenerate 57 次/12 天应为报警模式，但所有老类型也永远挂着）；3) 修复节奏（bug 间隔缩短=退化）无量化指标；4) 僵尸链只有 30 天一档，60/90 天该有阶梯处置语义。"
  why_now: "Issue A（#644 PR1，F20260901rhdt）已合入 health_index 快照与置信分层基础设施——环比骤变的分母（前日快照）和信号管道（open 信号流）都已就位，本 issue 是数据修真后的检测器补全。"
  expected_effect: "每日检查任务从 open 信号流看到 score_jump 报警自动深挖当日变更；behavior_defect 只看 7 天窗口内复发，第一天就能报出 degenerate 模式；sparkline 可从 trend/bugfix_interval 序列画修复半衰期曲线；僵尸链证据文案带 30/60/90 档位供每日任务分拣归档。"
---

## 方案

### 四项改动的实现形态

| 项 | 形态 | 落点 |
|---|---|---|
| 环比骤变 | **检测器**（走 signal 管道，open 信号流可消费） | detect-signals.ts `detectScoreJump` + registry `score_jump` |
| behavior_defect 窗口化 | **升级既有检测器**（非新造，合议 §1.2） | detect-signals.ts `detectBehaviorDefect` 加 7 天窗口 + 降序排序 |
| 修复半衰期 | **派生指标非检测器**（不产生信号，合议 §1.3） | fix-halflife.ts 纯函数 + worker 落 trend 快照行 |
| 僵尸链阶梯 | **文案增强**（复用 chain-builder zombie 判定，不动状态机） | detect-signals.ts `zombieLadderLabel` |

### 关键设计决策

- **score_jump 环比口径 =「最近两个完整快照日」**：当日行会被小时级扫描反复覆盖（replaceForDate 同日重写），含当日值的环比在一天内多次扫描间不稳定；前一快照日已封版，分母稳定。序列有缺口时与上一有值日环比（缺日 ≠ 骤变 0）。
  - **分子含当日（大獭裁决保留，审视发现 3）**：当前日 = 快照序列最新日（含当日）——score_jump 语义是骤变报警，当日骤变当天就该报不等次日；代价是一天内多次扫描告警可能不稳定，取舍为报警偏向灵敏。分母 = 前一封版日，稳定性优先。
  - **缺口填槽分两层（审视发现 1 修复）**：①日期级缺口——快照序列无某日任何行时，锚点自然落在上一有值日（dates 只含有行日期）；②指标级缺口——锚点日缺某维度行（如 D5 无活跃链 null 不落行）时，该指标回溯到自己的上一有值日环比，不再整维度静默跳过。回溯发生时 evidence 附「基日 X 缺口回溯」、detail.gapFilledKeys 留痕实际比较区间。
  - **检测器异常留痕（审视发现 2 修复）**：scoreHistorySource 异常经 DetectOptions.onDetectError 回调留痕（worker 装配接 logger.warn），不再静默吞——否则 DB 故障会让 score_jump 长期无信号且无人知晓。纯函数层不依赖日志端口，回调注入保持可测性。
- **score_jump 作为检测器而非快照旁路的理由**：issue 原文「消费者=每日检查任务自动深挖」——每日任务消费 open 信号流，报警必须出现在 signals 表里，否则要另开一条取数路径。
- **detectSignals 签名变 async**：score_jump 需读快照端口（`scoreHistorySource` 注入，纯函数层不直接依赖 repository）。端口未注入时跳过检测（CLI/测试向后兼容），抛异常时 catch 降级为空（传感器分离）。其余检测器仍是纯同步函数。
- **behavior_defect 窗口语义**：createdAt ≥ now-7d 闭区间（与 bug_recurrence 的 [start, now] 边界语义一致）；证据含窗口天数 + 最近发生日期；按窗口内次数降序输出（聚类优先处置）。
- **半衰期趋势判定**：bugfix 日期序列 → 相邻间隔序列 → 前后半窗口均值对比，相对变化 >±20% 判 shortening/lengthening；<4 个 bugfix 报 insufficient（半分样本无统计意义）；前半零间隔（同日连环修）单独处理防除零。
- **僵尸链阶梯语义**：evidence 文案追加档位（30-59 黄 / 60-89 红 / ≥90 建议归档），分档依据 = zombie 判定用的滞留天数（有 commit 链用 daysSinceLastCommit，doc-only 链用 createdAt 间隔）。不动 chain-builder 状态机——阶梯是处置语义不是状态语义。

### 数据契约

- **score_jump detail**（evidence_detail JSON，kind=`score_jump_snapshots`）：previousDate / currentDate / previousValues / currentValues（环比分子分母留痕）+ gapFilledKeys（审视修复：指标级缺口回溯留痕，实际比较区间偏离信号级锚点的指标→该指标自己的前后日；无填槽时缺省）。previousValues/currentValues 仅含触发阈值的维度（未触发维度不进证据，与旧版含全维度不同——只留與告警相关的分子分母）。
- **trend 快照行**：metricType=`trend`、metricKey=`bugfix_interval`、metricValue=平均间隔天数（样本不足 0）、metadata={trend, firstHalfAvgDays, secondHalfAvgDays, bugfixCount}。worker 每轮扫描与 overview 行同日写入（sparkline 数据源从此连续）。
- **repository 新查询**：`findByMetricTypeSince(metricType, sinceDate)`——score_jump 数据源，日期降序（取最近两日依赖此序）。

### 与 #647 PR2 / #652 口径断层的边界

- 本 PR 只铺数据：score_jump 信号落 signals 表 + trend 行落 health_snapshots。UI 消费（PR2）不在范围。
- overview 的 critical 计数口径（#652 方案甲：low 不计入）涉及 rhi-controller 聚合——score_jump severity=warning，与该口径无交集。

## 变更清单

| 文件 | 改动 |
|---|---|
| src/usecases/health/detect-signals.ts | detectSignals 变 async；detectScoreJump 新增（含 detail/降级/端口注入）；detectBehaviorDefect 窗口化 + 排序；zombieLadderLabel 阶梯文案 |
| src/usecases/health/fix-halflife.ts | 新文件：computeFixInterval 纯函数 + buildFixIntervalRow |
| src/usecases/health/signal-registry.ts | score_jump 注册（9 类）；注释更新 |
| src/usecases/health/rhi-scan-worker.ts | scanOnce await detectSignals；persistSnapshot 追加 trend 行（buildTrendRow 私有方法）；options 增 scoreHistorySource |
| src/usecases/health/health-snapshot-repository.ts | findByMetricTypeSince 查询方法 |
| src/app.ts | 装配 scoreHistorySource（health_index 行读取，lookback+1 天 since） |
| src/interface-adapters/http/controllers/rhi-controller.ts | SIGNAL_TYPE_LABELS 补 score_jump 中文标签 |

## 测试

### 新增/更新用例

- **behavior_defect 窗口化**（detect-signals.test.ts）：窗口内 ≥3 触发（证据含窗口天数/最近日期）；**恰 7 天边界含、8 天边界排除**；12 天前 2 次 + 窗口内 2 次不触发（锁定旧全量聚合行为已消除）；多类型按次数降序；空窗口不触发。
- **score_jump**：单日 Δ=-20 触发 + detail 留痕（前日值 80 / 今日 60）；上行 +15 同样触发（|Δ| 对称）；**恰 |Δ|=10 触发 / 9.9 不触发**；单日快照不触发（冷启动）；缺日序列与上一有值日环比；**日期级缺口真骤变触发（验证与有值日而非空日比较）**；**指标级缺口填槽（D5 锚点日缺行回溯到自己的上一有值日，evidence 带「基日 X 缺口回溯」）**；**当日缺该维度行不比（无分子不误触发）**；数据源异常降级空；**异常经 onDetectError 回调留痕（不静默吞）**；未注入端口跳过。
- **僵尸链阶梯**：35/65/95 天分别落黄/红/建议归档档；**恰 60 天整=红档（>=）、59 天=黄档**；stalled 态不带档位文案（阶梯只作用 zombie）。
- **修复半衰期**（fix-halflife.test.ts）：shortening/lengthening/stable 三态；2-3 个 bugfix insufficient；空输入/单点 null；无序输入自动排序；同日连环修（前半零间隔）lengthening；Date 对象与 ISO 字符串同结果；trend 行 metadata 契约 + 样本不足 metricValue=0。
- **worker 集成**：snapshotSink 行数 18→19 断言更新 + trend 行存在性/同源 bugfixCount 断言。
- **repository**：findByMetricTypeSince 类型过滤 + since 边界含 + 降序。

### 自检记录（2026-09-01，含审视修复后复跑）

- `npx vitest run`：**195 files / 2459 tests 全部通过**（初版 26 用例 + 审视修复新增 4 用例）
- `npx tsc --noEmit`：零错误
- `npm run lint`：0 error / 5 warning——5 个 warning 全部 pre-existing（cost-output-collector.ts no-console ×2、web/conversation/index.tsx react-hooks ×3，均不在本次改动文件内；git diff 可证本次未触碰这三个文件）
- **pre-existing 声明证据**：`git diff --stat` 显示本次改动仅涉及 src/usecases/health/{detect-signals,rhi-scan-worker}.ts、tests/usecases/health/detect-signals.test.ts、docs/features/2026/09/01/F20260901sgn4-*.md——warning 所在文件零交集

### 审视修复记录（2026-09-01，检视獭-656 报告 + 大獭裁决）

| 发现 | 裁决 | 处置 |
|---|---|---|
| 严重 1：缺口填槽语义未被测试验证（实现固定取 dates[1]，指标级缺口整维度跳过） | 修 | 指标级跳空回溯重写 + 4 个新用例：日期级缺口真骤变触发（验证「真的在比较」）、指标级缺口填槽（D5 锚点日缺行回溯）、当日缺维度不比、异常留痕回调 |
| 建议 2：catch 静默吞异常无留痕 | 修 | DetectOptions.onDetectError 回调，worker 装配接 logger.warn（纯函数层不引日志端口）|
| 建议 3：分子含当日 vs 「前日封版」意图冲突 | 大獭拍板行为保留，文档补理由 | 本文档「关键设计决策」段已补「分子含当日」条目 |
| 建议 4：behavior_defect 窗口边界覆盖偏薄 | 立另案 | #660 跟踪，不在本 PR |

### 最简实现检查

已过最简检查：四项改动未引入新依赖、新表、新迁移——score_jump 复用 signals 表既有列（evidence_detail 存 detail JSON），半衰期复用 health_snapshots 行模型（trend 类型），阶梯纯文案函数。behavior_defect 窗口化在原函数内加过滤参数而非新检测器（合议 §1.2 明确反对重复发明）。

## 验收对照（issue #645）

| 验收项 | 状态 |
|---|---|
| 各检测器/指标有单测覆盖（含边界：空窗口、恰好阈值） | ✅ 边界用例：7 天窗口恰含/恰排除、\|Δ\|=10 恰触发/9.9 不触发、60 天阶梯恰界 |
| 半衰期趋势可从 snapshot 历史算出 | ✅ trend/bugfix_interval 行每轮扫描落库，findByMetricKey/findByMetricTypeSince 可取序列 |
