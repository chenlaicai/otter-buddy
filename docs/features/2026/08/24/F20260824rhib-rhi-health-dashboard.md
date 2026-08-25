---
id: F20260824rhib
title: rhi-health-dashboard
doc_type: feature
status: development
change_type: new_feature
created_in_conversation: 9e709aca-dd74-42fa-9fe1-4e7bbaf24bdb

summary: |
  RHI（Repo Health Intelligence）：基于 git PR 数据的系统健康监控面板。
  实现从数据采集→指标计算→信号检测→可视化→自进化反哺的完整闭环。
  核心价值：衡量 agent 系统的自我修正能力，双通道输出（人看图表，agent 读 JSON）。
---

# RHI：Repo Health Intelligence — 系统健康监控面板

## 背景

搭档原话（意图锚）：
> "代码仓是以PR合入来持续前行的，那么，系统能否有一个监控面板，能看到本系统的健康状态。比如 new feature/bugfix 的数量、某一个 bug 反复出现、某一个特性链多次仍未结束。这些固定的软件系统能做到的监控和统计，既能给用户看，也能反哺到系统本身来进行深入分析和作为评测依据。"

背景数据（git 考古实测，259 commits / 47 天，2026-07-08 → 2026-08-24）：
- BugFix 占全部合入的 **27.8%**（72/259，每 4 个 PR 就有 1 个在修东西）
- agent 模块 BugFix 26/72 = **36.1%**（按 module 标签）
- `conversation/index.tsx` 被 BugFix 触碰 **19 次**、`agent-invoker.ts` 18 次
- 239 份 F 文档存在，但链追踪相关字段覆盖率低：`from:` 仅 8/239（3.3%）、`supersedes:` 2/239（0.8%）、`intent:` 0/239（#386 后新增文档才开始积累）
- commit message 带 F 前缀 249/259（96.1%），严格三段格式 182/259（70.3%）；不合规样本包括 init/Revert/R 文档头等需显式处理
- 「严格三段格式」口径（PR #417 对抗审视后修订）：模块段允许小写字母与连字符（`agent-runtime`、`api-contract` 等连字符模块名已广泛使用且有语义），由 Issue #1 CommitParser 正则定义

## 目标

T1: 建立基于 git PR 数据的系统健康指标体系（L1 基础计数 → L2 趋势 → L3 异常信号）
T2: 实现特性链追踪能力（F 文档生命周期状态机：active/stalled/regressed/zombie/orphan）
T3: 提供双通道输出——人类可读的 Web 面板 + agent 可消费的 JSON 报告
T4: 建立信号→改进的反馈闭环（信号驱动诊断任务，反哺 agent 自进化）
T5: 与 PR 评估体系（#386 introducedByPr/TraceContext.prId）天然咬合，成为其第一消费者

## 非目标

- ❌ 实时流式处理（小时级足够，仓库"心率"没那么快）
- ❌ LLM 参与指标计算（L2/L3 全确定性，保证可复现性）
- ❌ 自动修复（面板只触发信号，处置仍走 skill chain + 搭档终审）
- ❌ GitHub API 深度集成（MVP 阶段 git log 已够用）
- ❌ 预测性分析（先做描述性，预测是 v2 话题）

## 方案设计

### 核心定位

**不是 Dashboard（被动展示），是 Intelligence（主动产出可行动洞察）。**

传统监控回答"系统跑得怎么样"，RHI 回答"这个由 agent 写的系统，正在往哪里去"。独特价值：
- 衡量的对象是 **自我修正能力**（bug 复现率、意图兑现率、修复半衰期、教训复用率）
- 读者有两个：图表给人看，JSON 给 agent 读
- 仓库历史本身就是评测集（259 个 commit + 239 份 F 文档，但链追踪相关字段需回填或声明冷启动期）

### 架构分层

