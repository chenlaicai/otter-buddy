---
id: F20261006opid
title: 重启窗口期孤儿 invoke 根治：pid 归属判据替换时间戳守卫
type: BugFix
status: implemented
created_at: 2026-10-06
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
causal_links:
  - F20260916b1ea
  - F20260930roiv
summary: invokes 表加 pid 列标记创建进程，孤儿 reconcile 判据从「started_at < bootTs」时间戳守卫升级为 pid 归属（pid 复用场景由时间戳兜底），旧进程晚写入的孤儿不再漏清
---

# F20261006opid 重启窗口期孤儿 invoke 根治：pid 归属判据

## 背景（issue #1241）

9/29 事故：3 个对话左侧栏卡「处理中」。根因是重启窗口期旧进程异步写入的 running invoke 绕过启动 reconcile（`src/bootstrap/database.ts` 只跑一次）。#1244（F20260930roiv）补了 10s 延迟 reconcile + PatrolWorker 1h 兜底，但两者都带 `started_at < bootTs` 时间戳守卫。

**时间戳守卫的结构性盲区**（本单根因）：事故形态中旧进程在新进程 boot 后 ~78s 才落库，`started_at` **晚于** bootTs——10s 补跑被守卫跳过，1h 兜底用同一个 bootTs **永远跳过**，唯一清理路径是下次重启的全量 reconcile。时间戳启发式原理上无法区分「本进程活跃 invoke」和「旧进程晚写入的孤儿」。

## 修复设计

判据从时间戳换为**进程归属**：

1. **schema/migration**：`invokes` 表加 `pid INTEGER` 列（`schema.ts` 新库 DDL + `migration.ts` `ensureInvokesPidColumn` 存量库 ALTER，幂等 PRAGMA 探测，对齐既有补列模式）
2. **写入**：`createInvoke`（send-entry.ts 唯一生产构造点）写 `process.pid`
3. **判定**：`failRunningInvokes` 判据改为 `WHERE status='running' AND (pid IS NULL OR pid != ? OR started_at < ?)`：
   - `pid IS NULL` → 列引入前的存量行（旧世界，启动路径无条件清）
   - `pid != 本进程` → 旧进程遗留（**无论写入时间**——晚写入正是事故形态）
   - `started_at < bootTs` → pid 复用兜底（上代进程恰好复用本 pid 时无法靠 pid 区分，但写入必早于本进程 boot）
   - 三者 **OR**；唯一豁免 = 本 pid 且晚于 boot（本进程活跃 invoke，不误杀）
4. **调用点**：`reconcileRunningInvokes` 签名 `beforeTs?: string` → `guard?: FailRunningInvokesGuard`；10s 补跑与 1h 兜底统一经 `buildInvokeOrphanGuard()` 构造 `{excludePid: process.pid, beforeTs: boot时刻}`；启动路径不传 guard（全量清理，进程刚起库里任何 running 都不可能属于本进程）
5. **实体防呆**：`Invoke.pid` 设计为**必填** `number | null` 而非可选字段——新增构造点漏写会编译报错（若可选，漏写无编译错误，运行时 NULL 被启动 reconcile 误杀）

### 实现中抓到的设计缺陷（AND→OR）

初版把 `excludePid` 与 `beforeTs` 写成 AND 叠加——失败固化用例当场打回：事故形态（pid≠本pid ✓ 但 started_at>bootTs ✗）AND 起来永远不清理，等于没修。改为 OR 后 6/6 绿。这正是「先写失败用例再实现」流程的价值锚点。

## 设计取舍

**机制分级判定**（troubleshooting 修法决策树）：命中「新增持久化存储（DB 字段）」清单项，经论证定为**①既有语义内修（narrow-fix）**——reconcile 机制自 F20260916b1ea 即存在，本次是把其判据从时间戳启发式补全为进程归属（缺啥补啥）：pid 列是既有判据的数据承载而非新机制行为面，且净删除旧 bootTs 判据分支与 database.ts 死代码副本。

**与 #905（epoch 世代架构）的关系**：pid 列是同族第 4 处「旧世界识别」防御，但形态不同（DB 持久层归属标记 vs SimpleLockManager/恢复队列等进程内组件运行时防御），统一 epoch 重构仍等 #905 自己的触发条件，不在本单扩面。

**顺手清理**（同域小项）：删 `database.ts` 尾部 `setupDelayedReconcile` 死代码副本（结构性拆分残留，app.ts 实际 import 自 invoke-reconcile.ts）。

## 测试

- **失败固化**：`tests/bootstrap/invoke-pid-reconcile.test.ts` 6 用例在未修复基线全红（`table invokes has no column named pid`），修复后 6/6 绿。核心用例：9/29 事故形态（duty 构造后晚写入、无 pid）经 `duty.run()` 清理——旧判据下该用例红、新判据下绿
- **既有测试改造**：`delayed-reconcile.test.ts` 防误杀用例按新判据语义重写（原用例插无 pid 行，新判据下 NULL 属旧世界会被清；改为「本 pid 且晚于 boot 不误杀」），5/5 绿
- **全量**：4736/4736 + tsc 0 + eslint 0
- **真启动（生产副本）**：1GB 生产 DB `.backup` 副本接入 alpha 隔离实例两轮验证——
  - 轮 1：迁移日志 `Added pid column to invokes table (#1241)`；副本中 2 条真实孤儿（切 glm 重启时旧进程晚写入，NULL pid running，05:43/05:57）被清为 failed；新 invoke 写入 pid=53795 与进程一致
  - 轮 2（重启）：旧 pid=53795 的 2 条 running 被新进程 54441 启动 reconcile 清为 failed（日志 `Reconciled running invokes on restart: 2 marked failed`）；新进程自己的 invoke 带 pid=54441 正常 running 不误杀

## 已知边界

- 本 pid 卡死的 running invoke（进程活着但 invoke 永不结束）不在本判据范围——与 #1244 时代语义一致，属 #905 故障模型议题
- `getInvokes` 等 API 投影不透出 pid（内部运维字段，前端无消费点）
