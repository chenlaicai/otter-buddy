/**
 * 统一配置读取模块。
 * 从 config/config.yaml 读取配置，进行校验，导出不可变配置对象。
 * 替代原 config.ts（process.env 方式）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import type { Logger } from "@usecases/ports/logger";

/** 单个模型配置 */
export interface ModelConfig {
  alias: string;
  provider: string;
  model: string;
  apiKey?: string;
  apiBaseUrl?: string;
  description?: string;
  strengths?: string[];
  weaknesses?: string[];
  contextWindow?: number;
  /** 最大输出 tokens（自定义模型注入 SDK 时携带，缺省回退 provider 模板值，F20260808ctxw） */
  maxTokens?: number;
}

/** 应用配置结构（与原 config.ts 同构） */
export interface AppConfig {
  db: {
    path: string;
    walMode: boolean;
    foreignKeys: boolean;
  };
  server: {
    port: number;
  };
  memory: {
    rrfK: number;
    /** Vec 权重（0-1），0=纯 FTS，1=纯 Vec，默认 0.4（偏信任 FTS） */
    alpha: number;
    /** Vec 相似度阈值，低于此值的结果被过滤，默认 0.3 */
    vecSimilarityThreshold: number;
    /** 两路命中（source=both）的加成系数，默认 1.2 */
    bothBoost: number;
    weightHalfLifeDays: number;
    userFlagMultiplier: number;
    frequencyBoostFactor: number;
  };
  embedding: {
    dimensions: number;
    modelPath: string;
    /** 本地模型根目录。设置后走本地加载（不联网下载），modelPath 作为其下子目录名 */
    localModelPath?: string;
    /** worker 脚本路径覆盖（测试用：vitest 下 dist 编译产物不存在于 src 树），默认取本模块同目录的 bge-m3-worker.js */
    workerPath?: string;
    /** worker 线程 execArgv 覆盖（测试用：vitest 注入的 --conditions 会让 worker 内模型库解析错乱），默认继承 process.execArgv */
    workerExecArgv?: string[];
  };
  llm: {
    /** 默认模型 alias（必须在 models[] 中） */
    default: string;
    /** 模型列表（唯一真相源，至少一条） */
    models: ModelConfig[];
  };
  circuitBreaker: {
    maxConsecutiveIdentical: number;
    maxPerEventTimeMs: number;
    slidingWindowSize: number;
    slidingWindowRepeat: number;
    maxRepeatAfterWarning: number;
    tokenWarningThreshold: number;
    maxChainDepth: number;
    outputGuard: {
      enabled: boolean;
      /** 退化检测器参数（F20260804dglp 双机制） */
      detector: {
        windowLength: number;
        maxWindowRepeats: number;
        minBlockLength: number;
        distinctRatioThreshold: number;
      };
    };
    streamingTimeoutMs: number;
    /** 首字节超时（F20260804dglp）：prompt 后无 delta 的挂死保护 */
    firstByteTimeoutMs: number;
  };
  feishu?: {
    appId: string;
    appSecret: string;
    encryptKey?: string;
  };
  inbound?: {
    recruiting?: {
      apiKey: string;
    };
  };
}

/** config.yaml 的原始 YAML 结构 */
interface RawConfig {
  server?: { port?: number };
  database?: {
    path?: string;
    walMode?: boolean;
    foreignKeys?: boolean;
  };
  llm?: {
    default?: string;
    models?: Array<{
      alias?: string;
      provider?: string;
      model?: string;
      apiKey?: string;
      apiBaseUrl?: string;
      description?: string;
      strengths?: string[];
      weaknesses?: string[];
      contextWindow?: number;
      maxTokens?: number;
    }>;
  };
  memory?: {
    rrfK?: number;
    alpha?: number;
    vecSimilarityThreshold?: number;
    bothBoost?: number;
    weightHalfLifeDays?: number;
    userFlagMultiplier?: number;
    frequencyBoostFactor?: number;
  };
  embedding?: {
    dimensions?: number;
    modelPath?: string;
    localModelPath?: string;
  };
  circuitBreaker?: {
    maxToolCalls?: number;
    maxConsecutiveIdentical?: number;
    maxPerEventTimeMs?: number;
    warningThreshold?: number;
    slidingWindowSize?: number;
    slidingWindowRepeat?: number;
    maxRepeatAfterWarning?: number;
    tokenWarningThreshold?: number;
    maxChainDepth?: number;
    outputGuard?: {
      enabled?: boolean;
      detector?: {
        windowLength?: number;
        maxWindowRepeats?: number;
        minBlockLength?: number;
        distinctRatioThreshold?: number;
      };
    };
    streamingTimeoutMs?: number;
    firstByteTimeoutMs?: number;
  };
  feishu?: {
    appId?: string;
    appSecret?: string;
    encryptKey?: string;
  };
  inbound?: {
    recruiting?: {
      apiKey?: string;
    };
  };
}

