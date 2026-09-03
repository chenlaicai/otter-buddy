---
id: F20260903damp
title: 信号路由器 v2 热循环事故：点火即记账与 dissolved 目标过滤
doc_type: feature
summary: |
  修复 sgp2 S2 上线即热循环：dissolved 检视獭被启动补扫点火，50ms 重扫 × 台账漏记
  → 42 秒 614 条失败消息。根因是 pending 推导态与目标生命周期脱钩 + 消费记账靠
  调用方自觉。主机制：路由器点火前先写 attempt 行（机制化销账）+ pending 判据
  过滤 dissolved。含两次上线爆炸的同构性分析与后续阻尼清单。

causal_links:
  from:
    - F20260902sgp2   # v2 设计（S1/S2 落地）
    - F20260902rbsg   # v1 回滚根因分析（本事故对照输入）

status: final
change_type: fix
tags: [signal-protocol, dispatch-ledger, incident, loop-damping]
modules:
  - src/usecases/conversation/signal-router.ts
  - src/frameworks/db/conversation/sqlite-dispatch-attempt-repo.ts
capability_test: "n/a: 后端调度/记账逻辑（A 类），无 LLM 参与行为；回归由真实仓储集成测试覆盖（tests/usecases/conversation/signal-router-ledger.test.ts）"
---

# F20260903damp: 信号路由器 v2 热循环事故

## 背景与需求

### 问题描述

sgp2 S2 合入（#744，2026-09-03 08:10）后用户更新代码重启，会话《mac touch bar》
（31767a2b）中检视獭-Swift（6b1042ae，**已 dissolved**）以约 15 条/秒的频率反复产出
`[错误] No session or config found for otter: 6b1042ae...`，**42 秒 614 条 failed
消息**，用户杀进程止血。这是信号协议连续第二天上线即爆炸（v1 09-02 回滚见
F20260902rbsg）。

### 事故时间线（DB 实证）

| 时间（+0800） | 事件 |
|------|------|
| 09-02 22:07 | 大獭消息 3b0f5cb3 yield 给检视獭-Swift——**此刻目标 otter 行尚不存在**（EXISTS 判据不通过，非 pending；链跳过且不写账） |
| 09-02 22:15 | 检视獭-Swift 创建（6b1042ae）→ 消息**追溯地**变为 pending（EXISTS 通过 ∧ 无台账行）；墓碑已在更早的 S1 迁移时刻一刀切过，罩不住之后出生的消息 |
| 09-02 22:25 | 检视獭完成检视被 dissolve：otters 行保留（status=dissolved），otter_configs/agent_sessions 删除；pending 不解除（EXISTS 只查行不查 status） |
| 09-03 08:10 | S2 合入（信号路由器重挂 + 启动补扫换台账判据） |
| 09-03 08:13 | 用户重启。启动补扫 routeAllPending 点火该信号 → invoke 抛 No session or config found（session-restore.ts:54）→ orchestrator failMessage 落一条失败消息 → 路由器 finally 触发 50ms 去抖重扫 → 台账仍无行 → 再点火 → 死循环 |
| 09-03 08:13:50 | 用户杀进程。遗留 614 条 failed 消息 + 1 行幽灵 otter_sessions（agent-invoker.ts:533 的 domain session backfill 在首次点火时给 dissolved 獭建行） |

### 根因分析

三个缺陷叠加（缺一即不炸）：

1. **路由器点火不写账**：`SignalRouter.invokeTarget` 调 `executeChain` 时未传
   `triggerMessageId` → `recordAttemptStart` 的 ledgerMsgIds 为空直接 return
   （dispatch-chain-engine.ts:226-227）→ 台账永远不写 → pending 永生。S1 插桩了
   六个调用点，S2 的路由器是第七个，漏了——记账键必须由每个调用方自觉提供，
   **可选参数 + N 个调用点约定**不是机制是运气。
2. **pending 判据与目标生命周期脱钩**：pendingClause 只查
   `EXISTS (SELECT 1 FROM otters o WHERE o.id = t.value)`，不看 status；
   `queryOtter.getById`（sqlite-otter-repository.ts:37）同样 `SELECT * WHERE id=?`
   不过滤。路由器「目标已解散留箱静默」的守卫（routeTarget 注释）假设 getById
   会滤 dissolved——设计从未规定谁负责过滤，实现也没人做。
