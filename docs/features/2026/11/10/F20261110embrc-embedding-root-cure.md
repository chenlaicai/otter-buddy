---
id: F20261110embrc
title: embedding 子系统根治——通道分离、token 预算调度与进度看门狗
summary: live/backfill 双 lane 物理隔离、token 预算领取、逐条进度看门狗与生产分布混沌验收，消除回填洪峰下实时阻塞和死容量。
change_type: refactor
status: development
created_at: 2026-11-10
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
capability_test: "n/a: 后台子系统重构；验证=行为测试（含 soak 混沌用例）+ alpha.sh 真实模型冒烟；无用户可感界面"
causal_links:
  from:
    - F20260812mrcq
    - F20261013ebps
    - F20261020slvg
    - F20261105embqg
    - F20261109epqst
  supersedes: []
tags: [embedding, memory, queue, lane, watchdog, root-cure]
modules:
  - src/frameworks/embedding/embedding-service.ts
  - src/frameworks/embedding/bge-m3-worker.ts
  - src/usecases/memory/embedding-retry-worker.ts
  - src/usecases/memory/embedding-gateway.ts
  - src/usecases/memory/store-memory.ts
intent:
  problem: "同域 3 个月 5 次修复（F20260812mrcq→F20261109epqst）全部落在记账/排队层，算力链从未被设计。2026-11-10 生产实锤：开机 doc sync 一秒注入 6550 条长文本 → 单条计算耗时（2 线程 ONNX，长 chunk ≈/＞5s）系统性越过批超时预算（5s/条，封顶 120s；超时日志 18→90s/23→115s/50→120s 逐条吻合）→ 批批超时；超时批不可取消、占住 lane（drain 全部 lane-busy 空转）且重排队重算；设计上的双 lane 一忙（199.6% CPU）一闲（0%，69792 自 08:03 起零工作，watchdog 因 !ready 守卫永不触发——代码注释自证）；实时通道被挤压（live waiters 3→130，waitSlot 60s 超时，新记忆缺向量）。验收测试用短中文句（1.13 条/s），生产是长 doc chunk——测试分布 ≠ 生产分布，五连修每次绿灯合入隔天复烧。"
  solution: "六层根治（单 PR 不分期，搭档 2026-11-10 拍板）：① 实时/回填通道物理分离；② 回填调度改 token 在飞预算制；③ 批量健康判定从墙钟死线改为进度看门狗 + 补 !ready lane 盲区；④ 线程按机器推导 + bge-m3 量化版基准评估（先基准后切换）；⑤ 每条延迟 p50/p95/p99、tokens/sec、lane 状态观测面进 health 端点；⑥ 生产分布 soak 混沌测试进 CI。"
  expected_effect: "设计不变量：a) 实时永不排队——回填洪峰下实时通道延迟承诺不变；b) 批量计算不设墙钟死线——死线只属于实时通道；c) 死容量自愈且可见——lane 瘫痪 5 分钟内自愈或告警；d) 验证分布=生产分布。"
  verify_by:
    type: behavior_check
    assertions:
      - "soak 混沌（生产长度分布 500 chunk + 慢 worker 注入 4s/条 + 中途杀 worker）：实时 embed p95 < 2s 且不被回填阻塞；每条恰好计算 1 次（重复计算率 0）；worker 死亡后 respawn 且任务不丢不重；!ready lane 在超时窗口内 respawn 并落 health 信号"
      - "alpha.sh 真实模型冒烟：真实语料长 chunk 批量回填持续出队（succ>0 连续），无墙钟超时导致的死循环；实时通道并发写记忆不被挤压"
      - "观测面：/api/health 暴露每 lane 状态（ready/busy/unready/attempts）、单条延迟分位、tokens/sec、队列年龄分布；drain summary 含延迟分位字段"
      - "量化模型决策：Q8 与 fp32 在真实语料 golden 检索集上 recall@k 差 ≤ 阈值才切换，否则保留 fp32 并在本文档记录基准数据"
      - "既有回归全绿：npm test 全量 + lint + build；#1795 的 12 用例语义保持（持久化、不丢不重、批量消费）"
    rollback: "git revert 单 PR；无 DB schema 变更（复用 embedding_tasks）；量化模型若不达标默认关闭，行为回落现有 fp32 路径"
    risk_note: "通道分离改变 live/batch 的容量语义：若实测 live lane 独立后吞吐不足，回填借用必须显式配置且实时优先级永远更高——禁止隐式共享"