const CONFIG_PATH = path.resolve(process.cwd(), "config/config.yaml");

const VALID_PROVIDERS = ["openai", "anthropic", "kimi-coding"];

/** 取值或默认值 */
function d<T>(value: T | undefined, fallback: T): T {
  return value !== undefined ? value : fallback;
}

/**
 * 校验模型配置（llm.models[]）。
 * 填充 default 值（缺省时取第一个模型）。
 */
function validateModels(raw: RawConfig): void {
  const models = raw.llm!.models!;

  // 校验每个 model 条目
  for (const m of models) {
    if (!m.alias) throw new Error("配置校验失败: llm.models[] 中存在缺少 alias 的条目");
    if (!m.provider) throw new Error(`配置校验失败: llm.models["${m.alias}"].provider 为必填字段`);
    if (!m.model) throw new Error(`配置校验失败: llm.models["${m.alias}"].model 为必填字段`);
    if (!VALID_PROVIDERS.includes(m.provider)) {
      throw new Error(`配置校验失败: llm.models["${m.alias}"].provider 必须是 ${VALID_PROVIDERS.join(" / ")}，当前值: ${m.provider}`);
    }
  }

  // 校验 alias 唯一性
  const aliases = models.map(m => m.alias!);
  const duplicates = aliases.filter((a, i) => aliases.indexOf(a) !== i);
  if (duplicates.length > 0) {
    throw new Error(`配置校验失败: llm.models[] 中存在重复的 alias: ${duplicates.join(", ")}`);
  }

  // 校验 default 有效性
  if (raw.llm!.default && !aliases.includes(raw.llm!.default)) {
    throw new Error(`配置校验失败: llm.default "${raw.llm!.default}" 不在 models[] 中。可用 alias: ${aliases.join(", ")}`);
  }

  // default 缺省时使用第一个模型
  if (!raw.llm!.default) {
    raw.llm!.default = models[0].alias;
  }
}

/** 校验必填字段和类型，失败直接抛异常（导出供测试） */
export function validate(raw: RawConfig): asserts raw is RawConfig & { llm: { default: string; models: ModelConfig[] } } {
  if (!raw.llm?.models || raw.llm.models.length === 0) {
    throw new Error("配置校验失败: llm.models[] 为必填字段（至少一个模型条目，单模型配置也请写为一条 models[] 条目）");
  }
  validateModels(raw);

  if (raw.server?.port !== undefined && typeof raw.server.port !== "number") {
    throw new Error("配置校验失败: server.port 必须是数字");
  }
}

function buildDbConfig(raw: RawConfig): AppConfig["db"] {
  return {
    path: d(raw.database?.path, "./otter-buddy.db"),
    walMode: d(raw.database?.walMode, true),
    foreignKeys: d(raw.database?.foreignKeys, true),
  };
}

function buildMemoryConfig(raw: RawConfig): AppConfig["memory"] {
  return {
    rrfK: d(raw.memory?.rrfK, 60),
    alpha: d(raw.memory?.alpha, 0.4),
    vecSimilarityThreshold: d(raw.memory?.vecSimilarityThreshold, 0.3),
    bothBoost: d(raw.memory?.bothBoost, 1.2),
    weightHalfLifeDays: d(raw.memory?.weightHalfLifeDays, 7),
    userFlagMultiplier: d(raw.memory?.userFlagMultiplier, 2.0),
    frequencyBoostFactor: d(raw.memory?.frequencyBoostFactor, 0.1),
  };
}

function buildOutputGuardConfig(raw: RawConfig): AppConfig["circuitBreaker"]["outputGuard"] {
  const rawDetector = raw.circuitBreaker?.outputGuard?.detector;
  return {
    enabled: d(raw.circuitBreaker?.outputGuard?.enabled, true),
    detector: {
      windowLength: d(rawDetector?.windowLength, 100),
      maxWindowRepeats: d(rawDetector?.maxWindowRepeats, 50),
      minBlockLength: d(rawDetector?.minBlockLength, 5000),
      distinctRatioThreshold: d(rawDetector?.distinctRatioThreshold, 0.3),
    },
  };
}

