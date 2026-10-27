---
id: F20261027tmcf
title: 7 个定时任务 timeout_minutes 显式配置（#1306）
summary: 以 scheduled_task_executions 实测时长为锚，为 7 个 NULL 继承 15min 默认值的定时任务配置显式超时，消除超时语义与任务实际时长的脱节；含新增的 regression-verify 与 worktree-converge。
doc_type: feature
change_type: fix
capability_test: "n/a: 纯运行时配置变更（SQLite UPDATE，无代码 diff，无测试面）"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
causal_links:
  - "#1306（立案：5 任务 NULL 继承默认 15min，超时语义脱节）"
  - "F20260827npmhvs（前置：超时静默窗改造，本配置是其配置面的补全）"
tags: [scheduler, timeout, config]
modules: [scheduled-tasks]
created_at: 2026-10-27
---

# 7 个定时任务 timeout_minutes 显式配置（#1306）

## 背景与核实

#1306（10-06 立案）指出 5 个任务 timeout_minutes IS NULL、继承默认 15min 链超时，与任务实际时长脱节。

**独立核实（10-27 10:35 实查 scheduled_tasks 表）**：NULL 任务已不止 5 个——原 5 个之外新增 `regression-verify`（active，近 6 次执行 avg 8min / max 24min）与 `worktree-converge`（active，10-26 那次跑 131min 被「孤儿执行清理」机械释放——今晨 healing 高严重事件「滞留超 2h」的当事任务，NULL 超时配置正是其无判死依据的放大器）。disabled 任务 3 个也为 NULL（客户生日提醒 / paper-trading ×2），不运行无影响，不在本 issue 范围。

## 定值依据（实测时长，非照抄 issue 建议）

数据源：`scheduled_task_executions`（completed 状态，julianday 差 × 1440 取分钟）。issue body 的建议值（如「月度剪枝 60」）经实测推翻——月度剪枝唯一一次实际执行跑了 4.75 天（5700min，failed，属 #1302 悬置判死链路问题），它是重度编排（全量 issue 盘点 + 剪枝决策），60min 必杀。这也验证了「开工前独立核实、issue 方案只当假设」的必要性。

| 任务 | 实测（avg/max，min） | 定值 | 余量逻辑 |
|---|---|---|---|
| 每日对话健康检查 | 9 / 43 | 240 | 长编排含多数据源拉取+issue 产出，峰值余量 ≥5× |
| 每日 issue 处理 | 6 / 22 | 240 | 可含开发+PR 全流程（本任务当日即可跑数小时） |
| 月度剪枝审视 | 5700（failed，异常长） | 180 | 重度编排给 3h 硬顶，替代「等满 24h 硬上限才判死」 |
| worktree-converge | 131（failed，机械释放） | 150 | 10-26 实际 131min 被机械释放而非超时判死，150 给真实上限 |
| self-healing-analysis | 9 / 37 | 120 | 峰值 37min，3× 余量 |
| 依赖升级自动化 | 5 / 109 | 60 | 峰值 109min 出现在异常日（依赖大版本冲突排查），60min 取常态上限；超时即判死重启比放任更安全 |
| regression-verify | 8 / 24 | 60 | 峰值 24min，2.5× 余量 |

## 变更方式

运行时配置直更（SQLite 事务 UPDATE，updated_at 同步刷新），无代码 diff——与 issue「配置走任务定义更新，无需代码改动」的判断一致。变更前 `.mode insert` 备份 7 行原值至对话工作区（backup-scheduled-tasks-null-timeout.sql）。

**配置结果（变更后实查）**：剩余 NULL 仅 3 个 disabled 任务；7 目标任务全部显式配置（240/240/180/150/120/60/60）。

## 验证

- 变更后查询：`SELECT name, timeout_minutes FROM scheduled_tasks WHERE timeout_minutes IS NULL` → 仅剩 disabled ×3 ✓
- 7 目标任务配置值与上表一致（逐行回显核对）✓
- 后续生效观察：下次各任务触发后，执行记录不再出现「NULL 超时下 15min 链超时」或「滞留 2h 才被孤儿清理机械释放」形态（worktree-converge 150min 判死窗口替代 2h 机械释放）

## 关联

- #1306 本 issue；#1302 悬置判死链路（本配置消除其配置面放大器）
- 今晨 healing「worktree-converge 滞留超 2h 轮询机械释放」事件——根因即 NULL 无判死依据，本变更为其配置面修复
