---
id: F20260902sgp2
title: '信号协议 v2：派发台账语义——信号路由器重设计（含游标 seq 迁移与 turn 退役合流）'
doc_type: feature
summary: |
  P1 回滚（F20260902rbsg）后的信号协议重设计。核心语义：pending := 已投递 ∧ 无派发记录，
  消费由派发尝试记账（链引擎插桩），无自动重试无孤儿扫描，游标回归上下文注入本职。
  分段迁移 S1（记账铺轨）→S2（路由器重挂）→S3/S4（入口全量换轨 + turn 退役），
  每段独立可回滚。三条事故回放判据 R1-R3 贯穿验收。
status: final
change_type: feature
tags: [signal-protocol, dispatch-ledger, incident-response, cursor-migration, turn-retirement]
modules: [src/usecases/conversation/, src/frameworks/db/, src/bootstrap/]
capability_test: "n/a: 后端记账面变更（A 类），无 prompt/软代码改动；行为由 10 例真实仓储集成测试覆盖（tests/frameworks/db/dispatch-attempt-repo.test.ts）"
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
causal_links:
  from:
    - F20260901sgpx   # 母方案（P0-P4 迁移路径）
    - F20260901sgpv   # P1 路由器（已回滚，类保留作参考实现）
    - F20260902rbsg   # 回滚事故根因分析（本设计的直接输入）
    - F20260902uspr   # 投影哑火事故（mock 接缝教训）
---

# F20260902sgp2: 信号协议 v2 —— 派发台账语义

## 0. 搭档硬约束（最高优先级验收标准）

1. **合入不影响系统正常运行**——重启即崩/全入口哑火 = 红线。#700/#710 两起事故的教训全部前置：
   装配级灰度（可选注入，出问题摘装配即回滚）+ 真实仓储集成测试先行（mock 与真实投影的分歧两次酿祸，
   mock 测试再绿不算数）+ 存量会话回放演练
2. **外部 agent 可排查**——信号决策路径日志自描述：pending 判定、销账、点火每一跳都有带上下文的日志行，
   不认识本系统的 agent 看日志也能还原「为什么这只獭被点燃」（§4.6）
3. （隐含）存量库兼容——128 个存量会话回放 R1-R3 全部正确

## 1. 背景

事故链：sgpx 母方案把「未读游标」当作行动义务真相源（取舍表第一条）→ sgpv P1 实现 →
上线当日两起事故（uspr 投影哑火 + rbsg 存量批量点火 126 invoke/19 会话）→ 回滚。
根因（rbsg §根因分析）：「未读 ≠ 待行动」——游标是上下文注入账本，允许永久滞后；
行动义务需要独立记账。本设计给出 v2 语义与迁移路径。

## 2. 核心语义（v2）

**pending := 消息已投递（status=completed ∧ talkingStonePassedTo 含 active otter 目标 T ∧ 非 otter 自指）
∧ dispatch_attempts 表无该 (message_id, T) 记录**

> **S4a 修订（09-03，搭档模型对齐「消息就是消息，tsp 才是触发信号」）**：
> 原 `sender≠system` 条件已删除——行动类 system 消息（scheduler 任务/招聘桥接）与其他消息
> 同一语义进闸门体系；纯通知类 system 消息无 tsp，天然落在判据之外无需排除。
> 自指排除精确化为仅 otter 发言者（system senderId 是技术归属非语义发言者）。
> 另见 scheduler senderId 修正：任务消息 senderId 归属 'system'（不偷目标獭）。

- **消费 = 派发尝试记账**：链引擎每次为目标 T 执行派发时写/更新一条 attempt 记录，
  发起即销账（in_progress 即非 pending），成败皆终态
- **无自动重试、无孤儿扫描器**：failed = 终态翻篇。唯一再点火路径 = 用户手动 retry
  （同 (message,target) 行覆盖，source='retry'）。rbsg 事故的「债务永存」与 sgpv 补扫的
  全量重燃在语义层不存在——最安全的竞态是根本不存在的竞态
