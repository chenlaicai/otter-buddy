---
id: F20260903dmpe
title: 'sgp2 S2.1：热循环阻尼机制化——重扫排除 failed 行 + 最小点火间隔'
doc_type: feature
summary: |
  F20260903damp 阻尼清单第 1+2 项落地：① pending 判据排除含 failed/aborted 终态行的
  信号——重扫视野只碰「从未派发」的行，失效模式从永燃改为哑火；② shouldThrottle
  最小点火间隔（60s）——即使记账意外缺失，热循环最坏频率从 15 次/秒压到 1 次/分钟。
  R5 回放判据三用例锁定。失败信号重试语义不变：仅用户手动 retry。
status: final
change_type: fix
tags: [signal-protocol, damping, loop-prevention, incident-hardening]
modules: [src/usecases/conversation/signal-router.ts, src/frameworks/db/conversation/sqlite-dispatch-attempt-repo.ts]
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
capability_test: "n/a: 后端阻尼逻辑（A 类），行为由 R5 三用例 + 全量回归覆盖"
causal_links:
  from:
    - F20260902sgp2   # 父特性
    - F20260903damp   # 事故根因分析与阻尼清单（本特性落地其第 1+2 项）
---

# F20260903dmpe: 热循环阻尼机制化（S2.1）

## 背景

09-03 热循环事故（F20260903damp）的结构性教训：「正确时正确」的判据不够，还需要
「错误时不可怕」。#749 修了直接链路（点火即记账 + dissolved 过滤），本特性落
阻尼清单第 1+2 项，使同类失效模式的后果从「永燃」降为「哑火」。

## 变更

### 阻尼 1a：pending 判据排除 failed/aborted 终态行（sqlite-dispatch-attempt-repo.ts）

pendingClause 追加 `NOT EXISTS (failed/aborted 行)`——重扫视野只碰「从未派发」的
信号。failed 信号的再点火语义不变：**仅用户手动 retry**（source='retry'，覆盖式记账）。
这把「无自动重试」从口号变成判据机制：即使 #749 的点火即记账再被未来的调用点破坏
（第八个调用点问题），失败信号也不会回到重扫视野——循环一轮即止。

### 阻尼 1b：shouldThrottle 最小点火间隔（60s）

`DispatchAttemptRepo.shouldThrottle(messageId, targetOtterId, minIntervalSec)`：
同 (message,target) 距上次点火不足间隔时返回 true，路由器 routeTarget 在 busy 判定前
硬性拒绝（返回 queued_busy 语义，日志留痕）。**即使记账意外缺失**（回顾 09-03 事故：
台账无行是热循环燃料），60s 内第二次点火被拒——热循环最坏频率从 15 次/秒压到
1 次/分钟，为人工干预赢得窗口。脏时间戳按不阻尼（宁多勿错，与信号判据的降级纪律一致）。

### 阻尼 2：失败消息写放大上界（验证性锁定）

UNIQUE(message_id, target_otter_id) 覆盖式记账 + #749 后 failed 消息由 orchestrator
单点落地——R5c 用例锁定「同 (message,target) 反复失败，台账仅一行，本轮 note 为最终
原因，历史轮次压缩进覆盖链」。

## 测试（R5 回放判据，signal-router-ledger.test.ts 追加 3 用例）

- **R5a** 失败后重扫零点火：首轮回合（点火 1 次）→ 台账 failed → 两个重扫周期零新增点火 + pending=0（热循环免疫）
- **R5b** shouldThrottle 边界：无记录不阻尼 / 60s 内阻尼 / 间隔外放行 / 脏时间戳不阻尼
- **R5c** 写放大上界：UNIQUE 槽位覆盖不膨胀 + 本轮失败原因可查

## 验证

- 后端 228 files / **2830 tests** 全绿；tsc 干净；eslint 0 error
- 既有 R1-R4 全部保持（无回归）
- 最简实现检查：已过——pendingClause 加一个 NOT EXISTS、一个 12 行的 repo 方法、
  routeTarget 一个守卫分支，零新表零新抽象