---

# embedding 子系统根治（F20261110embrc）

> 搭档 2026-11-10 09:52/09:56 拍板：「直接来根治方案，不看短期」「这个特性不允许分 P」——本特性单 PR 交付全部六层，禁止分期合入。
> 认领：#1803（otter-claim 2026-11-10T09:57+08:00，大獭，本 worktree）。

## 0. 现状锚点（改前必读，全部实证于 2026-11-10）

| 锚点 | 位置 | 现状 |
|---|---|---|
| 批超时预算 | `embedding-service.ts` L59-60 | `BATCH_TIMEOUT_PER_TEXT_MS=5000`、floor 30s、cap 120s——按条数计，长文本系统性越线 |
| waitSlot 死线 | 同上 L90 | `WAIT_SLOT_DEFAULT_TIMEOUT_MS=60_000`，live 请求排队 60s 后放弃 |
| lane 看门狗盲区 | 同上 L234 注释 | 「写 lane 永久瘫痪直到主进程重启（watchdog 因 !ready 守卫永不触发）」——69792 实锤 0% 闲置一上午 |
| 线程硬编码 | `bge-m3-worker.js` L37-78 | intra-op 默认 2；`OTTER_EMBED_INTRA_OP_THREADS` 逃生口（#1107，不进 config schema——保留） |
| 回填 claim | `embedding-retry-worker.ts` L233 | `claimPendingTasks(BATCH_LIMIT=50)` 按条数领；lane-busy 1s 重触发（L223-225/330-340） |
| 超时重算 | service 超时路径 | 批超时后任务重排队，在飞 ONNX 不可取消 → 重复计算 + lane 占用 |
| 洪峰入口 | 开机 doc sync | 2026-11-10 08:09:51 一秒注入 6550 条；暗条目迁移有水位闸（F20261105embqg，保留） |
| 观测面 | drain summary | 只有计数，无延迟分位、无 lane 状态、无 tokens/sec |

## 1. 设计不变量（实现与验收的宪法）

1. **实时永不排队**：live embed（store-memory 的 fireAndForget 路径）与批量回填物理隔离，回填饱和时实时 p95 < 2s。
2. **批量不设墙钟死线**：回填批的结果晚到也采纳（late-adoption），无重复计算；死线只存在于实时通道。
3. **死容量自愈且可见**：worker spawn 后 READY_TIMEOUT 秒未 ready → 杀重拉（上限 N 次，超限落 healing high + health 信号）；在飞零进度 PROGRESS_STALL 秒 → 同路径。
4. **验证分布=生产分布**：所有新增测试的语料长度分布取自真实队列实测（长 chunk 为主）。

## 2. 六层实现规格

### ① 通道分离
- 两个专属 worker：live lane（服务 fireAndForgetEmbed 单条/小批）+ backfill lane（服务 embedBatch/回填 drain）。
- 路由按调用类别，禁跨借；live lane 容量=1 并发即够（单条快），backfill 并发由 ② 控制。
- live lane 保留既有 30s 单条超时 + 60s waitSlot（fail-fast 到 FTS 降级是正确行为）；backfill lane 移除墙钟批死线。

### ② token 预算调度
- 回填 claim 从「50 条」改为「在飞 token ≤ BUDGET（默认 8192，复用现有 token gate 分裂器估算）」。
- 洪峰入口（doc sync / 暗迁移）不再需要新闸：任务全落库，drain 按预算稳定消化；水位闸保留防重复迁移语义。
- 队列即缓冲：pending 数大不是问题，消化速率稳定才是目标。

### ③ 进度看门狗 + lane 生命周期
- 进度信号：worker 每完成一条/每批 emit progress 事件；service 侧按 lane 记录 lastProgressAt。
- `PROGRESS_STALL_MS`（默认 120s）零进度 → kill worker + respawn + 该批任务回队（不丢）；respawn 连续失败 ≥3 → healing high + health signals（系统已有 RHI 通道）。
- `READY_TIMEOUT_MS`（默认 60s）未 ready → 同上（**修掉 L234 注释自证的 !ready 盲区**）。
- lane 状态机：spawning → ready → busy → (unready|dead) → spawning；状态变更全部落日志与 stats。