- **游标回归唯一本职**：上下文注入进度账本（buildMessageWithContext），不参与任何点火决策

### 事故回放判据（设计必须逐条通过，验收固化为测试）

| # | 场景 | 旧语义（游标）结果 | v2 结果 | 依据 |
|---|------|------------------|---------|------|
| R1 | 崩溃窗口：消息落库后进程死，无人应答 | 误（该补但连存量一起误点）| **合法 pending，重启补扫点火** | 无 attempt 记录 |
| R2 | 多獭稳态滞后：历史点名未接、游标永久未推进 | 误判 pending（事故主因）| **非 pending** | S1 切换时 backfill 墓碑已记 legacy-attempted；此后每条投递即记账 |
| R3 | abort / failed 翻篇 | 债务永存，反复重燃 | **非 pending** | attempt 记录终态，无重试引擎 |

## 3. 现状碎片盘点（勘测结论，2026-09-02）

| 碎片 | 勘测结论 | 可复用性 |
|------|---------|---------|
| 「派工台账」F20260821i336 | **非表**：otter_context KV 里的 `dispatch:{id}` JSON 记事本（bootstrap/clients.ts:230-300 手写解析），任务粒度、SQL 不可查 | ❌ 不可复用（rbsg 文档「碎片可复用」系高估）|
| message_events | 流式事件域（schema.ts:149-160，tool_result/assistant_text 等）| ❌ 语义不同 |
| signal-router.ts（已摘除）| 类 + 9 单测保留，装配恢复点 app.ts:288-293 注释块 | ✅ 参考实现（档位矩阵/busyQueue/去抖可回收）|
| executeChain | dispatch-chain-engine.ts:76-86——**params 不含 messageId**，记账需加传 triggerMessageId | ✅ 插桩点（§4.2）|
| conversations.status | 有列有索引（schema.ts:86,idx:96）| ✅ pending 过滤直接用 |

## 4. 方案设计

### 4.1 数据模型（新表，S1 落地）

```sql
CREATE TABLE IF NOT EXISTS dispatch_attempts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,          -- 冗余，扫查效率
  message_id TEXT NOT NULL,               -- 触发消息（投递物）
  target_otter_id TEXT NOT NULL,          -- 行动义务人
  status TEXT NOT NULL CHECK (status IN ('in_progress','completed','failed','aborted')),
  source TEXT NOT NULL DEFAULT 'chain',   -- chain | router | retry | backfill
  attempt_started_at TEXT NOT NULL DEFAULT (datetime('now')),
  attempt_finished_at TEXT,
  note TEXT,                              -- 失败原因/上下文（外部 agent 可读）
  UNIQUE(message_id, target_otter_id)     -- 一尝试一记录；手动 retry 覆盖同槽位
);
CREATE INDEX IF NOT EXISTS idx_dispatch_attempts_conv ON dispatch_attempts(conversation_id, status);
```

### 4.2 记账插桩点：链引擎（所有入口的必经之路）

`executeChain` params 增加可选 `triggerMessageId`；invoke 每个目标 T 时：
- 起跑写 `in_progress`（INSERT OR REPLACE——幂等，重跑同 (message,T) 覆盖）
- settle（fulfilled/rejected）更新 `completed/failed` + note

**注记（flash 对撞④）：busyQueue 排队不写 attempt 行**——S2 后 busy 獭的插话入队期间，轨迹显示 ⏳
「排队待消化」的判据恰是「无账」（还没派发）。入队即写行会造出假 in_progress，重启后说谎。
纪律：**入队不写，invoke 起跑才写**。

**为什么插在链引擎而不是路由器**：scheduler/retry 在 S2/S3 仍走直连链，若只有路由器记账，
「直连链已派发过、路由器视为 pending」的双触发窗口存在（mimo 空想稿 S3 发现的真实约束）。
插在链引擎 = **所有入口的每次派发都记账**，台账是全系统唯一账本，双触发在账面上不可能。