function buildCircuitBreakerConfig(raw: RawConfig): AppConfig["circuitBreaker"] {
  return {
    maxConsecutiveIdentical: d(raw.circuitBreaker?.maxConsecutiveIdentical, 5),
    maxPerEventTimeMs: d(raw.circuitBreaker?.maxPerEventTimeMs, 600000),
    slidingWindowSize: d(raw.circuitBreaker?.slidingWindowSize, 6),
    slidingWindowRepeat: d(raw.circuitBreaker?.slidingWindowRepeat, 3),
    maxRepeatAfterWarning: d(raw.circuitBreaker?.maxRepeatAfterWarning, 5),
    tokenWarningThreshold: d(raw.circuitBreaker?.tokenWarningThreshold, 50000),
    maxChainDepth: d(raw.circuitBreaker?.maxChainDepth, 100),
    outputGuard: buildOutputGuardConfig(raw),
    streamingTimeoutMs: d(raw.circuitBreaker?.streamingTimeoutMs, 120000),
    firstByteTimeoutMs: d(raw.circuitBreaker?.firstByteTimeoutMs, 300000),
  };
}

function buildFeishuConfig(raw: RawConfig): AppConfig["feishu"] {
  if (!raw.feishu?.appId || !raw.feishu?.appSecret) {
    return undefined;
  }
  return {
    appId: raw.feishu.appId,
    appSecret: raw.feishu.appSecret,
    encryptKey: raw.feishu.encryptKey ?? undefined,
  };
}

function buildInboundConfig(raw: RawConfig): AppConfig["inbound"] {
  if (!raw.inbound?.recruiting?.apiKey) {
    return undefined;
  }
  return {
    recruiting: {
      apiKey: raw.inbound.recruiting.apiKey,
    },
  };
}

/** 将 RawConfig 补全默认值，构建 AppConfig */
function applyDefaults(raw: RawConfig & { llm: { default: string; models: ModelConfig[] } }): AppConfig {
  return {
    db: buildDbConfig(raw),
    server: { port: d(raw.server?.port, 3000) },
    memory: buildMemoryConfig(raw),
    embedding: {
      dimensions: d(raw.embedding?.dimensions, 1024),
      // 本地模式默认 modelPath 为目录名（models/bge-m3/）；远程模式默认为 HF repo id。
      // 用户设了 localModelPath 但没设 modelPath 时，本地目录名 "bge-m3" 才是正确默认。
      modelPath: d(raw.embedding?.modelPath, raw.embedding?.localModelPath ? "bge-m3" : "Xenova/bge-m3"),
      localModelPath: raw.embedding?.localModelPath ?? undefined,
    },
    llm: {
      default: raw.llm.default,
      // alias/provider/model 已由 validateModels 校验非空
      models: raw.llm.models.map(m => ({
        alias: m.alias!,
        provider: m.provider!,
        model: m.model!,
        apiKey: m.apiKey ?? undefined,
        apiBaseUrl: m.apiBaseUrl ?? undefined,
        description: m.description ?? undefined,
        strengths: m.strengths ?? undefined,
        weaknesses: m.weaknesses ?? undefined,
        contextWindow: m.contextWindow ?? undefined,
        maxTokens: m.maxTokens ?? undefined,
      })),
    },
    circuitBreaker: buildCircuitBreakerConfig(raw),
    feishu: buildFeishuConfig(raw),
    inbound: buildInboundConfig(raw),
  };
}

/**
 * 读取并解析 config.yaml，校验必填字段和类型。
 * 启动时调用一次，校验失败直接抛出异常终止进程。
 * 导出供测试使用。
 */
export function loadConfig(logger?: Logger, configPath: string = CONFIG_PATH): AppConfig {
  if (!fs.existsSync(configPath)) {
    const error = new Error(
      `配置文件不存在: ${configPath}\n` +
      "请复制 config/config.yaml.example 为 config/config.yaml 并填入实际配置。",
    );

    // 记录配置加载失败日志
    if (logger) {
      logger.error('Configuration loading failed', error, {
        configPath,
        reason: 'file_not_found',
      });
    }

    throw error;
  }

  const raw = yaml.load(fs.readFileSync(configPath, "utf8")) as RawConfig;
  validate(raw);
  const config = applyDefaults(raw);

  // 记录配置加载成功日志
  if (logger) {
    logger.info('Configuration loaded', {
      configPath,
      defaultModel: config.llm.default,
      modelCount: config.llm.models.length,
      port: config.server.port,
    });
  }

  return config;
}