```
┌─────────────────────────────────────────────────────────────┐
│  L4 反馈层 Feedback                                          │
│  ├─ 人类通道：Web 面板 + 自然语言日报                        │
│  └─ Agent 通道：signal → 记忆系统 fact + 定时任务唤醒        │
├─────────────────────────────────────────────────────────────┤
│  L3 信号层 Signal Engine（规则引擎，阈值可配）               │
│  └─ 8 类信号（详见信号注册表）                              │
├─────────────────────────────────────────────────────────────┤
│  L2 指标层 Metrics Engine（全确定性，无 LLM）                │
│  ├─ 流量指标：PR 速率、feature/bugfix 比、模块活跃度        │
│  ├─ 质量指标：bugfix 占比、文件复发率、hotspot 指数         │
│  ├─ 链指标：链长度、停滞天数、回退计数                      │
│  └─ Agent 指标：空转检测、审视失效率、记忆命中率            │
├─────────────────────────────────────────────────────────────┤
│  L1 采集层 Ingestion（定时，复用 scheduler-service）          │
│  ├─ GitLogCollector: child_process git log（只读）           │
│  ├─ FeatureDocCollector: 复用 sync_docs 解析器              │
│  ├─ MetricsCollector: 读 data/metrics/*.jsonl               │
│  ├─ MessagesCollector: 读 messages 表（zombie 判定 FID 出现次数）  │
│  └─ HealingCollector: 读 healing_events 表                   │
├─────────────────────────────────────────────────────────────┤
│  存储层 Storage                                              │
│  ├─ health_snapshots 表（SQLite，定时固化指标）              │
│  └─ signals 表（SQLite，状态流转）                           │
└─────────────────────────────────────────────────────────────┘
```

### 核心数据模型

**实体关系**：
```
FeatureDoc (F文档)                    PullRequest
├─ id: F20260824ax376  ◄──────────┐  ├─ prNumber: 386
├─ change_type                     │  ├─ featureId (从commit msg解析)
├─ status: active                  │  ├─ module / changeType
├─ intent.problem ★                │  ├─ mergedAt / filesChanged
├─ intent.verify_by ★              │  └─ healingEvents[] ──→ HealingEvent
├─ from[]: 特性链上游              │      ├─ errorType
└─ supersedes[]                    │      └─ introducedByPr ★
                                   │
        ▼                          ▼
        FeatureChain (派生)        Signal (派生)
        ├─ state: active/stalled/regressed/zombie/orphan
        ├─ prs[] / daysSinceLastActivity
        └─ touchFiles[]
```

**特性链状态机**：
| 状态 | 判定规则 |
|------|----------|
| active | status∈{draft,proposed,design,development} ∧ 最后 commit ≤14 天 |
| stalled | status∈{draft,proposed,design,development} ∧ 最后 commit >14 天 ∧ 无 verify_by 达标 |
| regressed | 链上最新 N 个 PR 是 BugFix 且触碰链内 feature 引入的文件 |
| zombie | status∈{draft,proposed,design,development} ∧ 30 天无 commit ∧ 近 30 天对话消息中 FID 出现次数 = 0（数据源：MessagesCollector 直查 messages 表） |
| orphan | commit 的 FID 在 docs/features 找不到文档 |

### 指标体系（四层金字塔）

**L1 基础计数**：
- PR 吞吐（日/周合入数、按 change_type 分布）
- 模块分布热区
- 合入时延（PR 创建→合入）
- 文档覆盖率

**L2 趋势结构**：
- 增速-修复比趋势线
- 模块热区漂移
- 特性链生命体征（长度/存活时长/距 effect_window 倒计时）
- 修复回归带（按 introducedByPr 聚合）

**L3 异常信号**（8 类，详见信号注册表）：

**信号注册表**（统一信号定义，Issue #6 以此为准）：