### 4.3 v2 路由器 pending 判据（S2 生效）

```sql
SELECT m.id, t.value AS target, m.signal_level ...
FROM messages m, json_each(m.talking_stone_passed_to) t
JOIN conversations c ON c.id = m.conversation_id
WHERE m.conversation_id = ?
  AND m.status = 'completed' AND m.sender_type != 'system'
  AND c.status = 'active'                          -- mimo 空想稿 M2：归档会话不扫
  AND t.value != 'user'                            -- user 无 invoke
  AND t.value != m.sender_id                       -- 自指排除（sgpv signal-router.ts:145-148 语义）
  AND NOT EXISTS (SELECT 1 FROM dispatch_attempts da
                  WHERE da.message_id = m.id AND da.target_otter_id = t.value)
```

「已投递」定义与 #696 轨迹 UI 判据（completed+非 system+tsp 含 otter）单一真相源对齐。

### 4.4 重挂装配与补扫

- **S2 装配恢复**：app.ts:288-293 注释块处恢复 `new SignalRouter`（可选注入降级面不变，摘装配即回滚）
- **stale in_progress 死亡证明（flash 对撞③，S1 起生效）**：进程内不可能有存活的
  in_progress 跨越重启——启动时（补扫之前）一条 UPDATE 把所有 in_progress 行标
  `failed + note='进程重启，派发中断'`。这不是自动重试（不点火），是 R3 翻篇语义对
  账本的收尾。先例：reconcile-orphans.ts:50 `failInFlightMessages(now, "[服务重启，发言中断]")`
  对 stale in-flight 消息同款语义（mimo 锚点核对修正：非 resume-interrupted-service.ts:18）。
  死亡证明标 failed 后该 (message,target) 有终态记录 → 不再 pending → 补扫不点火
  （「一尝试一销账」语义一致：起跑过就翻篇，用户手动 retry 是唯一再点火）。不补则
  v2 僵尸窗口从 v1 的「⏳永挂」换成「⚡永挂」
- **启动补扫**：routeAllPending 换判据为 §4.3 SQL；扫描窗默认 24h（`created_at` 下界，配置项），
  附手动全量重扫 CLI 逃生舱（绕窗，运维工具）——窗内盲区默认接受，但可救（mimo 空想稿 S2 逃生舱思路，采纳）
- **去抖重扫**：sgpv 的 50ms 去抖回收，重扫同样走 §4.3 SQL（有记录即不重燃，yield 环自续燃病根消除）

### 4.5 backfill 墓碑（S1 迁移）

建表迁移时一次性：所有存量已投递消息 × otter 目标 → INSERT `source='backfill', status='completed'`。
效果：**切换瞬间 pending=0**，从零增量积累。R2 的全部存量滞后在墓碑一刀之下，不重演 126 invoke。

### 4.6 日志规范（硬约束 2 的落法）

每次决策一行，字段自描述：`[signal-ledger] action=ignite|skip|record|tombstone conv=… msg=… otter=… reason=… attempt_id=… source=…`。
验收：外部 agent 仅凭日志能回答「这只獭为何被点燃/为何跳过」。

### 4.7 轨迹 UI 判据切换（S1b，小 PR）

#696 的 CONSUMED 判据从游标比较切到 dispatch_attempts。**状态盒扩为四态**（flash 对撞①：
v1 枚举仅 PENDING/CONSUMING/CONSUMED 三态（signal-trail.ts:18），failed/aborted 落进
CONSUMED = 撒谎，直接掏空取舍 #2「用户决定是否 retry」——R3 的 UI 面断头）：

| attempt status | UI 态 |
|---|---|
| 无记录 | ⏳ PENDING 排队待消化 |
| in_progress | ⚡ CONSUMING 处理中 |
| completed | ✓ CONSUMED 已处理 |
| failed / aborted | ❌ FAILED 处理失败（title 显 attempt.note） |

