/**
 * bge-m3 Embedding Worker Thread。
 *
 * 通信协议：
 * 主线程 -> Worker: { type: 'embed', text: string, id: number }
 * Worker -> 主线程: { type: 'ready' } | { type: 'result', embedding: Float32Array, id: number } | { type: 'error', error: string, id: number }
 */

import { parentPort, workerData } from "worker_threads";
import path from "node:path";

if (!parentPort) {
  throw new Error("embedding worker must be started as a Worker Thread");
}

const port = parentPort;

interface WorkerConfig {
  /** 模型标识：local 模式下为 localModelPath 下的目录名；remote 模式下为 HF repo id（如 Xenova/bge-m3） */
  modelPath: string;
  /** 本地模型根目录（相对 process.cwd() 或绝对）。设置后启用本地加载、禁用远程下载 */
  localModelPath?: string;
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

let extractor: ((text: string, options?: unknown) => Promise<{ data: Float32Array; dims: number[] }>) | null = null;

/** 懒加载 bge-m3 模型（首次调用时加载） */
async function getExtractor(): Promise<typeof extractor> {
  if (!extractor) {
    const { pipeline, env } = await import("@huggingface/transformers");

    const cfg = (workerData ?? {}) as WorkerConfig;
    if (cfg.localModelPath) {
      // 本地加载：模型文件已预置，禁用远程避免触发下载
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      env.localModelPath = path.resolve(process.cwd(), cfg.localModelPath);
    } else {
      // 远程加载：尊重 HF_ENDPOINT 环境变量以支持镜像（如 https://hf-mirror.com/）
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      const hfEndpoint = process.env.HF_ENDPOINT;
      if (hfEndpoint) {
        env.remoteHost = hfEndpoint.endsWith("/") ? hfEndpoint : `${hfEndpoint}/`;
      }
    }
    const modelId = cfg.modelPath ?? "Xenova/bge-m3";

    const pipe = await pipeline("feature-extraction", modelId, {
      dtype: "fp32",
    });
    extractor = async (text: string, options?: unknown) => {
      const output = await (pipe as (text: string, options?: unknown) => Promise<{ data: Float32Array; dims: number[] }>)(
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
