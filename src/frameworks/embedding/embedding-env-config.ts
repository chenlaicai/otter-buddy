/**
 * Embedding worker 环境配置解析（纯函数，可单测）。
 *
 * 从 workerData 接收的 WorkerConfig + 进程环境（cwd/HF_ENDPOINT）派生 transformers.js env 设置，
 * 避免在 worker 入口（top-level throw 无 parentPort）直接做逻辑导致无法测试。
 */
import path from "node:path";

/** worker 接收的配置（主线程通过 workerData 透传） */
export interface WorkerConfig {
  /** 模型标识：local 模式下为 localModelPath 下的目录名；remote 模式下为 HF repo id（如 Xenova/bge-m3） */
  modelPath?: string;
  /** 本地模型根目录（相对 process.cwd() 或绝对）。设置后启用本地加载、禁用远程下载 */
  localModelPath?: string;
}

/** 解析后的 transformers.js env 设置 */
export interface ResolvedEnvSettings {
  allowLocalModels: boolean;
  allowRemoteModels: boolean;
  /** 本地模式下的模型根目录（绝对路径） */
  localModelPath?: string;
  /** 远程模式下的镜像 host（含尾斜杠，与 transformers.js 默认值格式一致） */
  remoteHost?: string;
  /** 传给 pipeline 的 model id */
  modelId: string;
}

const DEFAULT_MODEL_ID = "Xenova/bge-m3";

/**
 * 从 WorkerConfig + 进程环境派生 transformers.js env 设置。
 *
 * - local 模式（localModelPath 设了）：禁用远程，localModelPath 解析为绝对路径
 * - remote 模式（默认）：尊重 HF_ENDPOINT 环境变量支持镜像
 */
export function resolveEnvSettings(
  cfg: WorkerConfig,
  cwd: string = process.cwd(),
  hfEndpointEnv: string | undefined = process.env.HF_ENDPOINT,
): ResolvedEnvSettings {
  const modelId = cfg.modelPath ?? DEFAULT_MODEL_ID;

  if (cfg.localModelPath) {
    return {
      allowLocalModels: true,
      allowRemoteModels: false,
      localModelPath: path.resolve(cwd, cfg.localModelPath),
      modelId,
    };
  }

  const settings: ResolvedEnvSettings = {
    allowLocalModels: false,
    allowRemoteModels: true,
    modelId,
  };
  if (hfEndpointEnv) {
    // transformers.js v4 pathJoin 自动处理首尾斜杠，此处补尾斜杠是与默认值 `https://huggingface.co/`
    // 格式保持一致的防御性处理（避免未来版本改为直接字符串拼接时出错）
    settings.remoteHost = hfEndpointEnv.endsWith("/") ? hfEndpointEnv : `${hfEndpointEnv}/`;
  }
  return settings;
}
