---
id: F20260901rhdet
title: 零成本检测器与指标四件套（环比骤变、行为缺陷窗口化、修复半衰期、僵尸链阶梯）
doc_type: feature
summary: |
  Issue #645 零成本检测器与指标四件套（合议定稿 Issue B 分期）：①环比骤变检测
  （snapshot_shift 信号，五维/综合分单日 |Δ|≥10 报警，null 维度跳过语义）；②behavior_defect
  窗口化升级（全量聚合 → 7 天窗口 ≥3 次，聚合按时间排序，独立阈值参数）；③修复半衰期
  派生指标（bugfix 间隔中位数落 fix_interval 快照行，#647 sparkline 可消费）；④僵尸链阶梯
  （30 黄/60 红/90 归档三档 severity/evidence/action 分级）。零 LLM、零新依赖、零 schema 变更。
  与 #644（PR #650）无代码交集。

causal_links:
  from:
    - F20260824rhib

status: development
change_type: feature
tags: [health, signals, detectors, metrics, observability]
modules:
  - src/usecases/health/signal-registry.ts
  - src/usecases/health/snapshot-shift.ts
  - src/usecases/health/bugfix-metrics.ts
  - src/usecases/health/detect-signals.ts
  - src/usecases/health/rhi-scan-worker.ts
  - src/usecases/health/snapshot-rows.ts
  - tests/usecases/health/snapshot-shift.test.ts
  - tests/usecases/health/bugfix-metrics.test.ts
  - tests/usecases/health/rhi-scan-worker-shift.test.ts
capability_test: "n/a: 纯确定性代码（A 类），无 LLM 参与行为"
created_at: 2026-09-01T13:30:00+08:00
created_in_conversation: 7c6e78b5-6fdc-462e-9383-4d96cf95dcd7
---

# F20260901rhdet: 零成本检测器与指标（issue #645）

## 背景与需求

合议定稿（review-lunheng.md，Issue B 分期）确定的四项零成本检测器/指标：

1. **环比骤变**：五维/综合健康分单日 |Δ|≥10 报警，消费者=每日检查任务自动深挖当日快照 diff
2. **behavior_defect 窗口化升级**（非新造检测器，合议 §1.2 裁定）：detect-signals.ts 原 detectBehaviorDefect 全量聚合无窗口 → 加 7 天窗口 + 聚合排序
3. **修复半衰期**（派生指标非检测器，合议 §1.3 裁定）：bugfix 间隔在缩短还是拉长，落 snapshot 供 sparkline/热点条（#647）消费
4. **僵尸链阶梯**：zombie 30 天黄 / 60 天红 / 90 天建议归档

背景数据：healing 库 degenerate 57 次/12 天是全库最高频模式，窗口化升级后第一天就该报警——这是本项的存在意义（窗口化把「历史遗留」与「最近在恶化」区分开）。

**边界声明**：与 #644（PR #650，已合入）是**消费关系而非修改关系**——本 issue 未动 signal-repository 的 upsert/schema；不做总览/信号 UI（#647）、链泳道（#649）、状态机推进器（#646）、合并后修复密度（PR2 域）。

## 方案设计

### ① 环比骤变（snapshot_shift）

- **信号注册**：SIGNAL_REGISTRY 新类型 `snapshot_shift`（warning），triggerRule「五维/综合健康分单日 |Δ|≥10」
- **检测模块**：新文件 `snapshot-shift.ts` 纯函数
  - `diffHealthIndex(previous, current, threshold)`：相邻两日 health_index 快照行 diff，|Δ|≥10 的维度进 shifts
  - `buildSnapshotShiftEvidence()`：evidence 带维度中文名、前后值、带符号 Δ（如「交付活力 80→68（Δ-12）」），跳过的 null 维度附原因
- **null 维度语义**：health-score「无数据维度 score=null 不参与加权」的 diff 对齐——null 跳过不算 Δ，在 evidence 的 skipped 中注明（如「D3（前一日无数据）」），避免把「没数据」误报成「骤变」
- **接线（rhi-scan-worker）**：新 option `prevDayHealthIndexSource`（昨日 health_index 行数据源，注入式，同 healingSource 先例——worker 不重复持有 repository 细节）+ `snapshotShiftThreshold`（默认 10）。scanOnce 在步骤 5.5 检测：昨日源 vs 今日缓存，信号并入主管道统一落库/记忆/唤醒
- **今日侧口径**：persistSnapshot 构建 health_index 行时缓存为 `lastHealthIndexRows`，与落库行同源同口径。当日首轮扫描缓存为空 → 跳过，次轮（≤1h 后）生效——日粒度信号，一小时延迟可接受
- **auto-resolve 语义**：信号走主管道，同日重复触发 upsert 累加，次日不再触发时由 pipeline 的 resolveStaleSignals 自动关闭（骤变是瞬时事件，与「问题消失信号自关」语义一致）

