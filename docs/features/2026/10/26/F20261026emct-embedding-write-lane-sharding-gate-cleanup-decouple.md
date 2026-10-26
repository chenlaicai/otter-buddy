---
id: F20261026emct
title: embedding 写路径治本——分片闸门全局不变量 + 垃圾出清 + 启动解耦 + worker IPC 兜底
summary: '2026-10-23 巨批雪崩是 embedding 写路径第 6 次复发（前 6 轮修复逐条堵具体路径，缺「write lane 在飞文本总量有硬上界」的全局不变量）。本特性四件套治本：A. embedBatch 入口分片闸门（单批 token 预算 8192 硬上界，超限拆子批串行，所有生产者经唯一收口点自动受控）；B. 垃圾出清（enqueueRetry 前置校验断绝 1646 条 entry-deleted 幽灵任务产生源 + scanDarkEntries 迁移收窄 + 一次性清理脚本出清存量）；C. 启动解耦（document sync / 暗化迁移 / retry worker 延后到 HTTP listen 后异步执行，health 30s 无响应触发重启死循环不再可能）；D. worker IPC EPIPE 兜底（process.send 抛错时受控 exit(1) 而非 uncaught 崩溃，补 F20261015kill 隔离没盖住的 send 路径）。'
change_type: fix
capability_test: "n/a: 纯软件边界内的代码逻辑改动（A 类，闸门/队列/启动序/IPC 防护），无 LLM 参与行为"
modules: [embedding, memory, bootstrap]
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
causal_links:
  - F20261013ebps（#1465 背压——管 in-flight「请求数」不管单批「文本量」，巨批独占唯一槽位它拦不住；本特性在其上层补体量维度）
  - F20261016ebrt（#1521 双 lane + 慢≠死——写 lane 与读 lane 分离后写 lane 吞吐放开，巨批失去最后的隐性约束；本特性给写 lane 上硬上界）
  - F20261015kill（#1520 SIGKILL 进程隔离——盖住了 terminate/崩溃路径，没盖住 process.send 的 EPIPE；本特性 D 项补齐）
  - F20261020slvg（#1521b 诚实准入 + 看门狗——「超时≠取消」语义修正 + 无进展判定；本特性 A 闸门使其面对的批从「无限大」变「有界」，看门狗触发概率大幅下降）
  - F20260812mrcq（embedding_tasks 重试队列引入——scanDarkEntries(true) 全量 re-enqueue 含 dead 的设计在本特性 B 项收窄）
related_issues: []
---

# embedding 写路径治本：分片闸门 + 垃圾出清 + 启动解耦 + IPC 兜底

## 事故与根因（第 7 次修复为什么与前 6 次不同）

2026-10-23 雪崩现场（排查报告：investigation-embed-avalanche-20261023.md）：

| 现场证据 | 数值 |
|---|---|
| 巨批 embed 请求 | 49 条 × ~6k chars（截断后仍巨）一把塞进 write lane |
| 幽灵任务 | embedding_tasks 里 last_error='entry deleted' 1646 条（claim 永远空转） |
| dead 任务不收敛 | 686 条 dead 越滚越大（每次启动 scanDarkEntries(true) 复活重灌） |
| 启动死循环 | syncDocuments + 暗化迁移堵 buildApp 内 listen 之前，health 30s 无响应 → 外部重启 → 重扫 → 再超时 |

**根因（大獭排查结论，本特性直接承接）**：前 6 轮修复堵单个生产者/单路径——背压管请求数、双 lane 分流、进程隔离防崩溃、诚实准入防无限重算——但没有任何一层建立「write lane 任意时刻在飞 embedding 文本总量 ≤ 硬上界」的全局不变量。新路径（replaceChunksBySource 全量 embedBatch）引入即换形态复发。

**修法决策树定位：④ 新增机制（分片闸门）**。机制识别检查点命中「新增配置字段（OTTER_EMBED_BATCH_TOKEN_BUDGET）+ 新增决策分支（超预算拆分）」。①②③为何不行：既有机制的语义内修（背压/超时/看门狗）管的是「数量」与「时长」，无一能约束「单次提交的文本体量」——巨批是合法的 1 个请求、1 个槽位、120s 预算内可能真算得完，全部既有约束对它放行；收窄既有机制管辖边界（如把 batch 上限塞进 store-memory）则每个新生产者都要重新记得设限，第 6 轮就是这么漏的。闸门必须在所有生产者共用的唯一收口点（EmbeddingServiceImpl.embedBatch）。

### 机制预算四问（作者当场作答）