3. **失败无终态吸收 + 完成触发重扫闭环**：invoke 失败 → failMessage（用户可见）
   → finally → 50ms 重扫 → 同一 pending → 再点火。取舍 #2 声称「无自动重试」，
   但「invoke 完成 → 去抖重扫 × 不灭 pending」实际内嵌了一个 50ms 周期、无预算、
   无上限的重试引擎——设计的风险清单没有「记账漏了重扫会怎样」这一项。

### 两次上线爆炸的同构性（判设计 vs 判实现的关键证据）

| | v1（sgpv，09-02） | v2（sgp2 S2，09-03） |
|---|---|---|
| pending 判据 | 游标滞后（推导） | 台账反连接缺行（推导） |
| 判据为何失真 | 滞后≠欠行动 | 目标未出生→追溯 pending→dissolve 不解除 |
| 循环形态 | invoke 完成→重扫→再点火（单獭 23 次） | invoke 失败→重扫→再点火（614 次） |
| 阻尼 | 无 | 无 |

直接原因完全不同、爆炸形态完全同构 → **主责在结构而非疏忽**：v2 修对了语义
（未读≠待行动），但保留了「推导态 pending + 自激点火闭环 + 无独立阻尼」的结构。
系统安全押在「每次派发都记账」这个不可局部验证的全局不变量上，且不变量被违反时
失效模式落在危险侧（永燃）而非安全侧（哑火）。若信号义务是持有状态（投递事务内
建行），漏写 = 信号不存在 = 哑火。详见「设计决策」节的阻尼清单——本 PR 只落地
前两条（切断本次事故的直接链路），其余为后续硬化项。

### 数据实锤

- `dispatch_attempts` 表中 (3b0f5cb3, 6b1042ae) **无任何行**（pending 永生的直接证据）
- messages 表：614 条 sender=6b1042ae 的 failed 消息，时间跨度 00:13:08.688Z–00:13:50.037Z
- otters 表：6b1042ae status=dissolved，dissolved_at=09-02T14:25:50Z；otter_configs/agent_sessions 无行

## 方案设计

### 技术方案

**修 1（机制化销账）：路由器点火即记账。** `invokeTarget` 在调 `executeChain`
**之前**先写 attempt 行（in_progress, source='router'）；链引擎的 recordStart 对同
(message,target) INSERT OR REPLACE 覆盖（幂等，note 保留 prev 前情），settle 由链按
triggerMessageId 落终态；链在记账前整体抛错时由路由器 catch 兜底落 failed。从此
「点火 ⇒ 账面有行」不依赖链引擎参数到达——把 §4.2 的约定升级为机制。

**修 2（生命周期过滤）：pending 判据与路由双重滤 dissolved。**
- pendingClause 的 EXISTS 加 `AND o.status = 'active'`——指向死亡目标的信号不是
  actionable pending，从计数/扫描/补扫中消失（留箱静默语义的判据面落地）；
- routeTarget 对 `otter.status !== "active"` 返回 skipped_inactive（纵深防御，
  覆盖判据 SQL 与 otters 表状态的竞态窗口）。

两修独立成立：任一单独在场本次事故都不炸（修 1：失败落终态，循环一轮即止；
修 2：dissolved 根本不点火）。

### 目标

- T1: 路由器点火的每个 (message,target) 必有 attempt 行，无论链成功/失败/抛错
- T2: dissolved 目标不进 pending、不被点火
- T3: 失败信号不重燃（R3 语义对路由器路径成立）

### 成功标准

真实仓储集成测试新增 R4 判据全绿 + 存量 R1-R3 不回归 + tsc/eslint/全量测试干净。

## 验收标准

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|---------|
| AT-1 | dissolved 目标不 pending | seed 消息指向 status=dissolved 的 otter，无台账行 | countPendingSignals=0；routeAllPending 零点火 |
| AT-2 | 点火即记账（失败路径） | seed 真 pending 指向 active otter；executeChain mock rejects | attempt 行存在且终态 failed；二次 routePendingSignals 零点火（热循环回归判据） |
| AT-3 | 点火即记账（成功路径） | executeChain mock resolves（不模拟链内记账） | 路由器预写的 in_progress 行存在；pending 清零 |
| AT-4 | R1-R3 不回归 | 既有四用例 | 全绿 |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1~4 | tests/usecases/conversation/signal-router-ledger.test.ts（真实 SQLite 仓储 × 真判据 SQL） |

