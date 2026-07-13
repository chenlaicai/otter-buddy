/**
 * Embedding 服务主线程接口。
 *
 * 封装 Worker Thread 通信，提供 embed(text) 和 dispose() 方法。
 * 不访问数据库（D-S3-1：纯 text->vector 服务）。
 */

import { Worker } from "worker_threads";
import path from "path";

export interface EmbeddingService {
  /** 生成文本的 embedding 向量 */
  embed(text: string): Promise<Float32Array>;
  /** 释放 Worker Thread 资源 */
  dispose(): void;
}

export interface EmbeddingConfig {
  modelPath?: string;
}

/** Worker 请求消息 */
interface EmbedRequest {
  type: "embed";
  text: string;
  id: number;
}

/** Worker 响应消息 */
type EmbedResponse =
  | { type: "ready" }
  | { type: "result"; embedding: Float32Array; id: number }
  | { type: "error"; error: string; id: number };

type PendingRequest = {
  resolve: (value: Float32Array) => void;
  reject: (error: Error) => void;
};

/** 设置 Worker 消息处理 */
function setupWorkerHandlers(
  worker: Worker,
  pendingRequests: Map<number, PendingRequest>,
  readyState: { ready: boolean; waiters: Array<() => void> },
): void {
  worker.on("message", (msg: EmbedResponse) => {
    if (msg.type === "ready") {
      readyState.ready = true;
      readyState.waiters.forEach((r) => r());
      readyState.waiters.length = 0;
      return;
    }
    if (msg.type === "result" || msg.type === "error") {
      const pending = pendingRequests.get(msg.id);
      if (pending) {
        pendingRequests.delete(msg.id);
        if (msg.type === "result") {
          pending.resolve(msg.embedding);
        } else {
          pending.reject(new Error(msg.error));
        }
      }
    }
  });

  worker.on("error", (err: Error) => {
    pendingRequests.forEach(({ reject }) => reject(new Error(`Worker error: ${err.message}`)));
    pendingRequests.clear();
  });
}

/**
 * 初始化 Embedding 服务。
 *
 * 创建 Worker Thread 运行 bge-m3 模型，通过 postMessage 通信。
 */
export function initEmbedding(_embedConfig?: EmbeddingConfig): EmbeddingService {
  const workerPath = path.join(__dirname, "worker.js");
  const worker = new Worker(workerPath);
  const pendingRequests = new Map<number, PendingRequest>();
  const readyState = { ready: false, waiters: [] as Array<() => void> };
  let requestId = 0;
  let disposed = false;

  setupWorkerHandlers(worker, pendingRequests, readyState);

  const waitForReady = (): Promise<void> => {
    if (readyState.ready) return Promise.resolve();
    return new Promise((resolve) => readyState.waiters.push(resolve));
  };

  return {
    async embed(text: string): Promise<Float32Array> {
      if (disposed) throw new Error("EmbeddingService has been disposed");
      await waitForReady();
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });
        const request: EmbedRequest = { type: "embed", text, id };
        worker.postMessage(request);
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      pendingRequests.forEach(({ reject }) => reject(new Error("EmbeddingService disposed")));
      pendingRequests.clear();
      worker.terminate();
    },
  };
}