- **① 谁需要它**：write lane 的稳定性需要——具体是所有 embedding 生产者（store-memory fire-and-forget、replaceChunksBySource、syncDocuments 回填、retry worker、启动迁移）的共同下游；不需要它的是任何单一调用方（它们各自都合法，合起来失控）。
- **② 失败后果**：闸门误拆（预算过小）→ 吞吐下降、warn 日志增多，结果仍正确（保序拼接不变量）；闸门失效（预算过大）→ 回到 10-23 雪崩形态。非对称：宁可偏小。
- **③ 维护成本**：一个纯函数模块（embed-batch-sharding.ts，120 行含注释）+ service 入口 3 行接线，无新增常驻进程/定时器/存储结构；环境变量逃生口与 OTTER_EMBED_INTRA_OP_THREADS 同模式（紧急调参不进 config schema）。
- **④ 谁来验证**：单测（splitBatchByTokenBudget 12 例 + service 层真 fork mock worker 验证拆批后保序拼接）；生产观测经既有 logger.warn（action=embed_batch_sharded）与 vecCoverage。预算值本身无理论最优——8192 ≈ 16 条 512-token chunk 是 bge-m3 经验值的保守选择，靠 warn 日志频度校准。

## A. embedBatch 分片闸门（治本核心）

**不变量（写进代码注释 embed-batch-sharding.ts 模块头）**：

> write lane 任意时刻在飞 embedding 文本总量 ≤ 硬上界（token 预算）

- 位置：`EmbeddingServiceImpl.embedBatch` 入口（src/frameworks/embedding/embedding-service.ts）——所有批量生产者共用的唯一收口点，调用方零改动自动受控；单条入口 `embed()` 同受闸门（delta 处置：超预算单条直接 reject，见「设计取舍」）
- 预算：默认 8192 tokens（≈16 条 512-token chunk），`OTTER_EMBED_BATCH_TOKEN_BUDGET` 可覆盖；非法值 warn 后回落默认（不静默，对齐 #1107 防钳制失效不可见纪律）
- 估算：CJK ~1 char/token + 其余 ~4 chars/token（delta 复审修正：首版 chars/2 对中文低估约 2×，拆晚侧危险方向；口径与 store-memory EMBED_MAX_CHARS=6000 的 token 模型对齐）——预算闸门宁可早拆不可晚拆，精确 tokenizer 对体量上界无增量价值
- 拆分：贪心装箱，**保序不变量**（子批拼接与输入完全一致——闸门只改「怎么送」不改「送什么」）；单条超预算豁免单独成批（拆文本破坏语义，单条路径有 store-memory 6k 截断 + 超时兜底）
- 子批间串行：await 前一子批完成才发下一个；MAX_IN_FLIGHT=1 下天然不堆在飞文本量
- 对外语义不变：调用方拿到全部文本的结果（保序），超时/错误以整批为单位 reject——fireAndForgetEmbedBatch 的 fallback 无需感知分片；**salvage 例外**（delta 复审修正）：子批 opts 经 `wrapOptsForShard` 按偏移量包装，晚到结果携带 `(embeddings, startIndex)`，调用方按 startIndex 对位写入——首版原样透传会在 offset>0 的子批晚到时把别批向量存到错误 entry（静默 vec 污染，检视獭独立发现，契约同步改 EmbedBatchCallOptions.salvage）

## B. 垃圾出清（断源 + 收窄 + 出清存量）

1. **断源**：`enqueueRetry` 前置校验（embedding-task-queue.ts）——entry 不存在或 content 空白 → no-op 不入队。race 窗口（fire-and-forget 失败回返时 entry 已被下一轮 replace 删除）产生的幽灵任务从源头消失。闸门在共用入口而非各调用方：所有入队路径一处拦截全覆盖。
2. **收窄迁移**：启动迁移 `scanDarkEntries(true)` → `(false)`（bootstrap/memory.ts:183）——dead 是独立判定的终态，复活它只会把死信重新灌回队列（686 条 dead 不收敛的成因之一）；`scanDarkEntries` SQL 层排除 entry 已删任务（ghostFilter）；`resetPendingAttempts` 注释显式锁定「只赦免 pending」语义（防未来误改带 dead）。迁移分批限流：每 100 条 setImmediate 让出事件循环（better-sqlite3 同步堵点分片）。
3. **出清存量**：`scripts/cleanup-embedding-ghosts.mjs`（dry-run 默认 + `--apply` 才真删 + 删前自动备份）——**主仓 data/ 是运行时数据，海獭不直接改删，脚本由搭档人工执行**。删除口径（delta 复审修正）：真定义「entry NOT EXISTS」全删（检视獭 DB 实测：代理口径 last_error='entry deleted' 之外的孤儿 129 条，含 98 条 10-23 巨批超时残骸 'batch timeout (49 texts)'——代理口径外孤儿会被 claim 打上 entry-deleted 后 3 次 dead 永久滞留，出清不完整）；安全前提：停机运行，replaceEntriesBySource 同 id 回插是同步事务不落盘中间态。

