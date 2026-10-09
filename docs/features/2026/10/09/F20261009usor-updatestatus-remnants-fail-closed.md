---
id: F20261009usor
title: updateStatus 族口径外两处收尾：otter dissolve / entry updateEntryStatus fail-closed（#1403）
summary: "#1370 族模式最后两处成员收尾：otter dissolve 与 entry updateEntryStatus 对 changes=0 抛错（assertUpdated 收敛，第 8/9 处调用点）；捎带评估 scheduler cron 回调 getById 存量风险（结论：不修）"
change_type: fix
capability_test: "n/a: DB 回执语义修复，验证走单测（两仓 fail-closed 三用例），无独立 LLM 能力面"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
created_at: 2026-10-09
tags: [db, bugfix]
modules: [otter, conversation]
causal_links:
  from: [F20261009ustr]
---

# updateStatus 族口径外两处收尾：otter dissolve / entry updateEntryStatus fail-closed（#1403）

## 背景

#1370 族模式（按 ID 更新单实体、不看 result.changes、不匹配静默成功）修复链：#1370（healing）→ #1385（document）→ #1391（三仓 + assertUpdated 收敛 7 处）→ 本 issue（口径外最后两处）。#1391 审视（PR #1394 检视獭建议 3）确认这两处是同族成员但未随 #1391 修，立 #1403 跟进。

## 修法

照搬 #1391：repo 层对 `changes === 0` 抛错，收敛至公共断言 `src/frameworks/db/assert-updated.ts`（第 8/9 处调用点）：

1. `sqlite-otter-repository.ts` `dissolve()`——+1 行 assertUpdated（label `"otter"`）
2. `sqlite-entry-repository.ts` `updateEntryStatus()`——两分支（含/不含 completedAt）统一取 RunResult 后 +1 行 assertUpdated（label `"entry"`）

## 设计取舍（机制判定：narrow-fix）

机制识别检查点逐项未命中：同族模式第 9 次复制、公共断言已存在（纯等价替换）、语义/边界不变、不新增机制——判定 narrow-fix，与 #1391 同口径。

**幂等语义核查（issue 点名要求）**：
- **otter dissolve**：上游 `dissolve-otter.ts:52-58` 有 `getById`（不存在抛 not_found）+ `canDissolveOtter`（状态机校验）双层前置防护，fail-closed 抛错只在「查询后被并发删除」的竞态窗口触发——与 conversation archive（#1391）同构，抛错方向正确。
- **entry updateEntryStatus**：实查全仓零调用方（`usecases/conversation/entry-repository.ts:32` 接口声明保留，恢复流改写走别的路径）。fail-closed 是防御未知未来调用方的静默假成功，无既有调用方受影响。

## 捎带评估：scheduler cron 回调 getById 无 try/catch（#1394 delta 复核观察项）

**结论：不修**。`scheduler-service.ts:481` cron 回调内 `getById` 返回 null 的路径只是「任务在 tick 间隙被删」的正常竞态，回调语义上无需兜底（null 即跳过执行）；真正的异常逃逸面已在 #1394 严重 1 由外层 `.catch` 兜底（:557）。评估记录于此，#1403 不承载代码改动。

## 验证

- 新增 3 用例：dissolve 不存在 ID 抛错 / dissolve 存在 ID 不回归（status + dissolvedAt 断言）；updateEntryStatus 不存在 ID 两形态（含/不含 completedAt）抛错（存在的 ID 既有用例已覆盖不回归）
- 相关域复跑：14 文件 123 用例全绿（otter / conversation / usecases/otter）
- 全量回归：350 文件 5230 用例通过，2 个失败（guard-intercept-classify / build-app）经基线对照证实为 pre-existing flaky（stash 后基线同挂，与本变更零交集；单跑转绿）
- tsc --noEmit 零错误
