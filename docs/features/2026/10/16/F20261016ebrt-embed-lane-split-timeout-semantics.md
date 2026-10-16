---
id: F20261016ebrt
title: embedding 读写双 lane 隔离 + 超时语义收窄（慢≠死）+ 回填泄洪——根治「处理堵死读」与「超时自杀」
summary: 一条串行管道同时跑查询/写入/回填，处理直接把读排队拖死；batch 超时 1s/条把慢误判成死触发自愈杀 worker。改 query/write 双进程 lane（各自串行，互不排队）；超时只杀「整代零成功」的真死锁，慢批只 reject；超时不算 dead-letter；retry BATCH_LIMIT 10→50 + drain 循环（1000 积压 4 天→数小时）。
change_type: fix
capability_test: "tests/frameworks/embedding/embedding-service.test.ts + tests/usecases/memory/embedding-retry-worker.test.ts（+5 用例：慢≠死、真死锁逃生、双 lane 隔离、超时不算 dead-letter、普通错误仍 dead-letter；存量全过 38/38）"
modules: [embedding, memory]
created_in_conversation: a817159e-ad26-4ede-844a-8a70889f4f98
causal_links:
  - F20261015kill（#1520 进程隔离——terminate→SIGKILL，本特性在其上分 lane + 收窄超时语义）
  - F20261015selfheal（#1493 自愈兜底——引入超时→杀 worker，但 1s/条预算把慢当死；本特性收窄判定）
  - F20261013ebps（#1465 淹没背压——MAX_IN_FLIGHT=1 串行化是原生约束，本特性补上「串行≠共用队列」）
related_issues: [1453, 1460]
---

# embedding 读写双 lane + 超时语义收窄 + 回填泄洪

## 问题

F20261015kill 修掉「terminate 打死主进程」后，仍有两层结构病：

### 病 A：读写共用一条串行管道（处理堵死读）

onnxruntime 1.23.2 要求 worker 内串行（长文×并发>1 必 lost-wakeup 死锁），`MAX_IN_FLIGHT=1` 是对的。但当时只建了一个 worker，三种负载挤同一条队列：

| 负载 | 延迟要求 | 量级 |
|---|---|---|
| 查询 embed（search_memory） | 人等，要 <1s | 单条短文 |
| 写入 embed（store/sync） | 后台，可慢 | 批量 |
| 积压回填（retry/dark） | 无所谓 | 1000+ 条 |

回填/写入在跑时，查询必须排队——**处理直接影响读**。

### 病 B：超时自杀机制把「慢」当「死」

batch 超时预算 `texts.length × 1s`，而长文（~1000 token/条）实测 1-2s/条 + 高负载（CPU load 3.3-4.0、RSS 6GB）下必超：

- 事故现场：7 条 5464 字预算 7s、9 条 3967 字预算 9s——刚成功 1 条的 worker（`workerEmbedSucceeded: 1`）被误判假死 SIGKILL
- 超时计入 `maxAttempts=3` → dead-letter → **永久暗化**。本该「等等就好」的条目被机制亲手埋掉

### 病 C：回填吞吐失衡

#948 闹钟瘦身把 retry tick 从 30s 调到 1h，却没调 `BATCH_LIMIT=10`——吞吐被打掉 120 倍（1200/时→10/时），1000 积压要 4 天才能吃完。

## 第一性原理结论

```
真问题 A：读写回填共用一条串行队列 → 处理堵死读
真问题 B：超时判定只有墙钟 → 慢被当死杀掉 + dead-letter 埋掉
真问题 C：retry 限速参数失衡 → 积压 4 天
假问题：「模型带宽 < 生产速度」→ 不成立。模型串行下 ~1-4 条/s 够用
```

「超时自杀」本身合理（真死锁唯一逃生通道），错的是判定器把慢也框进死。

## 修复

### 1. 读写双 lane（根修）

`initEmbeddingService` fork **两个独立子进程**，各自加载一份 bge-m3：

```
查询 embed  → query-service  (只服务 search，延迟优先，不排在回填后面)
写入/回填   → write-service  (store + sync + retry，吞吐优先，可放开批量)
              ↑ 各自 MAX_IN_FLIGHT=1（守住 onnxruntime 串行约束）
              ↑ 各自进程隔离（#1520 已做，abort 不带走主进程）
```

