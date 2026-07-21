/**
 * Embedding 服务主线程：通过 Worker Thread 调用 bge-m3 模型。
 * 实现 EmbeddingGateway 接口，dispose() 通过工厂返回值暴露。
 */

import { Worker } from "worker_threads";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { Logger } from "@usecases/ports/logger";

interface EmbeddingConfig {
  modelPath?: string;
}

interface EmbedRequest {
  type: "embed";
  text: string;
  id: number;
}

type EmbedResponse =
  | { type: "ready" }
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

class EmbeddingServiceImpl implements EmbeddingGateway {
  private disposed = false;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly readyState: ReadyState = { ready: false, loadError: null, waiters: [] };
  private requestId = 0;

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
        this.readyState.waiters.forEach(w => w.resolve());
        this.readyState.waiters.length = 0;
        this.logger.info("Embedding model loaded successfully");
        return;
      }
      if (msg.type === "error" && msg.id === -1) {
        this.readyState.loadError = new Error(msg.error);
        this.readyState.waiters.forEach(w => w.reject(this.readyState.loadError!));
        this.readyState.waiters.length = 0;
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
      this.pendingRequests.forEach(({ reject }) =>
        reject(new Error(`Worker error: ${err.message}`)),
      );
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
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      const request: EmbedRequest = { type: "embed", text, id };
      this.worker.postMessage(request);
    });
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
  _embedConfig?: EmbeddingConfig,
  logger?: Logger,
): Promise<{ service: EmbeddingGateway; dispose: () => void }> {
  const workerPath = path.join(__dirname, "bge-m3-worker.js");
  const worker = new Worker(workerPath);
  const service = new EmbeddingServiceImpl(worker, logger || noopLogger);

  return {
    service,
    dispose: () => service.dispose(),
  };
}