**用户可见改善（S1b 验收对照，flash 对撞②）**：① 多獭会话「永远排队」徽标痊愈（游标滞后
不再冒充 pending）；② v1 的 5min 墙钟窗状态倒退缺陷消除（ACTIVE_WINDOW_MS 超窗后
⚡→⏳ 倒退；v2 in_progress 是持久行，无窗无倒退，重启后依然正确）；③ 失败首次可见
（❌ + 原因），手动 retry 的入口在 UI 层闭合。

## 5. 测试策略

1. **真实仓储集成测试先行**（rbsg 教训）：SQLite 真库 + 真投影，禁 mock conversationRepo 于信号判据路径
2. R1-R3 固化为集成测试：R1 崩溃窗口补扫点火 / R2 backfill 后多獭滞后零误点 / R3 failed 后零重燃
3. 双触发：scheduler 直连 + 路由器并发同 (message,target) → 单 attempt 记录 + per-otter 锁串行
4. 存量演练：导出生产库结构 + 128 会话样本数据回放，断言切换后 pending 计数 = 0
5. 日志断言：关键路径日志行存在且字段完整

## 6. 取舍表

| # | 决策 | 取 | 舍 | 理由 |
|---|------|----|----|------|
| 1 | 真相源载体 | 新表 dispatch_attempts | 复用 KV 派工台账 / message_events | KV 记事本 SQL 不可查任务粒度；新表 UNIQUE 约束直接表达「一尝试一销账」 |
| 2 | 重试 | 无自动重试，仅手动 | 指数退避 + 孤儿扫描 | rbsg 根因之一是债务永存；无重试则孤儿竞态/退避参数/永久循环三类问题不存在；失败可见性由台账+UI FAILED 态保证（§4.7 四态），用户决定是否 retry；stale in_progress 由启动死亡证明翻篇（§4.4） |
| 3 | 存量处理 | backfill 墓碑一刀切 | 上线时逐条判活 | 逐条判活=重演 rbsg 误判面；pending=0 起步信任从零积累，崩溃窗口内新消息由补扫窗兜住 |
| 4 | 插桩点 | 链引擎（全入口必经）| 路由器内部 | 全入口统一记账，杜绝双触发账面歧义 |
| 5 | 补扫窗 | 24h 默认 + 配置 + CLI 全量逃生舱 | 无窗全量 | 无窗=每次启动全历史反连接；有窗有盲区但可救 |
| 6 | turn 退役 | 并入本设计 S4（游标 seq 双写迁移）| 维持母方案独立 P4 | 游标卸掉行动义务后仅剩注入本职，seq 迁移是其自然延伸；写路径一次动刀 |
| 7 | UI 判据切换 | S1b 独立小 PR | 捆进 S1 | 缩小爆炸半径（硬约束 1），独立回滚 |

## 7. 迁移路径（分段 PR，每段独立可验证可回滚）

| 段 | 内容 | 行为变化 | 回滚面 |
|----|------|---------|--------|
| S1 | 建表 + backfill 墓碑 + 链引擎插桩（triggerMessageId 参数 + attempt 记录）+ 观测端点（GET pending 计数）| **零**（纯记账，全部入口仍直连链）| 表留存无害，插桩 try/catch 失败仅日志 |
| S1b | 轨迹 UI 判据切台账 | 徽标语义修正（排队徽标痊愈）| UI 层小 PR 直接 revert |
| S2 | 路由器重挂（§4.3 判据）+ web/IM 入口换轨 + 启动补扫换判据 | web/IM 由路由器点火；scheduler/retry 仍直连（已记账）| **摘装配即回滚**（app.ts 一处，sgpv 降级面）|
| S3 | retry 入口换轨（覆盖 attempt 行 source=retry）| retry 走路由器 | 同 S2 装配开关 + 入口开关 |
| S4 | scheduler 换轨 + 看门狗语义迁移（判据：attempt 终态 + 持续产出）+ 游标 seq 双写迁移 + turn 写路径拆除评估 | 定时任务走台账；游标刻度换代 | seq 双写期间旧列保留，回滚=读旧列 |

