/**
 * bge-m3 Embedding Worker Thread。
 *
 * 在 Worker Thread 中运行 bge-m3 模型，提供 text->vector 服务。
 * 不直接访问数据库（D-S3-1：纯 text->vector 服务）。
 *
 * 通信协议：
 * 主线程 -> Worker: { type: 'embed', text: string, id: number }
 * Worker -> 主线程: { type: 'result', embedding: Float32Array, id: number }
 * Worker -> 主线程: { type: 'error', error: string, id: number }
 * Worker -> 主线程: { type: 'ready' }（模型加载完成）
 */

import { parentPort } from "worker_threads";

if (!parentPort) {
  throw new Error("embedding worker must be started as a Worker Thread");
}

const port = parentPort;

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

let extractor: ((text: string, options?: unknown) => Promise<{ data: Float32Array; dims: number[] }>) | null = null;

/** 懒加载 bge-m3 模型（首次调用时加载） */
async function getExtractor(): Promise<typeof extractor> {
  if (!extractor) {
    const { pipeline } = await import("@huggingface/transformers");
    const pipe = await pipeline("feature-extraction", "Xenova/bge-m3", {
      dtype: "fp32",
    });
    extractor = async (text: string, options?: unknown) => {
      const output = await (pipe as (text: string, options?: unknown) => Promise<{
        data: Float32Array;
        dims: number[];
      }>)(
        text,
        options ?? { pooling: "cls", normalize: true },
      );
      return output;
    };
    const response: EmbedResponse = { type: "ready" };
    port.postMessage(response);
  }
  return extractor;
}

// 预加载模型
getExtractor().catch((err: unknown) => {
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
    if (!fn) {
      throw new Error("Embedding model not loaded");
    }

    const output = await fn(msg.text);
    // 提取第一行向量（dims = [1, 1024]）
    const embedding = output.data;

    const response: EmbedResponse = {
      type: "result",
      embedding,
      id: msg.id,
    };
    // Float32Array 可以通过 structured clone 传输
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
