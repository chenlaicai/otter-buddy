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

import { fork, type ChildProcess } from "child_process";
import os from "node:os";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import type { EmbeddingGateway, EmbedModelMeta } from "@usecases/memory/embedding-gateway";
import type { Logger } from "@usecases/ports/logger";

interface EmbeddingConfig {
  /** 模型标识：local 模式下为 localModelPath 下的目录名；remote 模式下为 HF repo id */
  modelPath?: string;
  /** 本地模型根目录。设置后 worker 走本地加载、禁用远程下载 */
  localModelPath?: string;
  /** worker 脚本路径覆盖（测试用），默认本模块同目录的 bge-m3-worker.js */
  workerPath?: string;
  /**
   * worker 子进程的 execArgv 覆盖。默认继承 process.execArgv——
   * vitest 等宿主注入的 --conditions development 会让 worker 内 @huggingface/transformers
   * 解析到非生产构建导致推理挂起，测试环境必须显式传 []。
   */
  workerExecArgv?: string[];
}

/** F20261015selfheal：worker 工厂——timeout 自愈重建 worker 时需要重新 spawn，注入以保测试可 mock */
type WorkerFactory = () => ChildProcess;

interface EmbedRequest {
  type: "embed";
  text: string;
  id: number;
}

/** F20261013ebps：批量 embed 请求——一次 send 传多条文本，
 *  worker 端 pipeline 原生支持数组输入（batch 推理共享权重加载/分词开销），
 *  吞吐从 1条/500ms 提升到 N条/~N×500ms（接近线性），同时减少 IPC 往返次数。 */
interface EmbedBatchRequest {
  type: "embed-batch";
  texts: string[];
  id: number;
}

/**
 * F20260811mrpy Part 3：ready 消息携带 meta（modelId/modelRev/dim）。
 * worker 加载完模型 + dummy embed 拿到 dims 后发送。
 */
type EmbedResponse =
  | { type: "ready"; meta: EmbedModelMeta }
  | { type: "result"; embedding: Float32Array; id: number }
  | { type: "batch-result"; embeddings: Float32Array[]; id: number }
  | { type: "error"; error: string; id: number };

type PendingRequest = {
  resolve: (value: Float32Array) => void;
  reject: (error: Error) => void;
};

/** F20261013ebps：批量请求的 pending 结构 */
type PendingBatchRequest = {
  resolve: (value: Float32Array[]) => void;
  reject: (error: Error) => void;
};

