---
id: F20261027pspc
title: 每日体检增加 pending 待执行项滞留检查
summary: 收口 F20261021sprx 的实现时评估项：每日体检只读扫描超 24 小时未消费的 pending 项，逐条提醒；超 48 小时升级 issue，避免待执行列表静默滞留。
doc_type: feature
change_type: prompt
capability_test: "n/a: 单条确定性 SQL 与静态 prompt 检查；无对应 golden 场景"
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
created_at: 2026-10-27
causal_links:
  from: [F20261021sprx]
tags: [health-check, scheduled-task, pending, observability]
modules: [prompts/scheduled/daily-health-check.md]
intent:
  problem: "pending 待执行项靠执行獭自主拉取，缺少监督时超期未消费不可见"
  expected_effect: "每日体检能按真实运行 cwd 与 ISO 时间语义检出超 24h pending；超 48h 有明确升级判据"
  verify_by:
    type: static_only
---

# 每日体检增加 pending 待执行项滞留检查

## 背景与目标

F20261021sprx 的「后续机制」段把「健康检查加 pending 超 24h 告警」标为实现时评估项。本变更只补这一观测缺口，不修改 pending 生命周期、调度、消费或提醒机制。

- 每日体检先按既有前置纪律读取实际 `dbPath`，再切到主仓根执行只读 SQL；不能从对话工作区直接解析相对 DB 路径。
- SQL 用 `datetime(p.triggered_at)` 规范化 ISO-8601 UTC 时间后与 `datetime('now','-24 hours')` 比较，避免带 `T/Z` 的文本与空格分隔阈值直接比较。
- 查询命中的项逐条提醒；同一项超 48h 即升级 issue 并附 pending id。这里把「连续 2 日」落成可由当前时间戳直接判断的机械口径，不依赖翻找昨日日报。
- `consumed` 不出现在 `status='pending'` 查询结果内，因此不告警。

## 非目标

- 不新增数据库表、后台任务、工具、通知通道或自动消费逻辑。
- 不调整既有看门狗、并发、重试、skip/executed 语义。
- 不因本变更提高 prompt 体积预算。

## 设计取舍

采用现有每日体检的一条只读查询，而不新增持久化监督机制。这样改动只落在一个 prompt 文件，提醒和升级均有明确阈值，缺点是不会在两次体检之间实时告警。

Modification-Class: `narrow-fix`。机制识别检查点：无新配置、状态生命周期、后台任务、消息格式、持久化 schema、跨模块调用路径；新增的「超 24h 提醒、超 48h 升级」是本观测规则内的确定性阈值，不建立独立决策机制。

## 验证与失败证据

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 修前运行目录错误 | 在对话工作区执行原相对路径 SQL | `unable to open database file`，证明必须切主仓并先取真实 dbPath |
| 修前时间比较假阴性 | SQLite 对拍 `'2026-10-26T00:48:44.025Z' < datetime('now','-24 hours')` 与两侧 `datetime()` 版本 | 原式为 0、修正式为 1（当时阈值 `2026-10-26 09:13:54`） |
| 修后真实库 | 在主仓根对生产库以 `mode=ro` 执行修正 SQL | 语法通过；本次实测 24h/48h 命中均 0，无生产数据被修改 |
| prompt 静态门 | `node scripts/lint-prompt-size.mjs` | 9 个模板，0 超预算 / 0 警告 |
| 锚点门 | `node scripts/lint-prompt-anchors.mjs --full` | 通过 |
| 变更完整性 | 对照最新 `origin/main` 的最终净 diff | 保留 #1658 新增的 loop_tool_block 检查、产出清单第 13 项、hook fallback / shadow 失衡活规则；所有体积出清在 PR body 显式申报 |

Golden Gate: n/a（`verify_by=static_only`，本变更无对应场景可跑）。

最简实现检查：复用每日体检与 SQLite 原生时间函数，未新增代码、文件型机制或依赖；特性文档仅承担本变更的验证与决策留痕。

## 审视处置摘要

独立审视发现原 SQL 在真实 cwd 必败、ISO 时间裸比较会漏检，以及文档/CI 缺项；均在本 PR 修复。体积出清曾误删 hook fallback / shadow 失衡规则，已按 F20261009arlz 的活规则教训恢复。delta 复核指出命令应字面带 `cd <主仓>`、零结果应有健康态报告；二次 rebase 保留 #1658 新增检查段时一并采纳，并只做同语义措辞出清，未删除检查项。