| 信号 ID | 名称 | 触发规则 | 数据依赖 | 严重程度 | 动作 |
|---------|------|----------|----------|----------|------|
| bug_recurrence | bug 反复出现 | 同模块同文件 bugfix ≥3 次/30天 | GitLogCollector + CommitParser | 🔴 critical | 强制根因分析 |
| chain_stall | 特性链滞留 | F-doc status∈{draft,proposed,design,development} 且 14 天无 commit | GitLogCollector + FeatureDocCollector | 🔴 critical | 链复盘 |
| hotspot | 热点文件 | 文件修改次数 > P95 或固定阈值 | GitLogCollector + CommitParser | 🟡 warning | 架构审视 |
| behavior_defect | 行为缺陷 | 同一 errorType healing event 复发 | HealingCollector | 🟡 warning | prompt/skill 修订 |
| eval_regression | 效果回退 | verify_by 达标后又恶化 | FeatureDocCollector + GitLogCollector | 🟡 warning | 触发回验 |
| intent_drop | 意图兑现率下降 | 近 7 天 ❌+⚠️ 占比 > 阈值 | FeatureDocCollector | 🟡 warning | 触发回验 |
| hotspot_imbalance | 热区失衡 | bugfix:feature >2 持续 2 周 | GitLogCollector + CommitParser | 🟡 warning | 重构立项 |
| review_debt | 审视债务 | 未走对抗审视 PR 占比上升 | GitLogCollector + CommitParser | 🟡 warning | 提醒流程 |

**L4 自进化信号**（最有创新性）：
- 教训复用率：bugfix PR 中引用 R 文档/历史教训的比例
- 重复踩坑率：新 bugfix 与历史已修复问题相似度 > 阈值的占比
- 能力沉淀率：bugfix → skill/规则/文档的转化率
- 同型问题复发间隔：间隔变长=进化中，不变=打地鼠

**L4 实现约束**：
- MVP 阶段：纯规则/关键词匹配（如 grep R 文档引用、文件路径匹配）
- v2 阶段：引入 embedding 语义相似度（需评估 LLM 成本与准确性权衡）
- 设计原则：L4 指标不参与自动化决策，仅作为人工分析参考

### 存储层 Schema 设计

**health_snapshots 表**：
```sql
CREATE TABLE health_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT NOT NULL,
  metric_type TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  metric_value REAL NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_snapshots_date_type ON health_snapshots(snapshot_date, metric_type);
CREATE INDEX idx_snapshots_key ON health_snapshots(metric_key);
```

**signals 表**：
```sql
CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  feature_id TEXT,
  file_path TEXT,
  evidence TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  occurrences INTEGER DEFAULT 1,
  status TEXT DEFAULT 'open',
  suggested_action TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX idx_signals_type ON signals(signal_type);
CREATE INDEX idx_signals_status ON signals(status);
CREATE INDEX idx_signals_feature ON signals(feature_id);
```

**数据保留策略**：
- health_snapshots：保留 90 天，超过后归档到 JSONL
- signals：已解决信号保留 30 天后归档

### Agent 特有四层观测

| 层级 | 维度 | 数据来源 | 传统监控覆盖 |
|------|------|----------|-------------|
| L1 运行时行为 | token/重试/guard abort/链深度 | AgentMetrics（已有） | ✅ |
| L2 产出质量 | bug 复发率、热点分布 | git 数据 | 部分 |
| L3 决策模式 | 空转检测、审视失效、退化模式 | messages + tool 调用 + AgentMetrics | ❌ |
| L4 元认知 | 记忆命中率、自愈循环效率 | 记忆系统 + healing_events | ❌ |

### 自进化反馈闭环

```
Signal 产生
  → 1. 落库（signals 表）
  → 2. create_linked_resource(fact) 写入记忆系统
  → 3. 超过 critical 阈值 → create_scheduled_task 唤醒大獭
  → 4. 处置结果关联 signal ID → 关闭 signal
  → 5. 关闭时验证：信号源指标是否改善
```

**哲学原则**：面板是"传感器阵列"不是"自动驾驶"。信号只做触发器，处置仍走 skill chain + 异体审视 + 搭档终审。**自进化不是自修改，是数据驱动的、仍由搭档终审的改进流程。**