### ② behavior_defect 窗口化

- `DetectOptions` 新增 `behaviorWindowDays`（默认 7）+ `behaviorThreshold`（默认 3）——**独立于 recurrenceThreshold**（两检测器阈值语义不同源，共用参数会在调参时互相牵连）
- detectBehaviorDefect 签名加 `now` 参数，窗口过滤 `createdAt ≥ now-7d`，聚合按时间升序
- evidence 带窗口与时间范围：`errorType=X 7 天内复发 3 次（阈值 3，2026-08-19 ~ 2026-08-24）`
- 注册表 triggerRule 同步更新为「同一 errorType healing event 7 天窗口内 ≥3 次」

### ③ 修复半衰期（fix_interval）

- **新文件 `bugfix-metrics.ts`** 纯函数：
  - `computeFixInterval(parsed, dates, now, windowDays=30)`：滚动窗口内相邻 bugfix commit 间隔的**中位数**（天）
  - `buildFixIntervalRow()`：构建 `metric_type=fix_interval, metric_key=bugfix_median_interval_days` 快照行，metadata 带 `{windowDays, bugfixCount, intervalCount, stat:"median"}`（窗口参数入库=时间序列回放可算，验收达成）
- **口径选择：中位数**（实查 2026-09-01 main 60 天）：42 个 bugfix / 8 个活跃日 / 爆发式提交，间隔分布右偏严重（中位 0.06d，均值 0.18d，max 1.53d，p90 0.69d）。均值会被爆发日内的分钟级间隔拉低，掩盖「平静期拉长」的真实趋势，故取中位数
- **窗口默认 30 天**：实查 7/14/30 天窗口的每日快照可算率完全相同（9/30 天可算），更短窗口无额外收益；30 天与信号窗口口径一致
- **接线（rhi-scan-worker.persistSnapshot）**：fix_interval 行追加在 health_index 行后；窗口复用 metricsWindowDays（60 天，趋势口径稳定）；计算失败仅 warn 日志（传感器分离，不阻断主路）
- **null 语义**：窗口内 bugfix < 2 时 intervalDays=null，仍落行（metricValue=0 + metadata.intervalCount=0）——时间序列不断点，消费方可区分「算不出」（无间隔）与「间隔为 0」（同刻爆发）

### ④ 僵尸链阶梯

- detect-signals.ts 的 detectChainStall 拆三函数：detectChainStall（过滤+分派）、stalledSignal（#644 规则甲语义原样保留）、zombieLadderSignal（阶梯）
- `zombieLadder(days)` 分档（边界口径 [30,60) / [60,90) / ≥90）：
  - **黄档 30-60 天**：severity 降为 **warning**，action=「观察或链复盘：确认是暂停还是废弃」
  - **红档 60-90 天**：critical，action=「强制链复盘：90 天内归档或重启，否则进入归档档」
  - **归档档 ≥90 天**：critical，evidence 含「归档」与天数，action=「建议归档：创建归档 issue 并将 F-doc status 置为 archived（N 天无活动，每日任务可自动拆 issue）」
- **消费侧衔接**：每日任务拿 severity 分档即可路由（warning→观察 / critical→复盘 / 归档档→拆归档 issue）；每日任务自动拆归档 issue 的编排不在本 issue 范围，但 evidence/suggestedAction 已把天数、归档动作、status 目标值说到位
- stalled 分支不受影响：仍注册表默认 critical + 规则甲置信

## 影响范围

- **改动文件**：signal-registry.ts（+snapshot_shift 类型与定义、behavior_defect triggerRule 更新）、detect-signals.ts（behavior_defect 窗口化 + 僵尸阶梯）、rhi-scan-worker.ts（环比骤变接线 + fix_interval 行 + persistSnapshot 拆 appendDerivedRows）、snapshot-rows.ts（头注释更新）
- **新文件**：snapshot-shift.ts、bugfix-metrics.ts 及三个测试文件
- **schema**：零变更（health_snapshots 的 metric_type/metadata 是开放字段）
- **既有行为变更点**：behavior_defect 触发口径收紧（全量→7 天窗口）；zombie 30-60 天链 severity 从 critical 降为 warning（阶梯语义，属预期变更）；worker metricsStored 每轮 +1 行（fix_interval）

