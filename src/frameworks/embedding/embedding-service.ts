/**
 * Embedding 服务主线程：通过 Worker Thread 调用 bge-m3 模型。
 * 实现 EmbeddingGateway 接口，dispose() 通过工厂返回值暴露。
 */

import { Worker } from "worker_threads";
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
   * worker 线程的 execArgv 覆盖。默认继承 process.execArgv——
   * vitest 等宿主注入的 --conditions development 会让 worker 内 @huggingface/transformers
   * 解析到非生产构建导致推理挂起，测试环境必须显式传 []。
   */
  workerExecArgv?: string[];
}

interface EmbedRequest {
  type: "embed";
  text: string;
  id: number;
}

/**
 * F20260811mrpy Part 3：ready 消息携带 meta（modelId/modelRev/dim）。
 * worker 加载完模型 + dummy embed 拿到 dims 后发送。
 */
type EmbedResponse =
  | { type: "ready"; meta: EmbedModelMeta }
  | { type: "result"; embedding: Float32Array; id: number }
  | { type: "error"; error: string; id: number };

type PendingRequest = {
  resolve: (value: Float32Array) => void;
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
  private readonly readyState: ReadyState = { ready: false, loadError: null, waiters: [] };
  /** F20260811mrpy Part 3：worker ready 时缓存的模型元信息 */
  private cachedMeta: EmbedModelMeta | null = null;
  private requestId = 0;
  /** 单次 embed 请求超时（ms）。超时后触发 FTS5-only 降级（#306） */
  private static readonly EMBED_TIMEOUT_MS = 30_000;
  /** 测试用覆盖超时（ms） */
  private static testTimeoutOverride: number | null = null;
  
  /** 设置测试用超时覆盖（仅测试环境） */
  static setTestTimeoutOverride(ms: number | null): void {
    EmbeddingServiceImpl.testTimeoutOverride = ms;
  }

  get available(): boolean {
    return this.readyState.ready;
  }

  constructor(
    private readonly worker: Worker,
    private readonly logger: Logger,
  ) {
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.worker.on("message", (msg: EmbedResponse) => {
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
      if (msg.type === "result" || msg.type === "error") {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          this.pendingRequests.delete(msg.id);
          if (msg.type === "result") {
            pending.resolve(msg.embedding);
          } else {
            pending.reject(new Error(msg.error));
          }
        }
      }
    });

    this.worker.on("error", (err: Error) => {
      this.logger.error("Worker Thread error", err);
      // F20260803mval: worker 崩溃后重置 ready + 设 loadError + 拒绝 waiters，
      // 避免 waitForReady 永久挂起导致 waiters 数组无限增长（内存泄漏）
      // F20260811mrpy Part 3: 清除 cachedMeta 防止 worker 重启后读到旧 meta
      this.cachedMeta = null;
      this.readyState.ready = false;
      this.readyState.loadError = new Error(`Worker error: ${err.message}`);
      this.readyState.waiters.forEach(w => w.reject(this.readyState.loadError!));
      this.readyState.waiters.length = 0;
      this.pendingRequests.forEach(({ reject }) =>
        reject(new Error(`Worker error: ${err.message}`)),
      );
      this.pendingRequests.clear();
    });

    /** worker 线程退出（onnxruntime 原生崩溃等场景 error 事件可能不触发）：
     *  必须拒绝所有 waiters/pending，否则 embed 永久挂起且无任何日志 */
    this.worker.on("exit", (code) => {
      /** 正常 dispose → terminate 也会触发 exit：守卫掉，否则每次正常关停都打一条误导性 ERROR */
      if (this.disposed) return;
      this.logger.error(`Embedding worker exited unexpectedly, code=${code}`);
      this.cachedMeta = null;  // F20260811mrpy Part 3
      this.readyState.ready = false;
      const err = new Error(`Worker exited with code ${code}`);
      this.readyState.loadError = err;
      this.readyState.waiters.forEach(w => w.reject(err));
      this.readyState.waiters.length = 0;
      this.pendingRequests.forEach(({ reject }) => reject(err));
      this.pendingRequests.clear();
    });
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
    const id = ++this.requestId;
    
    const embedPromise = new Promise<Float32Array>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      const request: EmbedRequest = { type: "embed", text, id };
      this.worker.postMessage(request);
    });
    
    const timeoutMs = EmbeddingServiceImpl.testTimeoutOverride ?? EmbeddingServiceImpl.EMBED_TIMEOUT_MS;
    const timeoutPromise = new Promise<Float32Array>((_, reject) => {
      setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Embed timeout after ${timeoutMs}ms, falling back to FTS5-only`));
      }, timeoutMs);
    });
    
    return Promise.race([embedPromise, timeoutPromise]);
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
    this.worker.terminate();
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
 * 创建 Worker Thread 运行 bge-m3 模型，通过 postMessage 通信。
 */
export async function initEmbeddingService(
  embedConfig?: EmbeddingConfig,
  logger?: Logger,
): Promise<{ service: EmbeddingGateway; dispose: () => void }> {
  const workerPath = embedConfig?.workerPath ?? path.join(__dirname, "bge-m3-worker.js");
  const worker = new Worker(workerPath, {
    ...(embedConfig?.workerExecArgv ? { execArgv: embedConfig.workerExecArgv } : {}),
    workerData: {
      modelPath: embedConfig?.modelPath ?? "Xenova/bge-m3",
      localModelPath: embedConfig?.localModelPath,
    },
  });
  const service = new EmbeddingServiceImpl(worker, logger || noopLogger);

  return {
    service,
    dispose: () => service.dispose(),
  };
}