## 影响范围

- 新增模块：`src/usecases/health/`（采集/指标/信号/链构建）
- 新增存储：SQLite health_snapshots + signals 表
- 新增页面：`web/src/pages/health/`
- 新增 API：`/api/health/*`
- 复用：scheduler-service、prom-client Registry、sync_docs 解析器、记忆系统
- 最小侵入：修改现有 health-controller.ts（已存在，承载 memory 健康端点）+ server.ts 注册路由 + schema.ts 新增表

## 风险与约束

| 风险 | 等级 | 对策 |
|------|------|------|
| Goodhart 反噬 | 高 | 指标只作信号不作 KPI；类型标注与 diff 交叉校验 |
| 语义聚类误报 | 中 | MVP 用窄门规则（同模块同文件），v2 再引入语义聚类 |
| 样本量小 | 中 | L3 用简单阈值规则（固定次数/分位数）而非 z-score；趋势判断最小窗口 2 周 |
| 自指风险 | 低 | 面板自身 PR 也进面板（免费的对照实验） |
| 指标通货膨胀 | 中 | 严格分阶段，每阶段验证"有没有人/agent 真的消费" |
| 数据冷启动 | 高 | 存量字段覆盖率低（from 3.3%，intent 0%），只统计增量 + 显式声明冷启动起点 |
| introducedByPr 数据质量 | 中 | agent 自报可能不填或填错，需交叉校验（PR diff + commit message） |

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| 指标计算是否用 LLM | 不用，全确定性 | LLM 做模式识别 | 监控可信度取决于可复现性 |
| 信号→动作是否全自动 | 半自动（信号触发，处置走流程） | 全自动修复 | A2 原则 + 异体审视不可跳过 |
| 存储选型 | SQLite 物化视图 | JSONL 范围查询 | 需要按维度范围查询，SQLite 合适 |
| 命名 | RHI (Repo Health Intelligence) | Dashboard | 不是被动展示，是主动产出洞察 |
| hotspot 统计方法 | MVP 固定阈值/分位数 | z-score | 样本量小（48 天），z-score 不稳定 |
| bug 复发判定 | 同模块同文件（窄门） | 同语义（需 LLM） | 全确定性原则 |
| 阈值配置 | 复用 settings 模块 | 硬编码/环境变量 | 已有通用配置能力 |

## 验证

**阶段 0 验收标准**：
- 能复现实测数字（27.8% bugfix 率、top 热点文件、模块分布、agent 36.1%）
- CLI 报告输出 JSON + 可读文本
- 所有 259 个 commit 有确定分类（解析成功或显式 skip-with-reason）

**阶段 1 验收标准**：
- 按声明的窗口规则（30 天）实际触发的 recurrence 数（conversation/index.tsx 的 19 次是 48 天全期累计，窗口内触发数需实际计算）
- signal 正确写入记忆系统
- 特性链构建覆盖所有有 FID 的 commit（含无文档的 orphan 标记）

**阶段 2 验收标准**：
- 搭档每天看一眼能回答"系统这周健康吗"

**阶段 3 验收标准**：
- 至少一条 SYSTEM.md/skill 修订由面板信号驱动产生

## 改动范围

| 文件/目录 | 操作 | 说明 |
|-----------|------|------|
| src/usecases/health/ | 新增 | 采集/指标/信号/链构建核心模块 |
| src/frameworks/db/schema.ts | 修改 | 新增 health_snapshots + signals 表 + 索引 |
| src/frameworks/db/migration.ts | 修改 | 新增迁移 |
| web/src/pages/health/ | 新增 | 健康面板页面 |
| src/interface-adapters/http/controllers/health-controller.ts | 修改 | 新增 RHI 端点（已有 memory 健康端点） |
| src/bootstrap/server.ts | 修改 | 注册 RHI 路由 |
| src/usecases/settings/ | 复用 | 阈值配置读取 |
| tests/usecases/health/ | 新增 | 单元测试 |

