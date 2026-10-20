/**
 * bge-m3 Embedding Worker（child_process.fork 子进程）。
 *
 * F20261015kill：从 worker_threads 迁到 child_process——
 * worker.terminate() 拆 isolate 时 onnxruntime N-API 回调抛 Napi::Error
 * 会 std::terminate 打死整个主进程（2026-10-15 21:22 实锤，.ips 栈
 * InferenceSessionWrap::InstanceMethodCallbackWrapper → abort）。
 * 子进程 SIGKILL 不跑析构/N-API teardown，原生死在子进程里主进程无感。
 *
 * 通信协议（F20260811mrpy Part 3：ready 携带 meta）：
 * 父进程 -> Worker: { type: 'embed', text: string, id: number }
 *          { type: 'embed-batch', texts: string[], id: number }
 * Worker -> 父进程:
 *   - { type: 'ready', meta: { modelId, modelRev, dim } }
 *   - { type: 'result', embedding: Float32Array, id: number }
 *   - { type: 'batch-result', embeddings: Float32Array[], id: number }
 *   - { type: 'error', error: string, id: number }
 */

import { resolveEnvSettings, type WorkerConfig } from "./embedding-env-config";

if (typeof process.send !== "function") {
  throw new Error("embedding worker must be started via child_process.fork (IPC channel)");
}

interface EmbedRequest {
  type: "embed";
  text: string;
  id: number;
}

/** F20261013ebps：批量 embed 请求 */
interface EmbedBatchRequest {
  type: "embed-batch";
  texts: string[];
  id: number;
}

/** F20260811mrpy Part 3：ready 携带的模型元信息 */
interface EmbedModelMeta {
  modelId: string;
  modelRev: string;
  dim: number;
}

type EmbedResponse =
  | { type: "ready"; meta: EmbedModelMeta }
  | { type: "result"; embedding: Float32Array; id: number }
  | { type: "batch-result"; embeddings: Float32Array[]; id: number }
  | { type: "error"; error: string; id: number };

type Extractor = (text: string | string[], options?: unknown) => Promise<{ data: Float32Array; dims: number[] }>;

/** F20261015kill：父进程 fork 时用 env 传配置（fork 无 workerData） */
function readWorkerConfig(): WorkerConfig {
  const raw = process.env.OTTER_EMBED_WORKER_CONFIG;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as WorkerConfig;
  } catch {
    return {};
  }
}

function post(msg: EmbedResponse): void {
  // serialization:'advanced' 下 TypedArray 走 structured clone，保真
  process.send?.(msg);
}

/**
 * 解析 OTTER_EMBED_INTRA_OP_THREADS（#1107 检视处置）：非法值（NaN/<1）不可静默
 * 回退到 onnxruntime 默认（=物理核数，钳制失效不可见）——warn 后回落到 2。
 */
function resolveIntraOpThreads(): number {
  const raw = process.env.OTTER_EMBED_INTRA_OP_THREADS;
  if (raw === undefined) return 2;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    // eslint-disable-next-line no-console -- worker 子进程内无 logger，console.warn 兜底
    console.warn(`[embedding] OTTER_EMBED_INTRA_OP_THREADS="${raw}" 非法，回落默认 2`);
    return 2;
  }
  return n;
}

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

      const cfg = readWorkerConfig();
      const settings = resolveEnvSettings(cfg);

      env.allowLocalModels = settings.allowLocalModels;
      env.allowRemoteModels = settings.allowRemoteModels;
      if (settings.localModelPath) env.localModelPath = settings.localModelPath;
      if (settings.remoteHost) env.remoteHost = settings.remoteHost;

      const pipe = await pipeline("feature-extraction", settings.modelId, {
        dtype: "fp32",
        // #1107: 钳制 onnxruntime intra-op 线程数。默认 = 物理核数，单条 embed 期间
        // 线程池忙等自旋（SpinPause 不放核）把进程 CPU 打到 ~9 核，挤压主事件循环。
        // embedding 是 worker 内串行队列处理，intra-op 2 线程足够（实测延迟仅微增）；
        // OTTER_EMBED_INTRA_OP_THREADS 可覆盖（紧急调参逃生口，不进配置 schema）。
        session_options: {
          intraOpNumThreads: resolveIntraOpThreads(),
        },
      });
      return (text: string | string[], options?: unknown) =>
        (pipe as (text: string | string[], options?: unknown) => Promise<{ data: Float32Array; dims: number[] }>)(
          text,
          options ?? { pooling: "cls", normalize: true },
        );
    })();
  }
  return extractorPromise;
}