## C. 启动解耦（listen/health 先行）

- `buildApp` 不再 await syncDocuments + createAndStartRetryWorker——改为返回 `postListenInit` 回调，main.ts 在 listen 成功后 fire-and-forget
- 失败不炸进程：sync/迁移失败只落 error 日志（listen 后失败不该拖垮已就绪的 HTTP 服务）
- vec 版本校验 / 模型加载等重开销仍在 buildApp 内（listen 前完成，避免带着未就绪的 embedding 服务接流量）
- retryWorker 经 `retryWorkerRef` 闭包延迟绑定：PatrolWorker duty 动态查 ref（worker 未就绪时空转，就绪后自动接管）；dispose 幂等停表；BuiltApp 暴露 getter 兼容存量访问
- postSyncMigrations 随 syncResult 一并延后（它消费 sync 结果）

## D. worker IPC EPIPE 兜底（对症）

- `bge-m3-worker.ts` 的 `post()` 裸 `process.send` → 改为 `postResponse()`（新模块 embedding-worker-ipc.ts）
- send 抛错（IPC 已关，父进程死亡/disconnect 竞态）→ warn 一条受控日志 + `process.exit(1)` 自我了断——父进程把 exit 当意外退出处理（reject pending + 重建），不留半死 worker
- send 返回 false（背压）→ 不是错误，正常返回
- 独立模块原因：worker 文件是 fork 入口（顶层加载模型 + 无 process.send 即 throw），vitest 无法 import；拆出后零副作用可单测

## 设计取舍

- **闸门为何放在 service 层而非 store-memory 层**：后者只是生产者之一（replaceChunksBySource / retry worker / 回填都绕过它），第 6 轮复发正是「逐个生产者堵」的失败模式。service 层 embedBatch 是所有生产者共用的唯一收口点。
- **为何 chars/2 粗算而非 tokenizer**：闸门约束的是体量上界，不是精确计费——保守早拆无害（结果不变），精确化徒增依赖与 CPU。bge-m3 tokenizer 加载本身是重开销。
- **为何单条超预算豁免而非拒收（embedBatch）但 embed() 拒收（delta 补充）**：batch 内单条巨文本拆文本破坏 chunk 语义，且可能是合法多元素混合批——豁免单独成批 + 既有兜底链（截断/超时/dead 终态）；embed() 单条入口无「批内豁免」语义，透传巨文本 = 靠调用方截断纪律（正是前 6 轮失败模式），delta 处置后直接 reject 超预算单条（真巨文本应先截断，store-memory/retry-worker 6000 chars 已做；search-memory 查询路径的 reject 走既有 FTS5 降级 catch，行为合理）——不变量「任何调用方都无法把超预算文本量送进 write lane」由此完整成立。
- **为何 postListenInit 而非「后台线程做 sync」**：better-sqlite3 同步 API 无法移线程；分批 yield + listen 先行已消除「health 无响应触发重启死循环」（10-23 的核心形态）。sync 期间 health 可能短暂延迟（事件循环分片间隙），但 listen 已完成、外部探活不再 30s 超时。
- **启动迁移 excludeDead 后，真正的 dead（entry 存活但 3 次嵌入失败）谁来救**：答案是不救——dead 是判定终态（真不可嵌入），复活路径是人工排查（scanDarkEntries(true) 运维接口保留）+ 修 content 后重新入库，不是自动重试。这是有意收窄：686 条 dead 不收敛的教训正是「自动复活」在垃圾任务上空转。

## 测试