### ④ 算力供给
- intra-op 推导：`clamp(round(physicalCores × 0.5), 2, 8)`，`OTTER_EMBED_INTRA_OP_THREADS` 覆盖优先；live lane 固定 2 线程；双 lane 总线程预算 ≤ 核数-2（防超订，文档写明公式）。
- 量化模型（Q8）：**先基准后切换**——扩展 `scripts/eppq-real-model-throughput.mjs`：真实语料采样 ≥200 条长 chunk，测 fp32 vs Q8 的吞吐与延迟分位；构建 golden 检索集（≥50 query × 相关 chunk），recall@k 差 ≤2% 才默认切 Q8，否则保留 fp32 并把基准数据记录进本文档。决策数据必须进 PR body。

### ⑤ 观测面
- stats 扩展（service + gateway port + drain summary + /api/health）：每 lane {state, inFlight, lastProgressAt, tokensPerSec(EWMA), perTextLatency p50/p95/p99(环形缓冲 128)}；队列侧 {pending, oldestAge, ageP50/P95}。
- 告警阈值进 RHI/health：live waiter >10、lane unready >60s、backfill ETA >4h。

### ⑥ soak 混沌测试（进 CI）
- `tests/frameworks/embedding/embed-root-cure-soak.test.ts`：生产长度分布 500 chunk；注入式慢 worker（4s/条）；断言：实时 p95 <2s、每条恰好计算一次、杀 worker 中途 → respawn + 不丢不重、!ready → 超时 respawn + health 信号。假时钟/替身保证确定性。
- alpha.sh 真实模型冒烟（复用 #1795 的 e2e 手法）：120 条真实长 chunk 回填 + 并发实时写。

## 3. 机制预算四问（新增机制：token 预算调度 + 进度看门狗）

1. 解决什么真问题：五连修实证的「协调层把稀缺算力变成死锁/浪费」（今日 0 成功即量产现场）。
2. 更简单方案为何不够：无死线+固定速率消费（最简）无法应对 worker 真卡死（会永久停滞）；看门狗是最低必要自愈件，token 预算是防超订的最低必要件。
3. 成本与复杂度去向：集中在 retry-worker/service 两文件；观测面（⑤）本身就是维护这些机制的补偿性投资。
4. 退役条件：语料向量化迁外部 API 或向量检索整体退役 → 本回填子系统随之下线；Q8 不达标 → 模型层决策撤回（保留基准数据）；token 预算若长期不触顶可简化为固定批（观测面给出证据后）。

## 4. 实施纪律（硬约束）

- **单 PR 不分期**（搭档拍板）；分支 `feat/embed-root-cure`（本 worktree）。
- 主仓只读；一切改动/验证在 worktree；真实服务验证一律 `cd <worktree> && bash scripts/alpha.sh start/stop`；测试数据走 worktree/os.tmpdir()，禁碰主仓 data/。
- commit 按 code-implementation 模板 + Modification-Class 声明（本特性= mechanism-addition，四问见上）；随修随提，零悬置改动。
- 既有回归必须全绿；#1795 的 12 用例语义不允许回退（允许断言字段增列）。
- PR body：证据分层声明（机器锚点 vs agent 陈述）、基准数据（④）、rollback、Driver 行标注本对话；关联 Closes #1803。
- 检视：完成后按 review-protocol 拉独立检视獭（异体），delta 复核后呈搭档终审——不自动合入。

## 5. 交付物清单

代码（六层）+ 本 F-doc（含基准数据回填）+ soak 测试 + alpha 冒烟证据 + 单 PR + 检视两轮记录。

## 6. 设计取舍与实施发现

### 6.1 机制识别检查点

本特性命中「新增调度约束 / 新增生命周期机制 / 新增观测状态机」。机制预算四问已在第 3 节于编码前作答，Modification-Class=`mechanism-addition`。不另建通用调度框架：复用 `embedding_tasks`、现有 token 估算器和现有 worker 工厂，新增代码只覆盖预算领取、进度交付、lane 指标三个缺口。

### 6.2 规格与代码现实的差异（2026-11-10 实施实证）