## 实现细节

### 代码修改

**signal-router.ts**：

- `routeTarget`：`if (!otter || otter.status !== "active") return "skipped_inactive"`；
  调 `invokeTarget` 时透传 `signal.id` 作 triggerMessageId。
- `drainBusyQueue`：透传 `item.signalId`。
- `invokeTarget(conversationId, otterId, content, senderId, triggerMessageId?)`：
  点火闭包内先 `dispatchAttemptRepo.recordStart({source: "router", status: "in_progress"})`
  （try/catch，失败仅日志）；`executeChain` params 带 `triggerMessageId`（链内
  hop-1 记账 + hop-2+ 出处链保持既有语义）；catch 分支 `recordFinish(..., "failed")`
  兜底终态。

**sqlite-dispatch-attempt-repo.ts**：pendingClause 的 EXISTS 子查询加
`AND o.status = 'active'`（countPendingSignals / listPendingSignals 单一真相源同步生效）。

### 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/usecases/conversation/signal-router.ts | 修改 | 点火即记账 + status 过滤 + triggerMessageId 透传 |
| src/frameworks/db/conversation/sqlite-dispatch-attempt-repo.ts | 修改 | pendingClause 过滤 dissolved |
| tests/usecases/conversation/signal-router-ledger.test.ts | 修改 | R4 用例（dissolved/失败终态/成功记账/triggerMessageId 断言） |
| docs/features/2026/09/03/F20260903damp-signal-router-loop-damping.md | 新建 | 本文档 |

## 验收结果

### 测试结果

- tsc --noEmit 干净；eslint 0 error（改动文件）
- 全量 228 files / 2827 tests 通过（新增 R4 四用例 + dissolved 守卫单测）
- R4b 热循环免疫判据：链抛错后跨 2 个去抖重扫周期（160ms），executeChain 恰好
  被调 1 次（旧 bug 形态下同场景 42 秒 614 次）

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 点火必记账 | R4b/R4c/R4d：失败/成功/透传三路径账面有行 | ✅ |
| T2 dissolved 过滤 | R4a：判据 SQL 计数 0 + 路由零点火；单测：getById 返回 dissolved 行被守卫拦截 | ✅ |
| T3 失败不重燃 | R4b：failed 终态后重扫零点火（既有 R3 用例同步保持） | ✅ |

## 设计决策

**为什么路由器预写账而不只是补传 triggerMessageId**：补传参数只是把第七个调用点
补齐，第八个调用点出现时同样的 bug 复活；且链引擎 buildRoster 等前置步骤抛错时
仍无账。路由器在点火原点写账使「点火 ⇒ 账面有行」成为局部可验证的不变量，
链内 INSERT OR REPLACE 覆盖保证幂等。这是把 F20260902sgp2 §4.2「插桩点收敛」
从「写入位置收敛」升级为「写入义务收敛」。

**为什么判据 SQL 和路由守卫都做**：判据 SQL 治本（pending 语义本身排除死目标），
路由守卫治竞态（SQL 求值与 otters 表状态变更之间的窗口）。两层各自独立成立，
符合本仓库「机制约束优先让 LLM 理解」之外的工程兜底分层惯例。

**后续阻尼清单（本 PR 不做，按优先级排期）**——两次事故的结构性教训是
「正确时正确」的判据不够，还需要「错误时不可怕」：

1. 重扫只碰 attempts=0 的行（从未试过 ≠ 失败可重试），同 (message,target) 加
   最小点火间隔——把「无自动重试」从口号变成机制
2. 失败消息写放大上界：同 (message,target) 已有 failed 会话消息则聚合不再重复落
3. 补 R5 回放判据：目标未出生→出生→死亡的 pending 生命周期全链
4. dissolve 事务内 settle 其 pending（生命周期 × 信号账的事务性耦合）
5. yield 目标未解析（点名不存在的獭）时写「跳过」墓碑，消灭追溯 pending 的时间缝隙

**遗留数据清理（需用户拍板后执行，不在本 PR）**：会话 31767a2b 的 614 条 failed
消息与幽灵 otter_sessions 行 4b6eee16 的删留决策。
