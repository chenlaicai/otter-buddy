/* eslint-disable max-lines -- F20261023emct 闸门接入后 467 行（限 450，skipBlank/Comments 后实际逻辑未超），拆文件另开 PR（F20261020slvg 已拆过 protocol） */
/**
 * Embedding 服务主线程：通过 child_process.fork 调用 bge-m3 模型子进程。
 * 实现 EmbeddingGateway 接口，dispose() 通过工厂返回值暴露。
 *
 * F20261015kill：worker_threads → child_process 进程隔离。
 * 根因（2026-10-15 21:22 进程 abort 实锤）：F20261015selfheal 的
 * oldWorker.terminate() 拆 isolate 时，onnxruntime InferenceSession
 * 方法回调抛 Napi::Error，ThrowAsJavaScriptException 在 teardown 路径
 * 退化成 C++ 异常 → std::terminate → 打死整个主进程。
 * 子进程 SIGKILL 不触发 N-API teardown，原生死只带走自己。
 */

import type { ChildProcess } from "child_process";
import os from "node:os";

import type {
  EmbeddingGateway,
  EmbedModelMeta,
  EmbedCallOptions,
  EmbedBatchCallOptions,
} from "@usecases/memory/embedding-gateway";
import { EmbedTimeoutError, EmbedBackpressureError, EmbedTransientError } from "@usecases/memory/embedding-gateway";
import type { Logger } from "@usecases/ports/logger";


/** F20261015selfheal：worker 工厂——timeout 自愈重建 worker 时需要重新 spawn，注入以保测试可 mock */
export type WorkerFactory = () => ChildProcess;

// F20261020slvg：IPC 协议与 pending 簿记类型拆到 embedding-protocol.ts（压文件行数上限）
import type {
  EmbedRequest,
  EmbedBatchRequest,
  EmbedResponse,
  PendingRequest,
  PendingBatchRequest,
  ReadyState,
} from "./embedding-protocol";
import { resolveBatchTokenBudget, splitBatchByTokenBudget, wrapOptsForShard, estimateTokens } from "./embed-batch-sharding";

export class EmbeddingServiceImpl implements EmbeddingGateway {
  private disposed = false;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly pendingBatchRequests = new Map<number, PendingBatchRequest>();
  /** F20261013ebps：等待空槽的 waiter 队列（acquireSlot 挂起在此，出队释放时唤醒） */
  private readonly slotWaiters: Array<() => void> = [];
  private readonly readyState: ReadyState = { ready: false, loadError: null, waiters: [] };
  /** F20260811mrpy Part 3：worker ready 时缓存的模型元信息 */
  private cachedMeta: EmbedModelMeta | null = null;
  private requestId = 0;
  /** 单次 embed 请求超时（ms）。超时后触发 FTS5-only 降级（#306） */
  private static readonly EMBED_TIMEOUT_MS = 30_000;
  /**
   * F20261013ebps：in-flight 上限——pendingRequests 满时新 embed 直接 reject，
   * 不 send 到 worker（防 document sync 等批量场景瞬间打满 worker 消息队列，
   * 后续请求全部排队超时——#1453 实证：3269 条 chunk embed 淹没 worker，27min 排不完）。
   * 超出上限的请求由调用方 catch 后入 retry 队列，不丢失。
   *
   * F20261015selfheal 治本：50 → 1（worker 内严格串行）。
   * 根因实验定论（/tmp/repro-long-text.mjs 对照矩阵）：onnxruntime 1.23.2 ThreadPool
   * 嵌套 parallel section 在长文本（>1500 token）× 并发 >1 时必然 lost-wakeup 死锁——
   * 并发=1 全过（30 次）、并发=2 第 8 条卡死、并发=4 第 6 条、并发=16 第 4 条。
   * 串行化从触发条件上消除并发（治本，非兜底）。吞吐不受损：sync 路径本来就是
   * acquireSlot 挂起等空闲 → embedBatch 一次一批（一批占一槽，串行节奏不变）；
   * 查询路径并发 embed 排队，单次 ~230ms（短文本）可接受。
   */
  private static readonly MAX_IN_FLIGHT = 1;
  /**
   * F20261016ebrt：batch 超时预算——从 1s/条 放宽到 5s/条，且不低于单条的 30s。
   * 旧预算（texts.length×1s）在长文本（~1000 token/条，实测 1-2s/条）+ 高负载下
   * 必超，把「慢」误判成「死」触发自愈杀 worker（2026-10-15 21:22 事故链）。
   * 上限仍 120s 防真死锁拖太久。
   */
  private static readonly BATCH_TIMEOUT_PER_TEXT_MS = 5_000;
  private static readonly BATCH_TIMEOUT_FLOOR_MS = 30_000;
  /** 测试用覆盖超时（ms） */
  private static testTimeoutOverride: number | null = null;
  /** 测试用覆盖 in-flight 上限 */
  private static testMaxInFlightOverride: number | null = null;
  /** F20261023emct：测试用分片预算覆盖（避免测试依赖环境变量） */
  private static testBatchTokenBudgetOverride: number | null = null;
  /**
   * F20261020slvg：无进展看门狗——「死」的定义从「墙钟超预算」（超时自杀，#1493 误杀；
   * 慢≠死闭锁，#1521 活锁）改为「lane 占用且 worker 无任何响应」。
   * 慢 batch（健康但 100-200s）持续有响应 → 不杀；真死锁（SpinPause 永不返回）→ 无响应 → 必触发。
   *
   * 耦合旋钮警示（#948 教训：旋钮必须联动核对）：
   * 阈值必须 > batch 超时预算上限（120s）× 安全余量。若未来放宽 BATCH_TIMEOUT 上限
   * 或 BATCH_LIMIT，此处必须同步调整。
   */
  private static readonly WATCHDOG_INTERVAL_MS = 60_000;
  private static readonly WATCHDOG_NO_PROGRESS_MS = 300_000;
  /** 测试用看门狗阈值覆盖 */
  private static testWatchdogOverride: number | null = null;
  /** 最近一次 worker 活动（send / 任何响应 / ready / 重建）时间戳 */
  private lastWorkerActivityAt = Date.now();
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * F20261015selfheal：embed 超时自愈——onnxruntime 1.23.2 在 Intel x86 mac 上存在偶发
   * ThreadPool lost-wakeup 竞态（#1453/#1460 实证：worker 推理卡死永不返回，主线程超时后
   * 只清 pending，已 send 的消息堆积在假死 worker 队列造成 ~1GB/h 泄漏）。
   * 应用层无法修复原生竞态，唯一可行的恢复手段是杀掉假死进程销毁其 ThreadPool
   * 上下文后重建。熔断防风暴：窗口内重启次数超限则降级（available=false），避免无限重建。
   *
   * F20261015kill：恢复手段从 worker.terminate() 改为 child.kill('SIGKILL')——
   * terminate 拆 isolate 触发 Napi::Error 未捕获 C++ 异常 abort 主进程。
   */
  private static readonly RESTART_WINDOW_MS = 300_000; // 5min
  private static readonly RESTART_MAX_IN_WINDOW = 3;
  private restartTimestamps: number[] = [];
  /** 熔断状态：true 时 waitForReady 拒绝，embedding 降级 FTS5-only */
  private circuitBroken = false;