1. **worker 文件扩展名漂移**：真相源是 `src/frameworks/embedding/bge-m3-worker.ts`；规格中的 `.js` 是 `dist` 构建产物。按语义定位修改 `.ts`，没有新建第二份 worker。
2. **现有 lane 拓扑不同**：代码已有 query/write 两个进程，query 已独立；本次把 write 拆成 live/backfill，query 与实时写复用 live。初版曾短暂装配 query/live/backfill 三进程，复核规格「两个专属 worker」后纠正：最终仍是两个模型进程，不新增第三份常驻模型内存。StoreMemory/search 只持有 live，retry worker 只持有 backfill，无跨借路径。
3. **线程预算**：live=2、backfill=`min(clamp(round(physicalCores×0.5),2,8), physicalCores-4)`，双 lane 总和 ≤ physicalCores-2；`OTTER_EMBED_INTRA_OP_THREADS` 仍优先。物理核 <6 时 backfill 降为 1，无法同时满足「最少 2」与总预算，选择避免超订并在此显式记录。宿主机实证 8 物理核/16 逻辑核，最终 backfill=4。
4. **整批单响应无法支撑进度与死亡续算**：旧 worker 对整个数组一次前向、只发一个 batch-result，健康长批在 120s 内没有任何逐条进度；进程死亡也无法知道哪些向量已算出。实现改为批内逐条推理、逐条 `batch-progress`，父进程保存已完成下标；死亡/错误时先 salvage 这些下标，DB 重领只覆盖仍 pending 的条目。代价是放弃原生数组 batch 的共享前向开销，真实 fp32 基准必须报告该代价，不能只报收益。
5. **“每条恰好计算一次”的证据边界**：soak 断言每条已完成向量只计算/采纳一次，杀死点在两条 progress 之后、下一条完成之前。任意时刻 SIGKILL 下，若原生推理已完成但 IPC 尚未交付，物理世界无法证明零重算；本实现保证的是**已交付结果不重复计算、最终持久化不重复、未交付任务不丢**。不把这个边界隐去冒充分布式 exactly-once。

### 6.3 退役/替换机制接管表

| 被删/替换物 | 原保护的不变量全集（含异常路径） | 原消费者 | 新机制接管 |
|---|---|---|---|
| write lane 内 live/backfill 共享 worker 与优先级 waiter | MAX_IN_FLIGHT=1；live 30s/waitSlot 60s fail-fast；回填批量消费；worker 死亡拒绝 pending | StoreMemory、EmbeddingRetryWorker、#1795 12 用例 | live 独立进程保留全部死线/背压；backfill 独立进程只服务 DB drain；query 不变；既有 12 用例全量回归 |
| backfill 单条 30s 与批量 5s/条、30s floor、120s cap 的墙钟死线 | 慢批超时后调用方放弃；abandoned 槽位不释放；晚到结果 salvage；真卡死看门狗重建 | retry 错误分类、salvage、超时测试 | backfill 单条/批量都不建墙钟 timer；逐条 progress 刷新 120s 看门狗；晚到/部分结果照常 salvage；live 旧死线不变 |
| 整批一次性 batch-result | 多文本一次调用、保序返回、空批短路、错误整批 reject、#1795 批量消费 | service `embedBatch`、retry `processBatchSlice` | 对外仍保序返回整批；内部逐条 progress；batch-result 仍作为完成边界；中途 error/死亡只 salvage 已交付下标 |
| 50 条纯计数 claim | priority/next_retry_at 排序、attempts+1、指数退避、ghost 任务转 dead、空队列返回 | MemoryQueue、retry drain、SQL 测试 | 同序候选中取 token 预算前缀；单条超预算独占；原 UPDATE/RETURNING、退避与 ghost 语义不变 |
| `!ready` 看门狗直接返回 | ready 后无响应重建；意外 exit respawn；5min 3 次熔断；waiter 唤醒 | 双 lane 调用方、health、RHI | unready 60s 也重拉；progress 120s 重拉；第 4 次窗口内失败熔断；health `dead/unready` + RHI severity:high |

### 6.4 负面向验收

本次有意改变两项旧契约：① backfill 不再按墙钟 reject 健康慢批；② worker 原生数组前向改为逐条 progress。前者由「120s 内有 progress 不重启、结果最终采纳」正向验证；后者由「中途杀死已交付下标不重算、最终 500 条全完成」验证。没有绕过 DB 持久化、attempts/dead-letter、live fail-fast、token 入口闸门或进程隔离保护。