---

## 实现步骤拆分（Issues）

### Phase 0: MVP（1-2 个 PR）
**目标**：证明数据管道通，产出第一份健康报告

**Issue #1**: 数据采集器实现
- GitLogCollector: child_process git log 只读采集
- FeatureDocCollector: 复用 sync_docs 解析器
- CommitParser: 正则提取 FID/module/changeType/PR号
- 不合规分支处理：Revert/init/缺段/R 文档头 → 显式 skip-with-reason
- 验收：259 个 commit 全部有确定分类（解析成功或显式 skip-with-reason）

**Issue #2**: 核心指标计算
- bugfix 比率（当前 27.8%）
- 模块热区排行（agent 67 / skills 25 / web 22）
- 文件热点 TOP N（conversation/index.tsx 19 次）
- 验收：CLI 输出能复现实测数字

**Issue #3**: SQLite 存储层
- health_snapshots 表设计 + 迁移
- 验收：指标正确持久化，支持时间范围查询

**Issue #4**: CLI 报告工具
- `pnpm health:report` 命令
- JSON + 可读文本双格式输出
- 验收：运行命令产出第一份健康报告

### Phase 1: 信号引擎（2-3 个 PR）
**目标**：8 类规则信号（详见信号注册表）+ 记忆通道

**Issue #5**: 特性链构建器
- ChainBuilder: 从 commit 中提取的 FID + 时间序 → FeatureChain（不依赖 frontmatter，因为存量覆盖率低）
- 四态判定（stalled/regressed/zombie/orphan）
- orphan 标记：commit 的 FID 在 docs/features 找不到文档
- 冷启动策略：只统计增量 + 显式声明冷启动起点
- 验收：能正确构建所有有 FID 的 commit 的特性链，orphan 被正确标记

**Issue #6**: 信号检测引擎
- detect-signals.ts: 8 类规则实现（以信号注册表为准）
- signals 表设计 + 迁移
- MVP 规则：同模块同文件 bugfix ≥3 次/30 天（窄门，不依赖语义聚类）
- 验收：按 30 天窗口规则实际触发的 recurrence 数

**Issue #7**: 记忆通道集成
- signal → create_linked_resource(fact)
- critical signal → create_scheduled_task 唤醒
- 验收：signal 正确写入记忆系统，可被 search_memory 检索

**Issue #8**: 定时采集调度
- 复用 scheduler-service
- 每小时增量 + 每日全量快照
- 验收：定时任务自动运行，指标持续更新

### Phase 2: Web 面板（2-3 个 PR）
**目标**：人类可读的健康面板

**Issue #9**: 后端 API
- /api/health/overview: 总览数据
- /api/health/chains: 特性链列表
- /api/health/signals: 信号列表
- 验收：API 正确返回数据

**Issue #10**: 前端页面
- Overview 视图：健康分 + 信号列表 + 趋势图
- Chains 视图：特性链看板（状态机视图）
- Agent 视图：agent 行为指标
- 验收：搭档每天看一眼能回答"系统健康吗"

**Issue #11**: 自然语言日报
- 每日/每周生成叙述性报告
- 集成到大獭每日摘要机制
- 验收：agent 可直接消费的叙述性报告

### Phase 3: 自进化闭环（持续）
**目标**：信号驱动改进

**Issue #12**: Agent 行为层指标
- 空转检测（工具调用序列无状态推进）
- 审视失效（对抗审视 pass 的 PR 后续 7 天内出 BugFix）
- 记忆命中率
- 验收：能检测到真实的行为缺陷模式

**Issue #13**: 信号→改进闭环
- 每类信号预绑定改进路径
- signal 关闭时的效果回验
- 验收：至少一条修订由面板信号驱动

**Issue #14**: 元监控
- 面板自身的健康指标
- 自指监控（面板 PR 也进面板）
- 验收：面板开发过程本身成为自进化能力的活体样本
