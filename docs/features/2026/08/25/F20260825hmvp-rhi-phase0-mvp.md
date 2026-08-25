---
id: F20260825hmvp
title: RHI Phase 0 MVP 实施
summary: |
  Epic #393 / Issues #394-#397 的 Phase 0 交付：数据采集器（GitLogCollector/CommitParser/
  FeatureDocCollector/HealingCollector）、核心指标计算（bugfix 双口径比率/模块热区/文件热点）、
  SQLite 存储层（health_snapshots+signals 表）、CLI 报告工具（pnpm health:report 双格式输出）。
  对抗审视两轮收敛：4 严重修复（老库迁移路径、bugfixRatio 分支偏差 ref 默认 main、
  文档口径对齐、快照同日 DELETE+INSERT 去重）。
change_type: feature
status: active
capability_test: "tests/usecases/health/commit-parser.test.ts"
created_in_conversation: 9e709aca-dd74-42fa-9fe1-4e7bbaf24bdb
---

# RHI Phase 0 MVP 实施

母特性文档：[F20260824rhib](./F20260824rhib-rhi-health-dashboard.md)（方案与 Issue 拆分）。本文档记录 Phase 0 的实施决策、实测结果与对抗审视处置。

## 背景与需求

### 问题描述

F20260824rhib 定义了 RHI 的完整方案（L1-L4 分层、8 类信号、14 个 Issue），Phase 0 需要证明数据管道通：采集 → 解析 → 计算 → 持久化 → 输出，并产出第一份健康报告。

### 验收标准（摘自母文档）

- 268 个 commit 全部有确定分类（解析成功或显式 skip-with-reason）
- CLI 报告输出 JSON + 可读文本
- 实测数字可复现（bugfix 比率、top 热点文件、模块分布）

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| git log 分隔符 | `%x1e%H%x1f%s` 记录头 + `--name-only` | 初版 `%H\|...` 方案在 message 含 `\|` 时全崩（259 条只解析出 1 条）；记录头方案保证 header 恒在首行 |
| 统计基准分支 | `ref` 参数默认 `main` | 对抗审视发现 2：git log 不指定 ref 取 HEAD，feature 分支上得 21.3% vs main 26.97%；RHI 语义是"仓库健康"不是"分支健康" |
| bugfix 比率口径 | 双口径并列输出（/total、/有 FID） | 消费方可自选分母；实测 main 口径 26.97% 吻合母文档考古值 27.8% |
| 快照同日去重 | `replaceForDate` 单事务 DELETE+INSERT | 对抗审视发现 4：消费方无需理解"取最新"；纯 INSERT 会随运行次数膨胀 |
| 老库升级 | `migrateDatabase` 补 `ensureRhiTables` | 对抗审视发现 1：initSchema 仅新库执行，老库 server 集成后写入必崩 |
| changeType 白名单 | 仅 `New Feature\|BugFix\|Feature Update` | Refactor/Feature/FeatureUpdate 等历史类型未纳入，建 issue #425 跟踪 |
| 模块正则 | `[a-z][a-z-]*` 允许连字符 | agent-runtime/api-contract 等已广泛使用；采纳审视方案 (b) 以实现口径为准 |

## 实测结果（main 分支，268 commit）

- 有 FID：212 / 268；严格三段合规：158；显式 skip：56
- skipReason 分布：non_standard_format 54、no_f_prefix 48、research_document 6、revert 1、init 1
- BugFix：72 → 比率 26.97%（/total，吻合考古值 27.8%，差异为 RHI PR 自身新增 commit）
- 模块热区 TOP：agent 38 / conversation 19 / skills 15 / memory 11 / web 10
- 文件热点 TOP：src/frameworks/agent/agent-invoker.ts 等（与母文档"19 次触碰"方向一致）

## 验证

- `pnpm health:report --format=text|json` 实跑输出（worktree 内验证）
- 1525 tests / 126 files 全绿（含健康模块 31 个新测试）
- CI 通过（浅克隆环境测试已改自包含临时 git 仓库 fixture）

## 遗留

- #425：changeType 白名单扩展 + skipReason 语义分层（unrecognized_change_type）
- #426：git log 边界场景测试（rename 计数口径影响 Phase 1 信号阈值）
- Phase 1（#398-#401）依赖本 PR 的采集层与指标层