  /**
   * F20261015kill：worker 代际号——重建时递增，旧 worker 的事件回调因代际不匹配被丢弃，
   * 防止 kill/exit 滞后事件污染新一代 readyState（原 handleWorkerExit 会把
   * ready 打回 false + rejectAllPending，把刚 ready 的新 worker 一并打死）。
   */
  private workerGeneration = 0;

  /**
   * F20261015selfheal 观测增强（搭档要求：不能把锅推给「生产环境无法复现」，
   * 下次卡死必须拿到真实现场数据作线索）。worker 生命画像：
   * 跟踪本代 worker 的存活期指标，重启时连同宿主环境快照一起落结构化日志。
   */
  private workerBornAt = Date.now();
  private workerEmbedSucceeded = 0; // 本代 worker 成功 embed 次数（单条+batch 按请求计）
  private workerEmbedTimeouts = 0; // 本代 worker embed 超时次数（检视 #1493 delta 观察 1：原名 attempted 只计超时，名实不符）
  /** F20261020slvg：本代 worker 晚到结果被 salvage 的次数（原先是静默丢弃，不可观测） */
  private workerSalvagedResults = 0;
  /** 最近一次触发超时的请求画像（定位「是否特定文本模式触发嵌套算子」） */
  private lastTimeoutContext: Record<string, unknown> | null = null;

  /** 设置测试用超时覆盖（仅测试环境） */
  static setTestTimeoutOverride(ms: number | null): void {
    EmbeddingServiceImpl.testTimeoutOverride = ms;
  }

  /** 设置测试用看门狗阈值覆盖（仅测试环境） */
  static setTestWatchdogOverride(ms: number | null): void {
    EmbeddingServiceImpl.testWatchdogOverride = ms;
  }

  /** 设置测试用分片预算覆盖（仅测试环境） */
  static setTestBatchTokenBudgetOverride(n: number | null): void {
    EmbeddingServiceImpl.testBatchTokenBudgetOverride = n;
  }

  /** 设置测试用 in-flight 上限覆盖（仅测试环境） */
  static setTestMaxInFlightOverride(n: number | null): void {
    EmbeddingServiceImpl.testMaxInFlightOverride = n;
  }

