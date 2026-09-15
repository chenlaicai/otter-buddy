---
id: F20260915mswt
title: 调度对账误报容差：准时触发抖动不再判「错过」
summary: 修复 #929——#814 对账的错过判定用毫秒级比较，lastTriggeredAt 早窗口 0.3-1.6s（正常调度抖动）被判 missed，9/15 单日 5 条误报形成狼来了效应。修复：判定加 5s 容差（reference >= prevDue - 5000 即无错过）。
change_type: fix
capability_test: "n/a: 判定逻辑由 2 个新回归用例锁定（抖动不误报 + 真错过仍报）"
created_in_conversation: c2f347c6-7e59-4e2e-ab48-10f64a5a1258
created_at: 2026-09-15
intent:
  problem: "对账判定毫秒级比较把准时触发抖动（早 0.3-1.6s）判成错过窗口，误报淹没真实信号"
  expected_effect: "5s 容差内抖动零误报；真错过（超出容差）仍正常落账；#814 真实错过用例零回归"
  verify_by:
    type: behavior_check
tags: [scheduler, daily-review, false-positive]
modules:
  - src/usecases/scheduler/scheduler-service.ts
  - tests/usecases/scheduler/scheduler-service.test.ts
---

# 调度对账误报容差（#929）

## 背景

#853/#853-定稿（#914 批次）给对账加的判定 `reference >= prevDue` 是毫秒级严格比较。9/15 00:09 对账单日落 5 条误报（paper-trading ×2 / backlog digest / 上下文观察 / self-healing-analysis）：lastTriggeredAt 全部只比窗口早 0.3-1.6 秒——cron 触发器按分钟粒度对齐，早零点几秒是正常抖动。误报 5 条/日的量级会淹没真实错过信号（#823）。

## 修复

`reconcileMissedWindows` 判定改为 `reference.getTime() >= prevDue.getTime() - 5_000`（MISSED_WINDOW_TOLERANCE_MS 常量）。容差取 5s：覆盖现场观测的最大抖动 1.6s 的 3 倍余量，又不至于吞掉分钟级真错过。

不做「窗口内 execution 行核查」（issue 方案第 2 半条）：execution 行按触发时刻记录，抖动触发的 execution 行时间戳早于窗口起点，按窗口过滤同样需要容差——一层容差已闭环，不叠加判定复杂度。

## 验证

- 新增 2 回归：0.645s 抖动（现场同构）不误报 + 早超一天真错过仍落账
- 全量 2951/2951 + tsc 0；#814 既有 4 用例零回归（含去重）
- 今晨 5 条误报 healing 事件已批量 resolve（no_action，注明误报根因）

## 关联

- closes #929
- 地基：#814（对账机制本身）/ #853（判定逻辑引入）
