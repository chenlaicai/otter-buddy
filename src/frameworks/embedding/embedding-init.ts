/**
 * F20261020slvg：embedding 服务初始化（从 embedding-service.ts 拆出，压文件行数上限）。
 * 读写双 lane 的 fork 装配 + dispose 聚合。
 */

import { fork } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { Logger } from "@usecases/ports/logger";
import { EmbeddingServiceImpl, type WorkerFactory } from "./embedding-service";

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
 * 初始化 Embedding 服务（F20261016ebrt：读写双 lane）。
 *
 * fork 两个独立子进程，各自加载一份 bge-m3：
 * - queryService：只服务 search_memory 查询 embed（延迟优先，不排在回填后面）
 * - writeService：服务 store/sync/retry 回填 embed（吞吐优先，可放开了批量）
 *
 * 为什么必须分进程：onnxruntime 1.23.2 要求 worker 内串行（MAX_IN_FLIGHT=1，
 * 长文×并发>1 必死锁）——串行是原生约束，但「串行」≠「共用一条队列」。
 * 共用时回填/写入把查询排队拖死（处理直接影响读）。两进程各自串行，互不排队。
 * 代价：2 份 bge-m3 ≈ 4.5GB，比「重启时短暂双份 + 泄漏」更可控。
 */
export async function initEmbeddingService(
  embedConfig?: EmbeddingConfig,
  logger?: Logger,
): Promise<{ queryService: EmbeddingGateway; writeService: EmbeddingGateway; dispose: () => void }> {
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
  const queryService = new EmbeddingServiceImpl(workerFactory(), logger || noopLogger, workerFactory);
  const writeService = new EmbeddingServiceImpl(workerFactory(), logger || noopLogger, workerFactory);

  return {
    queryService,
    writeService,
    dispose: () => {
      queryService.dispose();
      writeService.dispose();
    },
  };
}
