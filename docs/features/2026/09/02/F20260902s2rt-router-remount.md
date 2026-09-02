---
id: F20260902s2rt
title: 'sgp2 S2：信号路由器重挂——台账判据 + web/IM 入口换轨 + 启动补扫'
doc_type: feature
summary: |
  v2 语义的调度切换：路由器以「pending := 已投递 ∧ 无派发记录」判据重挂装配，
  web/飞书/微信入口 + RIS 启动补扫换轨；scheduler/retry 仍直连（经链引擎记账，
  无双触发账面歧义）。rbsg 两起事故的根因均已消除：语义混淆→台账真相源；
  存量点火→墓碑一次性翻篇（#739 守卫）。摘装配一行即回直连链（降级面不变）。
status: final
change_type: feature
tags: [signal-protocol, signal-router, dispatch-ledger, incident-hardening]
modules: [src/usecases/conversation/signal-router.ts, src/app.ts]
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
capability_test: "n/a: 后端调度变更（A 类），行为由 12 单元 + 4 真实仓储回放判据（R1/R2/R3/幂等闭环）覆盖"
causal_links:
  from:
    - F20260902sgp2   # 父特性（v2 设计）
    - F20260902rbsg   # P1 回滚根因（本特性消除两根因）
    - F20260902hopf   # hop 取源修复（记账完整性前置）
    - F20260902bfgr   # backfill 守卫（R1 保护前置）
---

# F20260902s2rt: 信号路由器重挂（S2）

## 决策与变更

### 1. 路由器判据接台账（signal-router.ts 重构）

- `pendingSignalsFor`（游标未读视图）**退役**，连同 `queryCandidateSignals`/`distinctTargets`
  （候选+去重的两段式判据）一并删除——台账 `listPendingSignals`（§4.3 SQL 单一真相源）
  一次查询返回全部 pending (message, target) 对，按目标分组路由
- 脏数据防护：台账行指向的消息缺失（理论不可能，防御性）→ 跳过 + warn
- 档位矩阵（NORMAL/URGENT/HALT）、busyQueue 内容保全、inFlight 去重、healing 留痕——
  sgpv 的核心机制**原样保留**，只换了判据层

### 2. 装配重挂（app.ts）

- rbsg 回滚注释块处恢复 `new SignalRouter`（+ `dispatchAttemptRepo` 注入，v2 必需依赖）
- 注入点全恢复：initPlatforms（飞书/微信）、initControllers（web MC）、ResumeInterruptedService（RIS 启动补扫）
- **scheduler/retry 仍直连**（sgpv P1 边界保留）：其派发经链引擎记账，账面无双触发歧义

### 3. rbsg 两根因的消除证明

| rbsg 根因 | v2 消除机制 | 验证 |
|-----------|------------|------|
| 「未读 ≠ 待行动」语义混淆 | pending = 台账反连接（§4.3），行动义务由派发尝试记账 | R2/R3 回放测试 |
| 存量批量点火 | 墓碑 S1 一次性翻篇 + #739 守卫防重跑 | R2 回放测试（10 条历史积压 → 零点火） |

## 测试

- `signal-router.test.ts` 重写（12 用例）：台账判据语义 + 档位矩阵 + busyQueue 快照注入 +
  inFlight 去重 + 脏数据 + filter 单目标 + routeAllPending 隔离
- `signal-router-ledger.test.ts` 新建（4 用例，真实仓储 × 真路由器，判据零 mock）：
  **R1** 崩溃窗口真 pending 被补扫点火 / **R2** 墓碑覆盖历史零误点 / **R3** failed 翻篇不重燃 /
  派发后销账幂等闭环

## 验证

- 后端 227 files / **2851 tests** 全绿；tsc 干净；eslint 0 error
- 最简实现检查：已过——路由器复用 sgpv 骨架仅换判据层；未引入新表/新抽象

## 回滚面

摘除 app.ts 的 SignalRouter 构造块 + 三处注入（或直接 revert 本 PR）即回直连链。
台账在直连链下继续记账（无行为影响）。

## 灰度建议

合入后先观察一个自然日（重点：web 入口换轨后的点火日志与 [signal-ledger] 记账一一对应；
busyQueue 排队消化正常）。飞书/微信入口与 web 共用同一装配开关——如需分入口灰度，
后续 PR 拆分注入点（当前保持与 sgpv 相同的粒度）。