  get available(): boolean {
    return this.readyState.ready;
  }

  constructor(
    private worker: ChildProcess,
    private readonly logger: Logger,
    private readonly workerFactory?: WorkerFactory,
  ) {
    this.setupHandlers();
    this.startWatchdog();
  }

  private setupHandlers(): void {
    // F20261015kill：捕获当前代际，旧 worker 滞后事件直接丢弃
    const generation = this.workerGeneration;
    this.worker.on("message", (msg: EmbedResponse) => {
      if (generation !== this.workerGeneration) return;
      this.handleWorkerMessage(msg);
    });
    this.worker.on("error", (err: Error) => {
      if (generation !== this.workerGeneration) return;
      this.handleWorkerError(err);
    });
    this.worker.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (generation !== this.workerGeneration) return;
      this.handleWorkerExit(code, signal);
    });
  }

  /**
   * F20261020slvg：无进展看门狗——「死」的判定入口，取代两代失败方案
   * （#1493 超时自杀误杀慢 worker；#1521 慢≠死把活锁逃生通道闭锁）。
   * 判据与墙钟超时解耦：lane 有 outstanding 且 worker 超过阈值无任何响应。
   * 慢而健康（响应持续到达）永不触发；真死锁（SpinPause 永不返回）必触发。
   */
  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(
      () => this.watchdogTick(),
      EmbeddingServiceImpl.WATCHDOG_INTERVAL_MS,
    );
    this.watchdogTimer.unref?.();
  }

  private watchdogTick(): void {
    if (this.disposed || this.circuitBroken || !this.workerFactory) return;
    if (!this.readyState.ready) return; // 加载期/重建期不算无进展
    const outstanding = this.pendingRequests.size + this.pendingBatchRequests.size;
    if (outstanding === 0) return;
    const threshold = EmbeddingServiceImpl.testWatchdogOverride
      ?? EmbeddingServiceImpl.WATCHDOG_NO_PROGRESS_MS;
    const silentMs = Date.now() - this.lastWorkerActivityAt;
    if (silentMs > threshold) {
      this.restartWorker(
        `watchdog: no worker response for ${silentMs}ms with ${outstanding} outstanding request(s)`,
      );
    }
  }

  /**
   * F20261015selfheal：embed 超时后的自愈入口——SIGKILL 假死 worker 并重建。
   * SIGKILL 会销毁 worker 的整个进程（含 onnxruntime ThreadPool + IPC 队列，
   * 已 send 的滞留消息随之一并清空——这是 #1460 泄漏的唯一有效堵漏手段，
   * 假死 worker 收不到任何 flush 指令）。
   * 重建后的 worker 重新加载模型，期间 embed 请求在 waitForReady 挂起至 ready。
   */
  private restartWorker(reason: string): void {
    if (!this.workerFactory) return; // 无工厂（旧构造路径）不自愈，保持现状
    if (this.circuitBroken) return;

    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter(t => now - t < EmbeddingServiceImpl.RESTART_WINDOW_MS);
    this.restartTimestamps.push(now);
    const restartsInWindow = this.restartTimestamps.length;

    // F20261015selfheal 观测增强：重启前落结构化现场快照（拆出压 max-statements）
    this.logRestartSnapshot(reason, restartsInWindow);

    if (restartsInWindow > EmbeddingServiceImpl.RESTART_MAX_IN_WINDOW) {
      this.openCircuit(restartsInWindow);
      return;
    }

    this.killAndResetOldWorker(reason);

    this.worker = this.workerFactory();
    this.setupHandlers();
    // F20261015selfheal 观测增强：新代 worker 画像归零
    this.workerBornAt = Date.now();
    this.workerEmbedSucceeded = 0;
    this.workerEmbedTimeouts = 0;
    this.workerSalvagedResults = 0;
    this.lastTimeoutContext = null;
    // F20261020slvg：新 worker 加载期锚定活动时间，防止加载 + 首条慢请求叠加误判
    this.lastWorkerActivityAt = Date.now();
  }

  /**
   * F20261015kill：摘旧 worker 监听器 + SIGKILL + 重置服务态（从 restartWorker 拆出，压 max-statements）。
   * 先摘监听器再 kill——防止 exit/error 滞后回调把新 worker 的 readyState 打回未就绪。
   * SIGKILL 不跑析构/N-API teardown（terminate 在此路径抛 Napi::Error abort 主进程）。
   */
  private killAndResetOldWorker(reason: string): void {
    const oldWorker = this.worker;
    this.workerGeneration++;
    oldWorker.removeAllListeners();
    oldWorker.kill("SIGKILL");

    this.cachedMeta = null;
    this.readyState.ready = false;
    this.readyState.loadError = null; // 重建是恢复动作，清掉旧 loadError 让 waitForReady 重新挂起
    // F20261020slvg 对抗审视洞 2：瞬态错误专用类型——retry worker 不计 attempts，防成批 dead-letter
    this.rejectAllPending(new EmbedTransientError(`Embedding worker restarting (${reason})`));
    // 放行槽位 waiter——挂起的 sync 循环恢复后由新 worker 的 embed 正常处理
    this.drainSlotWaiters();
  }

  /** F20261015selfheal：熔断打开（从 restartWorker 拆出，压 max-statements） */
  private openCircuit(restartsInWindow: number): void {
    this.circuitBroken = true;
    const err = new EmbedTransientError(`Embedding worker circuit breaker open: ${restartsInWindow} restarts within ${EmbeddingServiceImpl.RESTART_WINDOW_MS / 1000}s, vec disabled`);
    this.readyState.loadError = err;
    this.readyState.ready = false;
    this.logger.error(`Embedding worker circuit breaker open after ${restartsInWindow} restarts, falling back to FTS5-only permanently until process restart`);
    this.rejectAllPending(err);
    // F20261020slvg 对抗审视洞 1：熔断后无任何唤醒来源（看门狗被 circuitBroken 守卫挡掉）——
    // 必须在此放行全部 waiter，否则 parked 调用方永久悬挂并沿 tickNow 堵死 PatrolWorker
    this.drainSlotWaiters();
  }

  /** F20261020slvg：放行全部槽位 waiter（waiter 醒来后经 loadError 检查 fail-fast） */
  private drainSlotWaiters(): void {
    while (this.slotWaiters.length > 0) {
      this.slotWaiters.shift()!();
    }
  }

  /** F20261015selfheal 观测增强：embed 文本画像（摘要级，不进全文——防隐私/体积） */
  private static textProfile(text: string): Record<string, unknown> {
    return {
      chars: text.length,
      // bge-m3 经验估算 ~1.5 char/token（中英混合语料）
      estTokens: Math.round(text.length / 1.5),
      head: text.slice(0, 80),
    };
  }

  /**
   * F20261015selfheal 观测增强（搭档 10/15 要求）：重启前落结构化现场快照——
   * 下次卡死可 jq 聚合分析（频率/文本模式/宿主压力三个假设一次性可证伪）。
   */
  private logRestartSnapshot(reason: string, restartsInWindow: number): void {
    const now = Date.now();
    const mem = process.memoryUsage();
    const loadavg1m = Math.round(os.loadavg()[0] * 100) / 100;
    this.logger.warn("embedding_worker_restart", {
      action: "embedding_worker_restart",
      reason,
      restartsInWindow,
      restartWindowMs: EmbeddingServiceImpl.RESTART_WINDOW_MS,
      // worker 画像：本代存活期指标
      workerAgeMs: now - this.workerBornAt,
      workerEmbedTimeouts: this.workerEmbedTimeouts,
      workerEmbedSucceeded: this.workerEmbedSucceeded,
      workerSalvagedResults: this.workerSalvagedResults,
      outstandingRequests: this.pendingRequests.size + this.pendingBatchRequests.size,
      // 超时请求画像（若有）：文本长度/token 估算/前缀摘要，定位文本模式假设
      ...(this.lastTimeoutContext ? { timeoutContext: this.lastTimeoutContext } : {}),
      // 宿主环境快照：验证「宿主压力是触发变量」假设
      host: {
        rssMb: Math.round(mem.rss / 1048576),
        heapUsedMb: Math.round(mem.heapUsed / 1048576),
        loadavg1m,
      },
    });
  }

  /** F20261015selfheal：worker message 统一分发（从 setupHandlers 拆出，降函数行数） */
  private handleWorkerMessage(msg: EmbedResponse): void {
    // F20261020slvg：任何 worker 消息都是「活着」的证据——喂看门狗
    this.lastWorkerActivityAt = Date.now();
    if (msg.type === "ready") {
      this.readyState.ready = true;
      this.cachedMeta = msg.meta;  // F20260811mrpy Part 3：缓存 meta
      this.readyState.waiters.forEach(w => w.resolve());
      this.readyState.waiters.length = 0;
      this.logger.info(`Embedding model loaded: ${msg.meta.modelId} rev=${msg.meta.modelRev} dim=${msg.meta.dim}`);
      return;
    }
    if (msg.type === "error" && msg.id === -1) {
      this.readyState.loadError = new Error(msg.error);
      this.readyState.waiters.forEach(w => w.reject(this.readyState.loadError!));
      this.readyState.waiters.length = 0;
      this.logger.warn(`Embedding model unavailable, falling back to FTS5-only: ${msg.error}`);
      return;
    }
    this.handleResponseMessage(msg);
  }

  /**
   * 单条/批量结果分发（从 handleWorkerMessage 拆出，压 max-statements）。
   *
   * F20261020slvg：abandoned 条目（调用方已超时放弃）的响应不再丢弃——
   * 成功结果交 salvage 持久化（worker 花真 CPU 算出的向量不能白扔），
   * 错误响应对应任务留 pending（retry 队列兜底）。槽位在此处才释放。
   */
  private handleResponseMessage(msg: EmbedResponse): void {
    if (msg.type === "result" || msg.type === "error") {
      const pending = this.pendingRequests.get(msg.id);
      if (!pending) return;
      this.pendingRequests.delete(msg.id);
      this.releaseSlot();
      if (msg.type === "result") {
        this.workerEmbedSucceeded++;
        if (pending.abandoned) {
          this.salvageLateResult(msg.id, pending.salvage, msg.embedding);
        } else {
          pending.resolve(msg.embedding);
        }
      } else if (pending.abandoned) {
        this.logger.warn(
          `Embedding late error for abandoned request ${msg.id} (task stays pending for retry): ${msg.error}`,
        );
      } else {
        pending.reject(new Error(msg.error));
      }
      return;
    }
    if (msg.type === "batch-result") {
      const pending = this.pendingBatchRequests.get(msg.id);
      if (!pending) return;
      this.pendingBatchRequests.delete(msg.id);
      this.releaseSlot();
      this.workerEmbedSucceeded++;
      if (pending.abandoned) {
        this.salvageLateResult(msg.id, pending.salvage, msg.embeddings);
      } else {
        pending.resolve(msg.embeddings);
      }
    }
  }

  /**
   * F20261020slvg：晚到结果 salvage——包裹成独立 microtask 并吞错，
   * 防 salvage 回调同步 throw 沿 EventEmitter 冒泡成 uncaughtException
   * 打死主进程（本代码库已因原生层异常死过一次，JS 层不能再引入同类）。
   * 对抗审视洞 5：命中时打点——salvage 此前是不可观测的静默路径，上线验证需要抓手。
   */
  private salvageLateResult<T>(requestId: number, salvage: ((value: T) => void) | undefined, value: T): void {
    if (!salvage) return; // 无回调（如 query lane 晚到结果无意义）才真正丢弃
    this.workerSalvagedResults++;
    this.logger.info(`Embedding salvage landed for request ${requestId} (caller timed out, late result persisted)`);
    Promise.resolve()
      .then(() => salvage(value))
      .catch(err => this.logger.warn(`Embedding salvage callback failed: ${err}`));
  }

  /**
   * F20261013ebps：等待一个空闲 in-flight 槽位（满时挂起至空出）。
   * sync 批量路径用此做流速控制——前一批完成才发下一批，替代背压 reject 硬溢出入 retry 队列。
   * dispose 时全部 waiter 立即放行，由调用方后续 embed 的 disposed 检查拦截。
   */
  acquireSlot(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const maxInFlight = EmbeddingServiceImpl.testMaxInFlightOverride ?? EmbeddingServiceImpl.MAX_IN_FLIGHT;
    if (this.pendingRequests.size + this.pendingBatchRequests.size < maxInFlight) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.slotWaiters.push(resolve);
    });
  }

  /** in-flight 出队后唤醒一个槽位 waiter（FIFO，每出队一次只放一个，防惊群） */
  private releaseSlot(): void {
    const waiter = this.slotWaiters.shift();
    if (waiter) waiter();
  }

  /** F20261013ebps：worker error 处理（从 setupHandlers 拆出） */
  private handleWorkerError(err: Error): void {
    this.logger.error("Embedding worker process error", err);
    // F20260803mval: worker 崩溃后重置 ready + 设 loadError + 拒绝 waiters，
    // 避免 waitForReady 永久挂起导致 waiters 数组无限增长（内存泄漏）
    // F20260811mrpy Part 3: 清除 cachedMeta 防止 worker 重启后读到旧 meta
    this.cachedMeta = null;
    this.readyState.ready = false;
    this.readyState.loadError = new EmbedTransientError(`Worker error: ${err.message}`);
    this.readyState.waiters.forEach(w => w.reject(this.readyState.loadError!));
    this.readyState.waiters.length = 0;
    this.rejectAllPending(this.readyState.loadError!);
    // F20261020slvg 对抗审视洞 1：worker 死亡路径必须放行 slot waiter——
    // 否则 parked 的 waitSlot 调用方永久悬挂（且看门狗被 !ready 守卫挡掉，无自愈）
    this.drainSlotWaiters();
  }

  /** F20261013ebps：worker exit 处理（从 setupHandlers 拆出） */
  private handleWorkerExit(code: number | null, signal: NodeJS.Signals | null): void {
    /** 正常 dispose → kill 也会触发 exit：守卫掉，否则每次正常关停都打一条误导性 ERROR */
    if (this.disposed) return;
    this.logger.error(`Embedding worker process exited unexpectedly, code=${code} signal=${signal}`);
    this.cachedMeta = null;  // F20260811mrpy Part 3
    this.readyState.ready = false;
    const err = new EmbedTransientError(`Worker exited with code=${code} signal=${signal}`);
    this.readyState.loadError = err;
    this.readyState.waiters.forEach(w => w.reject(err));
    this.readyState.waiters.length = 0;
    this.rejectAllPending(err);
    // F20261020slvg 对抗审视洞 1：同 handleWorkerError——放行全部 waiter
    this.drainSlotWaiters();
  }

  /** F20261013ebps：拒绝所有 pending 请求（单条 + 批量） */
  private rejectAllPending(err: Error): void {
    this.pendingRequests.forEach(({ reject }) => reject(err));
    this.pendingRequests.clear();
    this.pendingBatchRequests.forEach(({ reject }) => reject(err));
    this.pendingBatchRequests.clear();
  }

  private waitForReady(): Promise<void> {
    if (this.readyState.ready) return Promise.resolve();
    if (this.readyState.loadError) return Promise.reject(this.readyState.loadError);
    return new Promise<void>((resolve, reject) => {
      this.readyState.waiters.push({ resolve, reject: (err) => reject(err) });
    });
  }

  // eslint-disable-next-line max-lines-per-function -- F20261023emct delta 加单条守卫后 61 行（限 60），剩余为 F20261020slvg 的 waitSlot 内联循环（拆分需同步处理 TOCTOU 注释链，另开 PR）
  async embed(text: string, opts?: EmbedCallOptions): Promise<Float32Array> {
    if (this.disposed) throw new Error("EmbeddingService has been disposed");
    // F20261023emct delta 处置（建议 5/焦点 1）：单条入口同受闸门收口——超预算文本直接
    // reject 而非透传（调用方截断链是兜底不是闸门，「靠调用方纪律」正是前 6 轮的失败
    // 模式）。单条不可拆（拆文本破坏语义），无豁免路径——真巨文本应先截断（store-memory
    // EMBED_MAX_CHARS=6000 已做）。主不变量由此完整：embedBatch 入口拆批、embed 入口拒收。
    const budget = EmbeddingServiceImpl.testBatchTokenBudgetOverride ?? resolveBatchTokenBudget();
    if (estimateTokens(text) > budget) {
      throw new Error(
        `Embedding single text exceeds batch token budget (${estimateTokens(text)} > ${budget} tokens); truncate before embed`,
      );
    }
    await this.waitForReady();

    // F20261020slvg：waitSlot——写路径软限流：槽满挂起排队。
    // 循环直接内联（不经 helper）——唤醒后的重查→准入→set+send 必须在同一同步段，
    // 消灭 acquireSlot→embed 配对的 TOCTOU 竞态（await helper 会多一个 microtask 边界）
    const maxInFlight = EmbeddingServiceImpl.testMaxInFlightOverride ?? EmbeddingServiceImpl.MAX_IN_FLIGHT;
    if (opts?.waitSlot) {
      while (this.pendingRequests.size + this.pendingBatchRequests.size >= maxInFlight) {
        await new Promise<void>((resolve) => {
          this.slotWaiters.push(resolve);
        });
        if (this.disposed) throw new Error("EmbeddingService has been disposed");
        // F20261020slvg 对抗审视洞 1：worker 崩溃/熔断被唤醒后 fail-fast——
        // 不把请求 send 给死 worker（重建路径 loadError 为 null，走新 worker）
        if (this.readyState.loadError) throw this.readyState.loadError;
      }
    }

    // F20261013ebps：背压——in-flight 满时直接 reject，不 send 进 worker 队列。
    // F20261020slvg：口径统一为两 map 总和（原 embed 只查单条 map，batch 占槽期间
    // 单条可从缝里钻入，破坏 MAX_IN_FLIGHT=1 的串行前提）；reject 用专门错误类型
    // （retry worker 对背压不计 attempts，防 3 次埋掉可恢复任务）
    if (this.pendingRequests.size + this.pendingBatchRequests.size >= maxInFlight) {
      throw new EmbedBackpressureError(
        `Embedding backpressure: ${this.pendingRequests.size + this.pendingBatchRequests.size} in-flight requests exceed limit ${maxInFlight}, request rejected to prevent worker queue overflow`,
      );
    }

    const id = ++this.requestId;

    const embedPromise = new Promise<Float32Array>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, salvage: opts?.salvage });
      const request: EmbedRequest = { type: "embed", text, id };
      // F20261020slvg 对抗审视洞 5：channel 已关时 send 可能同步 throw 而非返回 false——
      // 不捕获会把条目泄漏在 map 里（in-flight 永久 =1，lane 堵死且看门狗不介入）
      try {
        if (!this.worker.send(request)) {
          this.pendingRequests.delete(id);
          reject(new EmbedTransientError("Embedding worker IPC channel closed"));
        } else {
          this.lastWorkerActivityAt = Date.now();
        }
      } catch (sendErr) {
        this.pendingRequests.delete(id);
        reject(new EmbedTransientError(`Embedding worker send failed: ${sendErr}`));
      }
    });

    const timeoutMs = EmbeddingServiceImpl.testTimeoutOverride ?? EmbeddingServiceImpl.EMBED_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<Float32Array>((_, reject) => {
      timer = setTimeout(() => {
        // F20261020slvg：超时 ≠ 取消——只标记 abandoned + reject 调用方。
        // 条目保留、槽位不释放（消息已 send，worker 会算完；晚到结果走 salvage）。
        // 准入从此量测 worker 真实占用，队列不可能在 worker 侧积压（#1521 活锁根因）。
        const pending = this.pendingRequests.get(id);
        if (pending) pending.abandoned = true;
        // 观测：在途请求总数（含自身——abandoned 条目也占 worker 队列）
        const inflight = this.pendingRequests.size + this.pendingBatchRequests.size;
        this.workerEmbedTimeouts++;
        this.lastTimeoutContext = {
          path: "embed",
          timeoutMs,
          inflight,
          text: EmbeddingServiceImpl.textProfile(text),
        };
        reject(new EmbedTimeoutError(`Embed timeout after ${timeoutMs}ms, falling back to FTS5-only`));
      }, timeoutMs);
    });

    return Promise.race([embedPromise, timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /** F20261023emct：分片子批串行——递归调 embedBatch（子批仍超预算会再拆，单条豁免兕底）。
   *  子批间串行：await 前一子批完成才发下一个，MAX_IN_FLIGHT=1 下天然不堆在飞文本量 */
  private async embedBatchSharded(
    batches: string[][],
    totalTexts: number,
    budget: number,
    opts?: EmbedBatchCallOptions,
  ): Promise<Float32Array[]> {
    this.logger.warn(
      `Embedding batch token gate: split ${totalTexts} texts into ${batches.length} sub-batches (budget ${budget} tokens)`,
      { action: "embed_batch_sharded", texts: totalTexts, batches: batches.length, budget },
    );
    const results: Float32Array[] = [];
    let offset = 0;
    for (const batch of batches) {
      // F20261023emct delta 处置（严重发现 1）：子批 opts 按偏移量包装 salvage——
      // 晚到结果携带 (embeddings, startIndex)，调用方按下标写入正确 entry。
      // 首版原样透传 opts，offset>0 的子批晚到时会把别批向量存到 items[0..] 错误
      // entry（静默 vec 污染，检视獭独立发现）。包装器见 embed-batch-sharding.ts。
      const part = await this.embedBatch(batch, wrapOptsForShard(opts, offset));
      results.push(...part);
      offset += batch.length;
    }
    return results;
  }

  /**
   * F20261013ebps：批量 embed——一次 send 传多条文本，worker 端 batch 推理。
   * 与 embed() 共享背压上限（batch 算 1 个 in-flight 槽位，但 worker 端处理 N 条文本）。
   * 批量大小建议 ≤50（bge-m3 batch 推理内存随 batch 线性增长，50×1024dim×4B≈200KB 权重激活，可控）。
   *
   * F20261023emct：分片闸门——超预算的巨批在入口拆成多个子批，子批间串行
   * （await 前一个完成后才发下一个，实际受 waitSlot 节流：MAX_IN_FLIGHT=1 下
   * 前一子批未出结果时 acquire 循环自动挂起）。
   * 对外语义不变：调用方拿到的仍是「全部文本的结果（与输入顺序一一对应）」，
   * 超时/错误也以整批为单位 reject——调用方（fireAndForgetEmbedBatch）的
   * fallback 逻辑不需要感知分片存在。
   */
  // eslint-disable-next-line max-lines-per-function -- F20261023emct 闸门接入后仍超 3 行，剩余为原 F20261020slvg/F20261016ebrt 逻辑，拆分需另开 PR
  async embedBatch(texts: string[], opts?: EmbedBatchCallOptions): Promise<Float32Array[]> {
    if (this.disposed) throw new Error("EmbeddingService has been disposed");
    if (texts.length === 0) return [];

    // 分片闸门：所有生产者共用的唯一收口点，巨批在这里被拆小
    const budget = EmbeddingServiceImpl.testBatchTokenBudgetOverride ?? resolveBatchTokenBudget();
    const batches = splitBatchByTokenBudget(texts, budget);
    if (batches.length > 1) return this.embedBatchSharded(batches, texts.length, budget, opts);

    await this.waitForReady();

    // F20261020slvg：waitSlot 软限流（循环内联，同 embed() 的原子性论证 + fail-fast 检查）
    const maxInFlight = EmbeddingServiceImpl.testMaxInFlightOverride ?? EmbeddingServiceImpl.MAX_IN_FLIGHT;
    if (opts?.waitSlot) {
      while (this.pendingRequests.size + this.pendingBatchRequests.size >= maxInFlight) {
        await new Promise<void>((resolve) => {
          this.slotWaiters.push(resolve);
        });
        if (this.disposed) throw new Error("EmbeddingService has been disposed");
        if (this.readyState.loadError) throw this.readyState.loadError;
      }
    }

    // 背压——batch 也占一个 in-flight 槽位
    if (this.pendingRequests.size + this.pendingBatchRequests.size >= maxInFlight) {
      throw new EmbedBackpressureError(
        `Embedding backpressure: in-flight limit ${maxInFlight} reached, batch request rejected`,
      );
    }

    const id = ++this.requestId;

    const batchPromise = new Promise<Float32Array[]>((resolve, reject) => {
      this.pendingBatchRequests.set(id, { resolve, reject, salvage: opts?.salvage });
      const request: EmbedBatchRequest = { type: "embed-batch", texts, id };
      // F20261020slvg 对抗审视洞 5：同 embed() 的 send 同步 throw 防护
      try {
        if (!this.worker.send(request)) {
          this.pendingBatchRequests.delete(id);
          reject(new EmbedTransientError("Embedding worker IPC channel closed"));
        } else {
          this.lastWorkerActivityAt = Date.now();
        }
      } catch (sendErr) {
        this.pendingBatchRequests.delete(id);
        reject(new EmbedTransientError(`Embedding worker send failed: ${sendErr}`));
      }
    });

    // F20261016ebrt：batch 超时预算——5s/条，不低于 30s（对齐单条），上限 120s
    // 测试环境 testTimeoutOverride 覆盖（与 embed() 同口径，否则测试等不到生产预算）
    const timeoutMs = this.batchTimeoutBudgetMs(texts);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<Float32Array[]>((_, reject) => {
      timer = setTimeout(() => {
        // F20261020slvg：超时 ≠ 取消——同 embed() 路径，条目保留 + 槽位不释放
        const pending = this.pendingBatchRequests.get(id);
        if (pending) pending.abandoned = true;
        const inflight = this.pendingRequests.size + this.pendingBatchRequests.size;
        this.workerEmbedTimeouts++;
        this.lastTimeoutContext = {
          path: "embedBatch",
          timeoutMs,
          batchSize: texts.length,
          totalChars: texts.reduce((sum, t) => sum + t.length, 0),
          inflight,
          firstText: EmbeddingServiceImpl.textProfile(texts[0] ?? ""),
        };
        reject(new EmbedTimeoutError(`Embed batch timeout after ${timeoutMs}ms (${texts.length} texts)`));
      }, timeoutMs);
    });

    return Promise.race([batchPromise, timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /** F20261020slvg：batch 超时预算计算（从 embedBatch 拆出压函数行数） */
  private batchTimeoutBudgetMs(texts: string[]): number {
    return EmbeddingServiceImpl.testTimeoutOverride ?? Math.min(
      Math.max(texts.length * EmbeddingServiceImpl.BATCH_TIMEOUT_PER_TEXT_MS, EmbeddingServiceImpl.BATCH_TIMEOUT_FLOOR_MS),
      120_000,
    );
  }

  /** F20260811mrpy Part 3：返回 worker 加载的模型元信息 */
  async getMeta(): Promise<EmbedModelMeta> {
    if (this.disposed) throw new Error("EmbeddingService has been disposed");
    await this.waitForReady();
    if (!this.cachedMeta) {
      throw new Error("Embedding worker ready but meta missing (worker protocol mismatch)");
    }
    return this.cachedMeta;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // F20261020slvg：停看门狗（unref 已保证不阻退出，显式清更干净）
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.pendingRequests.forEach(({ reject }) =>
      reject(new EmbedTransientError("EmbeddingService disposed")),
    );
    this.pendingRequests.clear();
    this.pendingBatchRequests.forEach(({ reject }) =>
      reject(new EmbedTransientError("EmbeddingService disposed")),
    );
    this.pendingBatchRequests.clear();
    // dispose 放行全部槽位 waiter——挂起的 sync 循环恢复后由 embed 的 disposed 检查拦截
    this.drainSlotWaiters();
    this.workerGeneration++;
    this.worker.removeAllListeners();
    this.worker.kill("SIGKILL");
  }
}