S1 合入后观察窗口：观测端点确认「直连链记账无遗漏」（每个正常 dispatch 都有对应 attempt 记录）
且 pending 计数仅随真实未答消息增长——跑稳后才推 S2。

## 8. 开放问题（对撞输入）

1. S2 补扫窗内，同会话多目标部分在窗部分在墓碑区的边界（理论存在，实操罕见——窗 24h 远大于墓碑时刻）
2. attempt 行覆盖式 retry 丢失历史 vs append-only：**已决（flash 对撞⑤折中）**——覆盖槽位保留
   UNIQUE 约束（「一尝试一销账」机械表达），覆盖前把旧行终态压缩进新行 note
   （`retry#2; prev=failed: tool timeout 10:32`）。历史保全全貌、表结构不动、pending 反连接
   SQL 不变。保全动机：硬约束 2（外部 agent 可排查）——attempt 历史是排查线索
3. flash 提案 K2（收件箱预告前缀）与 K3（SSE 生命周期改 attempt 终态驱动）**均归 S2**：
   v2 下 K2 的「N 条待消化」= pending SQL 现成计数（HALT 在队首时前缀注明）；K3 挂
   attempt 行终态比 v1 提案的「信号终态」更可操作

## 9. S1 实现记录（2026-09-02）

### 变更清单

| 文件 | 操作 | 内容 |
|------|------|------|
| src/entities/conversation/dispatch-attempt.ts | 新建 | 实体 + DispatchAttemptRepo 端口 |
| src/frameworks/db/conversation/sqlite-dispatch-attempt-repo.ts | 新建 | SQLite 实现（pending 判据 SQL 单一真相源） |
| src/frameworks/db/schema.ts | +1 函数 | createDispatchAttemptsTable（仅登记 initSchema，mgux 教训） |
| src/usecases/conversation/dispatch-chain-engine.ts | 修改 | 可选注入 dispatchAttemptRepo + triggerMessageId 参数 + recordAttemptStart/Settle（抽私有方法） |
| src/bootstrap/{repositories,types,platforms,database}.ts | 修改 | repo 注册 + 链引擎注入 + postInit 启动任务（死亡证明→墓碑→pending 计数日志） |
| message-controller / agent-dispatch-service / scheduler / resume / recruit | 修改 | 六处 executeChain 调用传 triggerMessageId |
| tests/frameworks/db/dispatch-attempt-repo.test.ts | 新建 | 真实仓储集成 10 用例（禁 mock 判据路径） |

### 行为声明（硬约束 1）

**S1 合入后系统行为零变化**：所有入口仍走直连链（#710 回滚基线）；台账纯记账；
记账失败仅日志（双层 try/catch：recordAttemptStart/Settle 内层 + 调用点外层）；
dispatchAttemptRepo 不注入时链引擎行为与 sgpv 前完全一致（可选依赖）。
启动新增三条 [signal-ledger] 日志（死亡证明计数/墓碑计数/pending 计数）。

### 验证

- 后端 220 files / 2786 tests 全绿（新增 10 集成用例：R1/R2/R3 回放 + 记账链路 + 幂等 + 归档/幽灵守卫）
- tsc --noEmit 干净；eslint 0 error（platforms.ts 451>450 用 tool-factory 同款 file-level disable + 注释锚定原因）
- 最简实现检查：已过——无新框架无新依赖，一张表 + 一个 repo + 链引擎可选插桩；
  拒绝了更重的方案（复用 KV 台账/message_events 均证伪，见 §6 取舍 #1）

### 观察窗口（S1→S2 门禁）

合入后观察：① 每次正常 dispatch 都有对应 [signal-ledger] action=record 日志；
② pending 计数仅随真实未答消息增长；③ 死亡证明计数正常重启时为 0。
跑稳后推 S1b（轨迹 UI 判据切换）→ S2（路由器重挂）。