interface ReadyState {
  ready: boolean;
  loadError: Error | null;
  waiters: Array<{ resolve: () => void; reject: (err: Error) => void }>;
}

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
  /** 测试用覆盖超时（ms） */
  private static testTimeoutOverride: number | null = null;
  /** 测试用覆盖 in-flight 上限 */
  private static testMaxInFlightOverride: number | null = null;

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
  /** 最近一次触发超时的请求画像（定位「是否特定文本模式触发嵌套算子」） */
  private lastTimeoutContext: Record<string, unknown> | null = null;

  /** 设置测试用超时覆盖（仅测试环境） */
  static setTestTimeoutOverride(ms: number | null): void {
    EmbeddingServiceImpl.testTimeoutOverride = ms;
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
    this.lastTimeoutContext = null;
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
    this.rejectAllPending(new Error(`Embedding worker restarting (${reason})`));
    // 放行槽位 waiter——挂起的 sync 循环恢复后由新 worker 的 embed 正常处理
    while (this.slotWaiters.length > 0) {
      this.slotWaiters.shift()!();
    }
  }

  /** F20261015selfheal：熔断打开（从 restartWorker 拆出，压 max-statements） */
  private openCircuit(restartsInWindow: number): void {
    this.circuitBroken = true;
    const err = new Error(`Embedding worker circuit breaker open: ${restartsInWindow} restarts within ${EmbeddingServiceImpl.RESTART_WINDOW_MS / 1000}s, vec disabled`);
    this.readyState.loadError = err;
    this.readyState.ready = false;
    this.logger.error(`Embedding worker circuit breaker open after ${restartsInWindow} restarts, falling back to FTS5-only permanently until process restart`);
    this.rejectAllPending(err);
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

  /** 单条/批量结果分发（从 handleWorkerMessage 拆出，压 max-statements） */
  private handleResponseMessage(msg: EmbedResponse): void {
    if (msg.type === "result" || msg.type === "error") {
      const pending = this.pendingRequests.get(msg.id);
      if (!pending) return;
      this.pendingRequests.delete(msg.id);
      this.releaseSlot();
      if (msg.type === "result") {
        this.workerEmbedSucceeded++;
        pending.resolve(msg.embedding);
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
      pending.resolve(msg.embeddings);
    }
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
    this.readyState.loadError = new Error(`Worker error: ${err.message}`);
    this.readyState.waiters.forEach(w => w.reject(this.readyState.loadError!));
    this.readyState.waiters.length = 0;
    this.rejectAllPending(new Error(`Worker error: ${err.message}`));
  }

  /** F20261013ebps：worker exit 处理（从 setupHandlers 拆出） */
  private handleWorkerExit(code: number | null, signal: NodeJS.Signals | null): void {
    /** 正常 dispose → kill 也会触发 exit：守卫掉，否则每次正常关停都打一条误导性 ERROR */
    if (this.disposed) return;
    this.logger.error(`Embedding worker process exited unexpectedly, code=${code} signal=${signal}`);
    this.cachedMeta = null;  // F20260811mrpy Part 3
    this.readyState.ready = false;
    const err = new Error(`Worker exited with code=${code} signal=${signal}`);
    this.readyState.loadError = err;
    this.readyState.waiters.forEach(w => w.reject(err));
    this.readyState.waiters.length = 0;
    this.rejectAllPending(err);
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

  async embed(text: string): Promise<Float32Array> {
    if (this.disposed) throw new Error("EmbeddingService has been disposed");
    await this.waitForReady();

    // F20261013ebps：背压——in-flight 满时直接 reject，不 send 进 worker 队列
    const maxInFlight = EmbeddingServiceImpl.testMaxInFlightOverride ?? EmbeddingServiceImpl.MAX_IN_FLIGHT;
    if (this.pendingRequests.size >= maxInFlight) {
      throw new Error(
        `Embedding backpressure: ${this.pendingRequests.size} in-flight requests exceed limit ${maxInFlight}, request rejected to prevent worker queue overflow`,
      );
    }

    const id = ++this.requestId;

    const embedPromise = new Promise<Float32Array>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      const request: EmbedRequest = { type: "embed", text, id };
      if (!this.worker.send(request)) {
        this.pendingRequests.delete(id);
        reject(new Error("Embedding worker IPC channel closed"));
      }
    });

    const timeoutMs = EmbeddingServiceImpl.testTimeoutOverride ?? EmbeddingServiceImpl.EMBED_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<Float32Array>((_, reject) => {
      timer = setTimeout(() => {
        // 检视 #1493 delta 存量发现：inflight 必须在 delete 自身之前读，否则少计 1
        const inflight = this.pendingRequests.size + this.pendingBatchRequests.size;
        this.pendingRequests.delete(id);
        this.releaseSlot();
        // F20261015selfheal 观测增强：超时请求画像（定位「是否特定文本模式触发嵌套算子」）
        this.workerEmbedTimeouts++;
        this.lastTimeoutContext = {
          path: "embed",
          timeoutMs,
          // 卡死时在途请求总数是判断泄漏速率的关键信号
          inflight,
          text: EmbeddingServiceImpl.textProfile(text),
        };
        // F20261015selfheal：超时是 worker 假死的唯一可观测信号——触发自愈重建
        this.restartWorker(`embed timeout after ${timeoutMs}ms`);
        reject(new Error(`Embed timeout after ${timeoutMs}ms, falling back to FTS5-only`));
      }, timeoutMs);
    });

    return Promise.race([embedPromise, timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /**
   * F20261013ebps：批量 embed——一次 send 传多条文本，worker 端 batch 推理。
   * 与 embed() 共享背压上限（batch 算 1 个 in-flight 槽位，但 worker 端处理 N 条文本）。
   * 批量大小建议 ≤50（bge-m3 batch 推理内存随 batch 线性增长，50×1024dim×4B≈200KB 权重激活，可控）。
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (this.disposed) throw new Error("EmbeddingService has been disposed");
    if (texts.length === 0) return [];
    await this.waitForReady();

    // 背压——batch 也占一个 in-flight 槽位
    const maxInFlight = EmbeddingServiceImpl.testMaxInFlightOverride ?? EmbeddingServiceImpl.MAX_IN_FLIGHT;
    if (this.pendingRequests.size + this.pendingBatchRequests.size >= maxInFlight) {
      throw new Error(
        `Embedding backpressure: in-flight limit ${maxInFlight} reached, batch request rejected`,
      );
    }

    const id = ++this.requestId;

    const batchPromise = new Promise<Float32Array[]>((resolve, reject) => {
      this.pendingBatchRequests.set(id, { resolve, reject });
      const request: EmbedBatchRequest = { type: "embed-batch", texts, id };
      if (!this.worker.send(request)) {
        this.pendingBatchRequests.delete(id);
        reject(new Error("Embedding worker IPC channel closed"));
      }
    });

    // batch 超时按条数缩放：每条约 500ms，上限 120s
    const timeoutMs = Math.min(
      texts.length * 1_000,
      120_000,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<Float32Array[]>((_, reject) => {
      timer = setTimeout(() => {
        // inflight 必须在 delete 自身之前读（与 embed 路径同口径）
        const inflight = this.pendingRequests.size + this.pendingBatchRequests.size;
        this.pendingBatchRequests.delete(id);
        this.releaseSlot();
        // F20261015selfheal 观测增强：batch 超时画像（条数 + 总文本量 + 首条摘要）
        this.workerEmbedTimeouts++;
        this.lastTimeoutContext = {
          path: "embedBatch",
          timeoutMs,
          batchSize: texts.length,
          totalChars: texts.reduce((sum, t) => sum + t.length, 0),
          inflight,
          firstText: EmbeddingServiceImpl.textProfile(texts[0] ?? ""),
        };
        // F20261015selfheal：batch 超时同样是 worker 假死的可观测信号——触发自愈重建
        // （onnxruntime 竞态卡死的是整个 worker 进程，单条/批量同样永久挂起；
        //  batch 路径不重建则 #1460 泄漏家族在批量路径上未闭合）
        this.restartWorker(`embed batch timeout after ${timeoutMs}ms (${texts.length} texts)`);
        reject(new Error(`Embed batch timeout after ${timeoutMs}ms (${texts.length} texts)`));
      }, timeoutMs);
    });

    return Promise.race([batchPromise, timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
    });
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
    this.pendingRequests.forEach(({ reject }) =>
      reject(new Error("EmbeddingService disposed")),
    );
    this.pendingRequests.clear();
    this.pendingBatchRequests.forEach(({ reject }) =>
      reject(new Error("EmbeddingService disposed")),
    );
    this.pendingBatchRequests.clear();
    // dispose 放行全部槽位 waiter——挂起的 sync 循环恢复后由 embed 的 disposed 检查拦截
    while (this.slotWaiters.length > 0) {
      this.slotWaiters.shift()!();
    }
    this.workerGeneration++;
    this.worker.removeAllListeners();
    this.worker.kill("SIGKILL");
  }
}

/** Noop Logger 实现 */
const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

/**
 * 初始化 Embedding 服务。
 * fork 子进程运行 bge-m3 模型，通过 IPC（serialization: advanced）通信。
 */
export async function initEmbeddingService(
  embedConfig?: EmbeddingConfig,
  logger?: Logger,
): Promise<{ service: EmbeddingGateway; dispose: () => void }> {
  const workerPath = embedConfig?.workerPath ?? path.join(__dirname, "bge-m3-worker.js");
  // F20261015kill：worker 工厂——超时自愈重建时复用同一配置 fork
  // serialization:'advanced' 走 structured clone，Float32Array 保真（默认 JSON 会退化成对象）
  const workerFactory: WorkerFactory = () => fork(workerPath, [], {
    ...(embedConfig?.workerExecArgv ? { execArgv: embedConfig.workerExecArgv } : {}),
    env: {
      ...process.env,
      // fork 无 workerData，配置走 env（bge-m3-worker 侧 readWorkerConfig 解析）
      OTTER_EMBED_WORKER_CONFIG: JSON.stringify({
        modelPath: embedConfig?.modelPath ?? "Xenova/bge-m3",
        localModelPath: embedConfig?.localModelPath,
      }),
    },
    serialization: "advanced",
  });
  const service = new EmbeddingServiceImpl(workerFactory(), logger || noopLogger, workerFactory);

  return {
    service,
    dispose: () => service.dispose(),
  };
}