## 7. 验证记录（实施中，最终数据在 PR 前补齐）

| 场景 | 操作 | 结果 |
|---|---|---|
| 既有 embedding/retry/#1795 回归 | `npx vitest run tests/frameworks/embedding tests/usecases/memory/embedding-persistent-queue.test.ts tests/usecases/memory/embedding-retry-worker.test.ts tests/interface-adapters/health-controller.test.ts --maxWorkers=2` | PASS：10 文件 / 108 用例 |
| 新增安全网/token/health/观测定向组 | `npx vitest run tests/frameworks/embedding/embed-root-cure-soak.test.ts tests/frameworks/embedding/embedding-thread-plan.test.ts tests/frameworks/db/memory/embedding-token-budget.test.ts tests/usecases/memory/embedding-health.test.ts tests/interface-adapters/health-controller.test.ts tests/usecases/memory/embedding-persistent-queue.test.ts tests/frameworks/embedding/embed-batch-sharding.test.ts --maxWorkers=2` | PASS：7 文件 / 49 用例 |
| 500 长 chunk 混沌 | 注入 4s/条 worker；10 条并发 live；第 2 条 progress 后杀 backfill worker；新代续算 | PASS：500 次完成计算、500 个唯一文本；已交付下标 [0,1] 各 salvage 一次；live 端到端 p95 <2s；backfill p95=4000ms |
| !ready 盲区 | fake clock 越过 ready timeout；连续不 ready worker | PASS：超时 respawn；第 4 次窗口内失败进入 dead，health circuitBroken=true，healing reporter 收到一次失败事件 |
| 静态检查 | `npx tsc --noEmit` + 相关源码/测试 ESLint | PASS：0 error |

最简实现检查：复用现有 `embedding_tasks`、token 估算、worker 工厂、health controller 与 healing repo；未新增 DB schema、通用调度框架或第三方依赖。批内逐条 progress 是满足死亡续算与看门狗所需的最小协议增量，其性能代价由真实模型基准单独裁决。

## 8. 量化模型基准与切换决策

### 8.1 数据获取纪律

- 命令：`OTTER_EMBED_BENCH_OUTPUT=/tmp/embrc-quantization-benchmark.json node scripts/eppq-real-model-throughput.mjs --benchmark`。
- 语料：worktree `docs/features + docs/research` 的真实 Markdown，经生产 `chunkMarkdown` + `cleanMarkdownForFts`，等距抽 200 个长 chunk；字符 p50/p95/p99=709/2172/2684，估算 token 总计 93,783。
- golden：50 条 query，由真实文档 title + headingPath + 首个有效正文句确定性地构造，每条标注 1 个相关 chunk；这是可复验的机器标注，**不是人工多标注检索质量集**。指标为向量 cosine 排序的 recall@5/@10。
- Q8 资产：`Xenova/bge-m3/onnx/model_quantized.onnx`，569,694,530 bytes，存 os.tmpdir()；fp32 使用主仓只读模型。两模型均真实加载，输出 1024 维，无 mock。

### 8.2 2 线程对照（初版装配；最终结果见后续记录）

| dtype | texts/s | tokens/s | 单条 p50/p95/p99 ms | recall@5 | recall@10 |
|---|---:|---:|---|---:|---:|
| fp32 | 0.408 | 191.34 | 1836 / 6374 / 7886 | 1.0 | 1.0 |
| Q8 | 0.525 | 246.22 | 1364 / 4843 / 6194 | 1.0 | 1.0 |
| 差值/倍率 | +28.7% | +28.7% | -25.7% / -24.0% / -21.5% | 0 | 0 |

决策：recall@5/@10 差均 0 ≤ 2%，质量门通过，默认切 Q8；`OTTER_EMBED_DTYPE=fp32` 显式回滚。`bge-m3-files.json` 同时登记 fp32 与 Q8，旧 fp32 文件不删除，回滚不需要重新下载 2.27GB 外部数据。最终 4 线程复测使用同一语料/query，另列数据，不能用本轮代替。

### 8.3 全量回归中间证据

`npm test`：PASS，448 个测试文件 / 5798 条用例（与 Q8 真实基准并行运行）；全仓 ESLint 随 pretest 通过。最终 PR 前还会在新的提交态再跑 build/lint/test 与 CI。
