---
id: F20260901schd
title: 调度器三连修：轮询补触发 + claim 竞态防护 + 429 看门狗判死
summary: 修复 #640 setTimeout 系统性迟到、#641 重复触发竞态、#642 链看门狗对 429 失明三个同现场调度器问题
change_type: fix
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# 调度器三连修：轮询补触发 + claim 竞态防护 + 429 看门狗判死

## 背景

2026-09-01 09:00 档定时任务全体迟到 16-20 分钟，排查发现三个同现场调度器问题：

| Issue | 问题 | 根因 |
|-------|------|------|
| #640 | setTimeout 模式系统性迟到 | macOS App Nap 冻结 timer，无轮询兜底 |
| #641 | 重复触发竞态 | claimTask 60s 窗口不感知 running execution |
| #642 | 链看门狗对 429 失明 | 静默窗被 429 重试无限续期 |

## 修复方案

### #640: Tick 轮询模式（quartz/celery beat 同款）

- 每 30 秒扫描所有 active 任务（`POLL_INTERVAL_MS = 30_000`）
- 比对 `last_triggered_at` 与 cron 应触发点，越过即补触发
- 记录 drift 值用于可观测性
- 保留 setTimeout 快路径，轮询为准（timer 漂移时 catch-up）
- 防重复：`lastTriggeredAt` 在 `POLL_INTERVAL_MS` 窗口内 → 跳过

### #641: Claim 前检查 running execution

- `claimAndValidateTask` 前新增检查：同 task 存在未超时 running execution → 拒绝 claim
- 未超时判断：`triggeredAt` 在 `MAX_CHAIN_TIMEOUT_MS`（24h）内（防僵尸 execution 无限阻塞）
- 同 task 存在 running execution 时拒绝触发，记 skipped（非 failed，不计连败）

> **注意**：Lock acquire timeout 降级为 skipped 的实现不在本 PR 范围（属 agent-invoker 域跨域改动），已拆出为 #654 跟踪。当前 PR 仅实现 claim 前检查 running execution。

### #642: 链看门狗 429 判死

- 新增 `isChainStuckOn429()` 方法：检测锚点后最近消息是否全是 429 特征
- 429 特征模式：`429` / `rate_limit` / `quota` / `配额耗尽` / `too many requests`
- 连续 3 次静默窗探测均为 429 → 直接判死（配额耗尽不会自愈，续期无意义）
- 非 429 活跃 → 重置计数器

## 改动文件

- `src/usecases/scheduler/scheduler-service.ts`: 核心修复（轮询 + claim 检查 + 429 判死）
- `tests/usecases/scheduler/scheduler-service.test.ts`: 新增 6 个测试覆盖三场景
- `tests/usecases/scheduler/healing-analysis-template.test.ts`: 适配 claim 检查变更

## 测试覆盖

| 场景 | 测试 |
|------|------|
| #640 轮询补触发 | `轮询 tick 检测到 overdue 任务并补触发` |
| #640 防重复 | `轮询 tick 不重复触发最近已触发的任务` |
| #641 running 拒绝 claim | `存在未超时 running execution 时拒绝 claim` |
| #641 超时放行 | `running execution 超时（>24h）时允许 claim` |
| #642 429 检测 | `isChainStuckOn429 检测 429 特征消息` |
| #642 非 429 | `isChainStuckOn429 对非 429 消息返回 false` |

## 验证

- 全量 scheduler 测试 58/58 通过
- Lint 0 errors（5 warnings 为 pre-existing）