- 查询永远不排在回填后面
- 写入 batch 放开了跑不影响交互
- 代价：2 份 bge-m3 ≈ 4.5GB。比「重启时短暂双份 + 泄漏」的 6.4GB 更可控

**为什么必须分进程**：串行是 onnxruntime 原生约束，但「串行」≠「共用一条队列」。同进程内无法把两个串行队列彻底隔离（MAX_IN_FLIGHT=1 是全局槽）。

### 2. 超时语义收窄（慢≠死）

- **batch 预算放宽**：1s/条 → 5s/条，且不低于 30s（对齐单条），上限 120s
- **慢≠死判别**（`restartWorkerIfHung`）：本代 `workerEmbedSucceeded === 0` 才视为真死锁自愈重建；有成功记录说明 worker 活着，只 reject 不杀
- **超时不算 dead-letter**：`EmbedTimeoutError` 不计入 `maxAttempts`，条目保持 pending 按退避重来

| 故障 | 现象 | 动作 |
|---|---|---|
| 真死锁 | 零成功 + 超时 | 杀 worker 重建 ✓ |
| 慢 | 有成功记录 + 超时 | 只 reject 不杀 ✓ |

### 3. 回填泄洪

- `BATCH_LIMIT` 10 → 50（50 条/tick × 1h）
- **drain 循环**：吃满一批立即再 claim，直到队列见底或 `MAX_DRAIN_ROUNDS=20`（1000 条/tick 上限）
- 1000 积压从 4 天 → 数小时

## 设计取舍

- **为什么两个进程而不是优先级队列**：单 worker 内一个长 batch 在途时查询仍要等它算完（onnxruntime 推理不可抢占）。真正的零影响只能物理隔离。
- **为什么超时不 dead-letter**：超时是「这批太慢/worker 暂时忙」，不是「这条坏了」。3 次就埋掉会把可恢复条目永久暗化。真坏条目（内容损坏等）仍走 `maxAttempts=3`。
- **为什么不关掉超时自杀**：真死锁（SpinPause）没有任何其他恢复手段，杀 worker 是唯一逃生通道。只收窄判定条件，不拆机制。
- **#948 的教训**：调「唤醒频率」时必须同步核对「每批处理量」——两个旋钮耦合决定吞吐。

## 不做的事

- **不降级 onnxruntime**：竞态在 ThreadPool，降级无证据收益
- **不做 re-embed 基础设施**：换模型是低频运维事件（记忆规则）
- **不引入 worker 池**：两条 lane 各串行已够用

## 测试

- 存量全过（38/38）：超时自愈、熔断、batch 超时、代际隔离、背压、槽位 FIFO、retry 消费
- **+5 新用例**：
  1. 慢≠死：本代有成功记录时超时只 reject 不杀 worker
  2. 真死锁逃生：本代零成功时超时仍触发自愈重建
  3. 双 lane 隔离：write lane 卡死时 query lane 仍立即返回
  4. 超时不算 dead-letter：EmbedTimeoutError 连续 5 次仍 pending
  5. 普通错误仍 dead-letter：3 次转 dead（保护不变）

## 影响范围

- `src/frameworks/embedding/embedding-service.ts`：双 lane 工厂、`restartWorkerIfHung`、batch 预算 5s/条、`EmbedTimeoutError`
- `src/usecases/memory/embedding-gateway.ts`：+`EmbedTimeoutError`
- `src/usecases/memory/embedding-retry-worker.ts`：BATCH_LIMIT 50、drain 循环、超时跳过 dead-letter
- `src/bootstrap/database.ts` / `src/app.ts`：query/write 双 lane 接线
- `tests/`：+5 用例，存量 mock 适配
- 无配置项变更、无 DB schema 变更、无 API 变更

## 关联

- 上游：F20261015kill / PR #1520（进程隔离）、F20261015selfheal / #1493（超时自愈引入误杀）、#948（retry 吞吐失衡）
- 同家族：F20261013ebps / #1465（淹没背压）、#1453（假死首发）、#1460（RSS 泄漏）
- 事故证据：`.otter-buddy.log` 21:22:01–21:22:13 时序、`Migrating 1000 existing dark entries`、`workerEmbedSucceeded: 1` 仍被杀
