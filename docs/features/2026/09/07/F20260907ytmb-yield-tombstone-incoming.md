---
id: F20260907ytmb
title: '#827 dissolve 入站清算：yield 指向已解散獭的信号墓碑 + 路由跳过留痕'
summary: |
  与 P2 出站清算（F20260904schf）对称的入站面：獭 dissolve 时，别人 yield 给它、
  从未记账的信号槽位补 aborted/dissolve 墓碑；routeTarget 的 skipped_inactive
  分支补 healing 留痕。消灭「信号永远停在 pending 判据边缘、无账无痕、占扫描名额」
  的僵尸状态。
status: implemented
change_type: fix
tags: [signal-protocol, dispatch-ledger, dissolve, tombstone, observability]
modules:
  - src/frameworks/db/conversation/sqlite-dispatch-attempt-repo.ts
  - src/usecases/otter/dissolve-otter.ts
  - src/usecases/conversation/signal-router.ts
  - src/entities/conversation/dispatch-attempt.ts
  - src/bootstrap/usecases.ts
created_in_conversation: 449d8f5d-e91e-49c0-ade5-0fbd9b3d0fcb
capability_test: "n/a: 纯后端清算逻辑（A 类），无 LLM 参与行为变化；回归由真实仓储集成测试 18 用例 + 全量覆盖"
intent:
  problem: "yield 指向的獭 dissolve 后，信号停在 pending 判据边缘——路由每次跳过（skipped_inactive）但无 attempt 记账、无留痕，排查不可见且占 SCAN_LIMIT 名额"
  expected_effect: "dissolve 即入站清算（墓碑入库、pending 判据出清、轨迹 UI 可显示 ❌）；竞态窗口内的新信号路由跳过有 healing 留痕"
  verify_by:
    type: static_only
    reason: "纯后端清算逻辑，真实仓储集成测试覆盖，无 LLM 行为可采样"
---

# F20260907ytmb: dissolve 入站清算

## 背景与问题

F20260904schf（#792 P2）做了 dissolve 的**出站**清算：已解散獭自己发出的、tsp 指向
active 目标但从未记账的信号补 aborted 墓碑。但**入站**方向遗漏：别的獭 yield 给
它（tsp 已落库）后它 dissolve——该信号槽位：

- pending 判据的 `EXISTS (otters status='active')` 过滤罩住它 → 不误点（哑火侧安全）
- 但 dispatch_attempts 无行 → 无墓碑、无终态，轨迹 UI 显示 ⏳ PENDING（撒谎）
- 每次启动补扫 routeTarget 判 `skipped_inactive` 静默跳过 → 无 healing 留痕
- 占 SCAN_LIMIT（200）名额——大量僵尸时挤占真实 pending 的扫描窗口

原 issue #827 设想的修复位置是「yield 写入路径（tool-factory）」，勘测后修正：
**yield 时目标必在场（validateAndResolve 拦截不在场名字）**，真实病灶在 dissolve
时刻的存量清算——与出站清算同位置同模式，tool-factory 无需改动。

## 方案设计

1. **入站清算 SQL**（与 abortUnattemptedOutgoingForOtter 对称）：
   `t.value = dissolved otter ∧ completed ∧ active 会话 ∧ 非自指 ∧ 无 attempt 行`
   → INSERT aborted/dissolve 墓碑，note=「目标獭已解散，信号永不点火」
   - 与出站的差异：出站不限会话状态（宁多勿少），入站对齐 pendingClause 的
     `c.status='active'`（归档会话本就不扫）
   - sender 不限类型：user 消息点名已解散獭同样永不点火，一并清算
2. **dissolve 编排**：abortIncomingSignals 挂在 abortOutgoingSignals 之后，
   可选注入、失败仅日志（不阻断解散主流程）
3. **路由跳过留痕**：routeTarget 的 skipped_inactive 分支补 healing 记录
   （severity low）——覆盖 dissolve 与路由的竞态窗口（清算后新写入的信号）

## 变更清单

| 文件 | 变更 |
|------|------|
| sqlite-dispatch-attempt-repo.ts | +abortUnattemptedIncomingForOtter（入站清算 SQL） |
| dispatch-attempt.ts（实体接口） | +方法签名 |
| dissolve-otter.ts | +abortIncomingSignals（deps 可选注入 + 编排调用） |
| bootstrap/usecases.ts | 装配注入 |
| signal-router.ts | skipped_inactive 分支 +healing 留痕 |
| dispatch-attempt-repo.test.ts | +2 集成用例（核心场景/边界不误伤） |
| dispatch-chain-engine.test.ts | mock 补新方法签名 |

## 验证

- 真实仓储集成 18/18 绿（新增 2 用例：核心场景幂等 + 边界不误伤）
- tsc 0 error；eslint 变更文件 0 error
- 全量回归见 PR CI

## 关联

- Issue: #827（closes）
- 对称前序: F20260904schf（P2 出站清算，#792）
- 母方案: #695（批次 1 项目②）