## 取舍

- **中位数 vs 均值**：见上，实查数据右偏严重，中位数抗爆发日干扰
- **环比骤变注入式数据源 vs worker 直查 DB**：注入式（同 healingSource 先例），worker 不持有 HealthSnapshotRepository 细节；CLI/每日任务也可直接调 diffHealthIndex 复用同一口径
- **今日缓存 vs 快照行回读**：缓存 lastHealthIndexRows 而非 sink 回读，避免 worker 反向依赖 sink 实现细节；代价是首轮扫描跳过（≤1h 延迟，日粒度信号可接受）
- **behaviorThreshold 独立参数 vs 复用 recurrenceThreshold**：独立。原实现两者共用 recurrenceThreshold 是隐式耦合，调 bug_recurrence 阈值会连带 behavior_defect，参数分离后各自可调
- **僵尸黄档降级为 warning 的取舍**：30-60 天僵尸从 critical 降 warning 会降低面板 D5 信号压力分的扣减（critical 密度 ×40 → warning ×30）——这是阶梯的预期语义（刚 30 天的链不该和 90 天的重罪同权重），不是副作用

## 验证

### 最简实现检查（必答）

逐项过「仓库已有实现 → stdlib → 已装依赖 → 新代码」阶梯：

1. **环比骤变**：仓库无现成快照 diff 实现（health-score 只有单日评分与 7 天趋势判定 judgeTrend，无相邻两日 diff）→ 新写纯函数 snapshot-shift.ts（~100 行，无依赖）。判定逻辑与 SIGNAL_REGISTRY 消费链放在 worker 现有 scanOnce 管道内（复用 pipeline 落库/记忆/唤醒），未另起检测器框架
2. **behavior_defect 窗口化**：直接升级现有 detectBehaviorDefect（合议裁定不新造检测器）——改函数签名 + 窗口过滤 + 排序，未新增文件
3. **修复半衰期**：MetricsCalculator 已有 bugfixCount 聚合但无间隔时序计算；间隔中位数无法从已有聚合派生（需要时间序列）→ 新写 bugfix-metrics.ts（~100 行，零依赖，Date/stdlib only）。挂 persistSnapshot 现有流程 + 现有 snapshotSink 落库，未另起采集/存储管道
4. **僵尸阶梯**：纯 severity/evidence/action 分档，在现有 detectChainStall 内拆函数实现，无新文件

**结论**：已过最简检查。四项零新依赖、零 schema 变更，全部挂在既有管道（scanOnce/persistSnapshot/pipeline）上。

### 测试结果（自检，实现者自报）

- 全量：**197 文件 / 2458 测试全绿**（npm test，含 pretest lint）
- 新增测试：snapshot-shift.test.ts（9 用例：阈值边界 |Δ|=10 触发/9 不触发、null 维度双侧跳过、前一日缺维度、多维度同时骤变、evidence 格式）；bugfix-metrics.test.ts（9 用例：空窗口 null、单间隔、非 bugfix 不参与、乱序、奇偶中位数、窗口滑动、metadata 回放）；detect-signals.test.ts 增 behavior_defect 窗口化 4 用例（窗口外事件不抬计数、全量超阈但窗口内不足不触发、恰好 3 次边界、参数可调）+ 僵尸阶梯 5 用例（30/35/60/95 天分档边界 + stalled 不受影响）；rhi-scan-worker-shift.test.ts（2 用例：端到端骤变信号 + 未注入/null/异常三路降级）；worker 主测试 metricsStored 18→19 + fix_interval 行断言
- tsc：0 错误
- eslint：0 error（cost-output-collector 2 个 no-console warning 与 web 3 个 hooks warning 均为存量）

### 发现与修复的开发过程问题

- 测试 fixture 的 FID 需符合 commit-parser 字符集规则（`[a-kmnp-z][2-9a-kmnp-z]{3,9}` 排除 l/0）——首版 FID `yell/stal/bt30` 含非法字符致解析失败，测试静默测成了 doc-only 链。已改 warn/bt33/staz 并在本文档留痕，后续写测试者注意
- lint 的 max-lines-per-function（220 行）约束测试文件：超限的测试拆独立 describe/文件（rhi-scan-worker-shift.test.ts）

## 下一步

- 大獭编排对抗审视（步骤 10，异模型检视獭）
- 消费侧（不在本 issue）：每日检查任务接 prevDayHealthIndexSource + diffHealthIndex 深挖骤变；按僵尸阶梯 severity 自动拆归档 issue；#647 sparkline 读 fix_interval 行