| 测试 | 文件 | 覆盖 |
|---|---|---|
| 分片纯函数与包装器 16 例 | tests/frameworks/embedding/embed-batch-sharding.test.ts | 保序不变量 / 预算边界（恰不拆、超 1 拆）/ 单条豁免 / 异构体量 / 10-23 雪崩形态（49 条中文 6k chars 巨批拆 1 条/批，CJK 1:1 口径）/ budget<1 防御 / env 解析（非法回落）/ **wrapOptsForShard 偏移注入 4 例（delta）** |
| service 层分片行为 2 例 | 同上 | 真 fork mock worker：超预算拆多次 embed-batch 请求 + 结果保序拼接调用方无感；空数组短路 |
| IPC 防护 3 例 | tests/frameworks/embedding/embedding-worker-ipc.test.ts | send 正常不退出 / 抛 EPIPE → exit(1) / 返回 false（背压）不退出 |
| 队列垃圾出清 8 例 | tests/frameworks/db/memory/embedding-task-gate.test.ts | enqueueRetry 前置校验（不存在/空白/空串 no-op，正常入队，ON CONFLICT 复活保留）/ purge+count 真定义口径（delta：entry NOT EXISTS 全删含巨批残骸）/ resetPendingAttempts 只赦 pending |
| 清理脚本 2 例 | tests/scripts/cleanup-embedding-ghosts.test.ts | dry-run 只报告（含巨批残骸形态断言）/ --apply 删孤儿（entry 存活保留）+ 自动备份 |
| 启动解耦 1 例（delta） | tests/app/build-app.test.ts | postListenInit 幂等可调不炸 / health 先行不变量 / ref 延迟绑定机制 |

受影响面回归：tests/frameworks/embedding + tests/frameworks/db/memory + tests/usecases/memory + tests/app + 新增脚本测试 = **302/302 全绿**；tsc --noEmit 零错；eslint 零错。

## 对抗审视与 delta 处置（F20261026emct 审视循环）

首审（检视獭-emct，异模型）：结论「需要修改」，2 严重 + 6 建议。处置结果：

| 发现 | 处置 |
|---|---|
| 严重 1 分片×salvage 契约错位（静默 vec 污染） | **已修**：契约改 `salvage(embeddings, startIndex?)`（embedding-gateway.ts），service 层 wrapOptsForShard 按子批 offset 包装，store-memory 按 startIndex 对位写入（越界 skip + warn）；4 例单测 |
| 严重 2 commit 缺 Modification-Class 声明 | **已修**：amend 补 `Modification-Class: mechanism-addition` |
| 建议 1 清理脚本口径缺口（129 条孤儿含 98 条巨批残骸） | **已修**：脚本与 purgeGhostTasks 改真定义口径（entry NOT EXISTS 全删），测试同步 |
| 建议 2 C 项零测试 | **已修**：build-app.test.ts 补 postListenInit 行为断言 1 例 |
| 建议 3 retryWorkerRef 空转无告警 | **已修**：patrol duty 限频 warn（1h 最多一条，action=embedding_retry_worker_missing） |
| 建议 4 chars/2 中文低估 2× | **已修**：CJK 敏感估算（CJK 1:1 + 其余 /4），注释与 store-memory token 模型对齐，雪崩形态测试改中文真实口径 |
| 建议 5 embed() 无收口闸 | **已修**：embed() 入口加同款预算守卫（超限 reject），不变量完整成立 |
| 建议 6 测试数字不实（30 实为 27）+ disable 未申报 + 拆文件无锚点 | **已修**：数字订正（delta 后全量 302）+ PR body 申报三处 eslint-disable 带理由 + 拆文件承诺改为「不立案，合入后由 lint 棘轮与后续重构自然约束」（R2 Issue=承诺纪律：无排期不立案） |
| 焦点 1 闸门唯一性部分推翻 | 已由建议 5 处置覆盖（embed() 补闸） |
| 焦点 3 B 项爆炸半径推翻（686 dead 全幽灵真 dead=0） | 无需处置（实测证据采信，收窄无伤害） |

## 验证

- [x] 单测全绿（302/302，含新增 32 例与 delta 复审修正）
- [x] tsc / eslint 干净（三处 eslint-disable 均带理由：embedding-service.ts 文件级 max-lines + embed 方法级、app.ts 文件级）
- [x] 保序不变量在纯函数与 service 层双重断言
- [ ] 清理脚本由搭档在主仓 data/ 人工执行：`node scripts/cleanup-embedding-ghosts.mjs`（先 dry-run 看报告，确认后 `--apply`）
- [ ] 上线后观察：logger warn `embed_batch_sharded` 频度（预期仅巨批场景出现）、embedding_tasks 总量收敛、启动日志顺序（listen 先于 Migrating dark entries）

## 后续动作

- 清理脚本执行（搭档人工，dry-run 先行）→ 按真定义口径出清存量孤儿（预计 ~1880 条，含 98 条巨批残骸）
- 观察一周 embedding_tasks 收敛情况；若 dead 仍有净增长，排查新形态（本特性已排除已知的两大产生源）
- embedding-service.ts / app.ts 超限行数已加 eslint-disable 带理由；拆文件不单独立案（无排期不立案，R2 Issue=承诺纪律），由后续重构自然约束