// 预加载模型 + dummy embed 拿 dims（F20260811mrpy Part 3）
getExtractor()
  .then(async (fn) => {
    // dummy embed 拿实际维度（transformers.js pipeline 无公开 .config.dim）
    const dummy = await fn("ping");
    const meta: EmbedModelMeta = {
      modelId: resolveEnvSettings(readWorkerConfig()).modelId,
      modelRev: "unknown",
      // dims 是形状数组 [batch, dim]，取最后一维才是向量维度——取 [0] 会恒拿到 batch=1
      dim: dummy.dims[dummy.dims.length - 1],
    };
    post({ type: "ready", meta });
  })
  .catch((err: unknown) => {
    post({
      type: "error",
      error: err instanceof Error ? err.message : String(err),
      id: -1,
    });
  });

/**
 * F20261020slvg：显式串行队列——promise chain 保证同一时刻最多一个推理在途。
 * 现状 onnxruntime-node 的 session.run 原生同步阻塞，事件循环停摆期间后续消息
 * 排队，「偶然串行」；显式 chain 把这一不变量写进代码——未来换异步 backend /
 * IOBinding / 改回 worker_threads 时不依赖偶然性（onnxruntime 1.23.2 长文本 ×
 * 并发>1 的 lost-wakeup 死锁前提是并发，串行是硬约束）。
 * 原生挂死时 chain 停摆——由主进程侧无进展看门狗兜底（语义不变）。
 */
let inferenceChain: Promise<void> = Promise.resolve();

/** 单条/批量请求的串行处理体（原 process.on 直接挂载的逻辑，不变） */
async function handleInferenceMessage(msg: EmbedRequest | EmbedBatchRequest): Promise<void> {
  if (msg.type === "embed") {
    try {
      const fn = await getExtractor();
      const output = await fn(msg.text);
      post({ type: "result", embedding: output.data, id: msg.id });
    } catch (err: unknown) {
      post({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
        id: msg.id,
      });
    }
    return;
  }

  // F20261013ebps：批量 embed——pipeline 原生支持数组输入，batch 推理共享开销
  if (msg.type === "embed-batch") {
    try {
      const fn = await getExtractor();
      const output = await fn(msg.texts);
      // output.dims = [batch, dim]，data 是连续 Float32Array（batch × dim）
      const dim = output.dims[output.dims.length - 1];
      const embeddings: Float32Array[] = [];
      for (let i = 0; i < msg.texts.length; i++) {
        embeddings.push(output.data.slice(i * dim, (i + 1) * dim));
      }
      post({ type: "batch-result", embeddings, id: msg.id });
    } catch (err: unknown) {
      post({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
        id: msg.id,
      });
    }
  }
}

process.on("message", (msg: EmbedRequest | EmbedBatchRequest) => {
  // F20261020slvg：吞错保险丝——handle 内部已逐分支 try/catch，此处防御性
  // 保证 chain 永不断裂（断裂会静默停摆整个 worker）
  inferenceChain = inferenceChain
    .then(() => handleInferenceMessage(msg))
    .catch(() => {
      /* unreachable：handle 内全量 try/catch */
    });
});

// 父进程 kill/断连：直接退出，不留半死孤儿
process.on("disconnect", () => process.exit(0));
