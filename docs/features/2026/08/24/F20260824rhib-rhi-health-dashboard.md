---
id: F20260824rhib
title: rhi-health-dashboard
doc_type: feature

summary: |
  RHI（Repo Health Intelligence）：基于 git PR 数据的系统健康监控面板。
  实现从数据采集→指标计算→信号检测→可视化→自进化反哺的完整闭环。
  核心价值：衡量 agent 系统的自我修正能力，双通道输出（人看图表，agent 读 JSON）。
---

# RHI：Repo Health Intelligence — 系统健康监控面板

## 背景

搭档原话（意图锚）：
> "代码仓是以PR合入来持续前行的，那么，系统能否有一个监控面板，能看到本系统的健康状态。比如 new feature/bugfix 的数量、某一个 bug 反复出现、某一个特性链多次仍未结束。这些固定的软件系统能做到的监控和统计，既能给用户看，也能反哺到系统本身来进行深入分析和作为评测依据。"

背景数据（git 考古实测，259 commits / 48 天）：
- BugFix 占全部合入的 **27.8%**（每 4 个 PR 就有 1 个在修东西）
- agent 模块吃掉全部修复的 **43%**
- `conversation/index.tsx` 被 BugFix 触碰 **19 次**、`agent-invoker.ts` 18 次
- 239 份 F 文档 frontmatter 已包含链追踪所需的全部关联数据
- commit message 100% 遵守 `[F文档ID][模块][类型]` 格式，数据提取成本趋近于零

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
- 仓库历史本身就是评测集（259 个结构化 commit + 239 份 F 文档）

### 架构分层

```
┌─────────────────────────────────────────────────────────────┐
│  L4 反馈层 Feedback                                          │
│  ├─ 人类通道：Web 面板 + 自然语言日报                        │
│  └─ Agent 通道：signal → 记忆系统 fact + 定时任务唤醒        │
├─────────────────────────────────────────────────────────────┤
│  L3 信号层 Signal Engine（规则引擎，阈值可配）               │
│  ├─ bug_recurrence: 同文件 BugFix ≥3次/30天                 │
│  ├─ chain_stall: F文档 active 且 14天无 commit              │
│  ├─ hotspot: 文件修改 z-score > 2                           │
│  ├─ behavior_defect: 同一 errorType healing event 复发      │
│  └─ eval_regression: verify_by 达标后又恶化                 │
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
| active | status=active ∧ 最后 commit ≤14 天 |
| stalled | status=active ∧ 最后 commit >14 天 ∧ 无 verify_by 达标 |
| regressed | 链上最新 N 个 PR 是 BugFix 且触碰链内 feature 引入的文件 |
| zombie | status=active ∧ 30 天无活动 ∧ 无人提及 |
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

**L3 异常信号**：
| 信号 | 触发规则 | 动作 |
|------|----------|------|
| 🔴 bug 反复出现 | 同模块同语义 bugfix ≥3 次 | 强制根因分析 |
| 🔴 特性链滞留 | 同一 F-doc 跨 PR ≥3 且超窗 | 链复盘 |
| 🟡 意图兑现率下降 | 近 7 天 ❌+⚠️ 占比 > 阈值 | 触发回验 |
| 🟡 热区失衡 | bugfix:feature >2 持续 2 周 | 重构立项 |
| 🟡 审视债务 | 未走对抗审视 PR 占比上升 | 提醒流程 |

**L4 自进化信号**（最有创新性）：
- 教训复用率：bugfix PR 中引用 R 文档/历史教训的比例
- 重复踩坑率：新 bugfix 与历史已修复问题相似度 > 阈值的占比
- 能力沉淀率：bugfix → skill/规则/文档的转化率
- 同型问题复发间隔：间隔变长=进化中，不变=打地鼠

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
- 不影响现有功能（纯新增，零侵入）

## 风险与约束

| 风险 | 等级 | 对策 |
|------|------|------|
| Goodhart 反噬 | 高 | 指标只作信号不作 KPI；类型标注与 diff 交叉校验 |
| 语义聚类误报 | 中 | 先规则窄门过滤，聚出的簇给搭档确认再触发动作 |
| 样本量小 | 中 | L3 用简单阈值规则而非 ML；趋势判断最小窗口 2 周 |
| 自指风险 | 低 | 面板自身 PR 也进面板（免费的对照实验） |
| 指标通货膨胀 | 中 | 严格分阶段，每阶段验证"有没有人/agent 真的消费" |

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| 指标计算是否用 LLM | 不用，全确定性 | LLM 做模式识别 | 监控可信度取决于可复现性 |
| 信号→动作是否全自动 | 半自动（信号触发，处置走流程） | 全自动修复 | A2 原则 + 异体审视不可跳过 |
| 存储选型 | SQLite 物化视图 | JSONL 范围查询 | 需要按维度范围查询，SQLite 合适 |
| 命名 | RHI (Repo Health Intelligence) | Dashboard | 不是被动展示，是主动产出洞察 |

## 验证

**阶段 0 验收标准**：
- 能复现实测数字（27.8% bugfix 率、top 热点文件、模块分布）
- CLI 报告输出 JSON + 可读文本

**阶段 1 验收标准**：
- conversation/index.tsx 的 19 次 BugFix 被自动标为 recurrence 信号
- signal 正确写入记忆系统

**阶段 2 验收标准**：
- 搭档每天看一眼能回答"系统这周健康吗"

**阶段 3 验收标准**：
- 至少一条 SYSTEM.md/skill 修订由面板信号驱动产生

## 改动范围

| 文件/目录 | 操作 | 说明 |
|-----------|------|------|
| src/usecases/health/ | 新增 | 采集/指标/信号/链构建核心模块 |
| src/frameworks/db/schema.ts | 修改 | 新增 health_snapshots + signals 表 |
| src/frameworks/db/migration.ts | 修改 | 新增迁移 |
| web/src/pages/health/ | 新增 | 健康面板页面 |
| src/interface-adapters/http/controllers/health-controller.ts | 新增 | /api/health/* 端点 |
| src/bootstrap/server.ts | 修改 | 注册 health 路由 |
| tests/usecases/health/ | 新增 | 单元测试 |

---

## 实现步骤拆分（Issues）

### Phase 0: MVP（1-2 个 PR）
**目标**：证明数据管道通，产出第一份健康报告

**Issue #1**: 数据采集器实现
- GitLogCollector: child_process git log 只读采集
- FeatureDocCollector: 复用 sync_docs 解析器
- CommitParser: 正则提取 FID/module/changeType/PR号
- 验收：能解析全部 259 个 commit，100% 成功率

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
**目标**：5 类规则信号 + 记忆通道

**Issue #5**: 特性链构建器
- ChainBuilder: from/supersedes + 时间序 → FeatureChain
- 四态判定（stalled/regressed/zombie/orphan）
- 验收：能正确构建 239 份 F 文档的特性链

**Issue #6**: 信号检测引擎
- detect-signals.ts: 5 类规则实现
- signals 表设计 + 迁移
- 验收：conversation/index.tsx 的 19 次 BugFix 被标为 recurrence

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
