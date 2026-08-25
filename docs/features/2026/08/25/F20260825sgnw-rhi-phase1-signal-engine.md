---
id: F20260825sgnw
title: RHI Phase 1 信号引擎实施
summary: |
  Epic #393 / Issues #398-#401 的 Phase 1 交付：特性链构建器（五态状态机
  active/stalled/regressed/zombie/orphan）、信号检测引擎（信号注册表单一真相源，
  MVP 实现 5/8 类，3 类因 intent 字段冷启动/数据源依赖挂起）、记忆通道
  （critical 信号经 StoreMemory 写入记忆系统可被 search_memory 检索 + 唤醒端口）、
  定时采集 worker（1h 周期全管道，start/stop 生命周期接入 app.ts dispose）。
change_type: feature
status: development
capability_test: "tests/usecases/health/chain-builder.test.ts"
created_in_conversation: 9e709aca-dd74-42fa-9fe1-4e7bbaf24bdb
---

# RHI Phase 1 信号引擎实施

母特性文档：[F20260824rhib](../08/24/F20260824rhib-rhi-health-dashboard.md)。Phase 0 实施记录：[F20260825hmvp](./F20260825hmvp-rhi-phase0-mvp.md)。

## 背景与需求

Phase 0 打通了数据管道（采集→指标→存储→CLI）。Phase 1 在其上构建"传感器阵列"：特性链状态机 + 8 类信号检测 + 记忆通道 + 定时采集，让系统从"被动统计"升级为"主动产出可行动洞察"。

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 链数据源 | commit FID 为主，不依赖 frontmatter from | 存量 from 覆盖率 3.3%（特性文档冷启动决策） |
| 状态优先级 | orphan > zombie > regressed > stalled > active | 病态优先，一次判定取最严重态 |
| zombie 判定 | 需显式传入 fidMentionCounts 才判提及=0 | 未传数据时不误判（冷启动安全），messages 表数据源由调用方注入 |
| regressed 窄门 | 最新 commit 是 BugFix ∧ 文件与链内更早 commit 有交集 | 全确定性，不依赖语义聚类 |
| 信号注册表 | 单一真相源 + implemented 标记 | 8 类中 5 类 MVP 实现；eval_regression/intent_drop 因 intent 冷启动（存量 0%）、review_debt 因需 PR comment 数据而挂起，pendingReason 写明 |
| 信号落库 | upsert（同键 open 信号 occurrences+1） | 特性文档 signals 表设计：first_seen/last_seen/occurrences，避免重复行膨胀 |
| 记忆通道 | critical 信号经 StoreMemory 写 working/fact | 复用现有记忆管道（脱敏/FTS/embedding 队列全继承），search_memory 可检索 |
| 唤醒端口 | CriticalSignalWakeup 回调注入 | pipeline 不依赖 agent 工具；create_scheduled_task 桥由 bootstrap 接（Phase 2 接线） |
| 定时采集 | 独立 RhiScanWorker（非 scheduler-service） | scheduler-service 是对话任务调度（触发消息），RHI 是数据管道周期执行；参考 EmbeddingRetryWorker 模式：start/stop + inflightTick 防重入 + 单轮失败不抛 |
| 采集时间基准 | %aI 作者日期（非 %cI 提交日期） | rebase 会改写提交日期，作者日期稳定 |

## 实现清单

| Issue | 模块 | 文件 |
|-------|------|------|
| #398 | 特性链构建器 | src/usecases/health/chain-builder.ts（buildFeatureChains + 五态判定） |
| #399 | 信号检测引擎 | signal-registry.ts（注册表）+ detect-signals.ts（5 类检测）+ signal-repository.ts（signals 表 upsert） |
| #400 | 记忆通道 | signal-pipeline.ts（落库→critical 记忆→唤醒端口） |
| #401 | 定时采集 | rhi-scan-worker.ts（1h 周期全管道）+ app.ts 接线（start/dispose stop） |

git-log-collector 扩展：`%aI` 日期字段（GitCommitWithFiles.date），链构建与信号窗口的时间基准。

## 验证

- 1565 tests / 132 files 全绿（Phase 1 新增 34 个：chain-builder 13 + detect-signals 8 + signal-repository 7 + signal-pipeline 4 + rhi-scan-worker 2 端到端冒烟）
- rhi-scan-worker 冒烟：临时 git 仓库构造 3 次同文件 bugfix → bug_recurrence 触发并落库 → 重复扫描 occurrences 累加
- 端到端断言：信号 evidence 含文件路径、severity 分级正确、记忆通道仅在 critical 触发

## 已知限制

- eval_regression / intent_drop / review_debt 三类信号挂起（原因见注册表 pendingReason），intent 数据按增量积累
- critical 唤醒的 create_scheduled_task 桥尚未接（Phase 2 与 Web 面板一起接——唤醒需要对话上下文）
- hotspot_imbalance 的"持续 2 周"口径用单窗口（30 天）近似，Phase 2 引入双窗口对比
