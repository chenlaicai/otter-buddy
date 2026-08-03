/**
 * bge-m3 Embedding Worker Thread。
 *
 * 通信协议：
 * 主线程 -> Worker: { type: 'embed', text: string, id: number }
 * Worker -> 主线程: { type: 'ready' } | { type: 'result', embedding: Float32Array, id: number } | { type: 'error', error: string, id: number }
 */

import { parentPort, workerData } from "worker_threads";
import { resolveEnvSettings, type WorkerConfig } from "./embedding-env-config";

if (!parentPort) {
  throw new Error("embedding worker must be started as a Worker Thread");
}

const port = parentPort;

interface EmbedRequest {
  type: "embed";
  text: string;
  id: number;
}

type EmbedResponse =
  | { type: "ready" }
  | { type: "result"; embedding: Float32Array; id: number }
  | { type: "error"; error: string; id: number };

type Extractor = (text: string, options?: unknown) => Promise<{ data: Float32Array; dims: number[] }>;

/**
 * 懒加载 bge-m3 模型。
 *
 * 用 promise cache 而非 null 标志位：避免预加载调用与 embed 请求并发时
 * 各自进 if(!extractor) 块导致 2.27GB 模型加载两次（race condition）。
 */
let extractorPromise: Promise<Extractor> | null = null;

function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");

      const cfg = (workerData ?? {}) as WorkerConfig;
      const settings = resolveEnvSettings(cfg);

      env.allowLocalModels = settings.allowLocalModels;
      env.allowRemoteModels = settings.allowRemoteModels;
      if (settings.localModelPath) env.localModelPath = settings.localModelPath;
      if (settings.remoteHost) env.remoteHost = settings.remoteHost;

      const pipe = await pipeline("feature-extraction", settings.modelId, {
        dtype: "fp32",
      });
      return (text: string, options?: unknown) =>
        (pipe as (text: string, options?: unknown) => Promise<{ data: Float32Array; dims: number[] }>)(
          text,
          options ?? { pooling: "cls", normalize: true },
        );
    })();
  }
  return extractorPromise;
}

// 预加载模型
getExtractor()
  .then(() => {
    const response: EmbedResponse = { type: "ready" };
    port.postMessage(response);
  })
  .catch((err: unknown) => {
    const response: EmbedResponse = {
      type: "error",
      error: err instanceof Error ? err.message : String(err),
      id: -1,
    };
    port.postMessage(response);
  });

port.on("message", async (msg: EmbedRequest) => {
  if (msg.type !== "embed") return;

  try {
    const fn = await getExtractor();
    const output = await fn(msg.text);
    const embedding = output.data;

    const response: EmbedResponse = {
      type: "result",
      embedding,
      id: msg.id,
    };
    port.postMessage(response);
  } catch (err: unknown) {
    const response: EmbedResponse = {
      type: "error",
      error: err instanceof Error ? err.message : String(err),
      id: msg.id,
    };
    port.postMessage(response);
  }
});
