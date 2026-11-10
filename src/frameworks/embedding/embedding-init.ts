/**
 * embedding 服务初始化：live/backfill 双 lane 的 fork 装配 + dispose 聚合。
 */

import { fork } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import type { Logger } from "@usecases/ports/logger";
import { EmbeddingServiceImpl, type WorkerFactory } from "./embedding-service";
import { deriveIntraOpThreads, detectPhysicalCores } from "./embedding-thread-plan";
import type { EmbeddingLaneName } from "@usecases/memory/embedding-gateway";
import { resolveEmbeddingDtype } from "./embedding-env-config";

export interface EmbeddingConfig {
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

/** Noop Logger 实现 */
const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

/**
 * fork 两个独立子进程，各自加载一份 bge-m3：
 * - liveService：search_memory 查询 + StoreMemory 实时写（短请求、fail-fast）
 * - backfillService：持久化队列回填（逐条 progress、无墙钟批死线）
 *
 * 为什么必须分进程：onnxruntime 1.23.2 要求 worker 内串行（MAX_IN_FLIGHT=1，
 * 长文×并发>1 必死锁）——串行是原生约束，但「串行」≠「共用一条队列」。
 * 共用时回填/写入把查询排队拖死（处理直接影响读）。两进程各自串行，互不排队。
 * 代价：两份模型常驻；Q8 默认显著低于 fp32 双实例内存，不引入第三份 query 模型。
 */
export async function initEmbeddingService(
  embedConfig?: EmbeddingConfig,
  logger?: Logger,
): Promise<{
  liveService: EmbeddingServiceImpl;
  backfillService: EmbeddingServiceImpl;
  dispose: () => void;
}> {
  const workerPath = embedConfig?.workerPath ?? path.join(__dirname, "bge-m3-worker.js");
  const physicalCores = detectPhysicalCores();
  const makeFactory = (lane: EmbeddingLaneName): WorkerFactory => () => fork(workerPath, [], {
    ...(embedConfig?.workerExecArgv ? { execArgv: embedConfig.workerExecArgv } : {}),
    env: {
      ...process.env,
      OTTER_EMBED_WORKER_CONFIG: JSON.stringify({
        modelPath: embedConfig?.modelPath ?? "Xenova/bge-m3",
        localModelPath: embedConfig?.localModelPath,
        lane,
        intraOpThreads: deriveIntraOpThreads(lane, physicalCores, process.env.OTTER_EMBED_INTRA_OP_THREADS),
        dtype: resolveEmbeddingDtype(process.env.OTTER_EMBED_DTYPE),
      }),
    },
    serialization: "advanced",
  });
  const makeService = (lane: EmbeddingLaneName): EmbeddingServiceImpl => {
    const factory = makeFactory(lane);
    return new EmbeddingServiceImpl(factory(), logger || noopLogger, factory, { lane });
  };
  const liveService = makeService("live");
  const backfillService = makeService("backfill");

  return {
    liveService,
    backfillService,
    dispose: () => {
      liveService.dispose();
      backfillService.dispose();
    },
  };
}
