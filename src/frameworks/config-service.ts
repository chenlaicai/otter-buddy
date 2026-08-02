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
    weightHalfLifeDays: number;
    userFlagMultiplier: number;
    frequencyBoostFactor: number;
  };
  embedding: {
    dimensions: number;
    modelPath: string;
  };
  llm: {
    provider: string;
    model: string;
    apiKey?: string;
    apiBaseUrl?: string;
    /** 多模型配置：默认模型 alias */
    default?: string;
    /** 多模型配置：模型列表 */
    models?: ModelConfig[];
  };
  circuitBreaker: {
    maxToolCalls: number;
    maxConsecutiveIdentical: number;
    maxPerEventTimeMs: number;
    warningThreshold: number;
    slidingWindowSize: number;
    slidingWindowRepeat: number;
    maxRepeatAfterWarning: number;
    tokenWarningThreshold: number;
    maxChainDepth: number;
    outputGuard: {
      enabled: boolean;
      segmentLength: number;
      maxRepeatedSegments: number;
      checkInterval: number;
    };
    streamingTimeoutMs: number;
  };
  feishu?: {
    appId: string;
    appSecret: string;
    encryptKey?: string;
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
    provider?: string;
    model?: string;
    apiKey?: string;
    apiBaseUrl?: string;
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
    }>;
  };
  memory?: {
    rrfK?: number;
    weightHalfLifeDays?: number;
    userFlagMultiplier?: number;
    frequencyBoostFactor?: number;
  };
  embedding?: {
    dimensions?: number;
    modelPath?: string;
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
      segmentLength?: number;
      maxRepeatedSegments?: number;
      checkInterval?: number;
    };
    streamingTimeoutMs?: number;
  };
  feishu?: {
    appId?: string;
    appSecret?: string;
    encryptKey?: string;
  };
}

const CONFIG_PATH = path.resolve(process.cwd(), "config/config.yaml");

const VALID_PROVIDERS = ["openai", "anthropic"];

/** 取值或默认值 */
function d<T>(value: T | undefined, fallback: T): T {
  return value !== undefined ? value : fallback;
}

/**
 * 校验多模型配置（llm.models[]）。
 * 填充 default 值，为单模型兼容填充 provider/model。
 */
function validateMultiModel(raw: RawConfig): void {
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

  // 为单模型兼容填充 provider/model（使用 default 模型）
  const defaultModel = models.find(m => m.alias === raw.llm!.default)!;
  raw.llm!.provider = defaultModel.provider!;
  raw.llm!.model = defaultModel.model!;
  raw.llm!.apiKey = defaultModel.apiKey;
  raw.llm!.apiBaseUrl = defaultModel.apiBaseUrl;
}

/** 校验必填字段和类型，失败直接抛异常（导出供测试） */
export function validate(raw: RawConfig): asserts raw is RawConfig & { llm: { provider: string; model: string } } {
  // 多模型模式
  if (raw.llm?.models && raw.llm.models.length > 0) {
    validateMultiModel(raw);
  } else {
    // 单模型模式：传统校验
    if (!raw.llm?.provider) throw new Error("配置校验失败: llm.provider 为必填字段");
    if (!raw.llm?.model) throw new Error("配置校验失败: llm.model 为必填字段");
    if (!VALID_PROVIDERS.includes(raw.llm.provider)) {
      throw new Error(`配置校验失败: llm.provider 必须是 ${VALID_PROVIDERS.join(" / ")}，当前值: ${raw.llm.provider}`);
    }
  }

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
    weightHalfLifeDays: d(raw.memory?.weightHalfLifeDays, 7),
    userFlagMultiplier: d(raw.memory?.userFlagMultiplier, 2.0),
    frequencyBoostFactor: d(raw.memory?.frequencyBoostFactor, 0.1),
  };
}

function buildOutputGuardConfig(raw: RawConfig): AppConfig["circuitBreaker"]["outputGuard"] {
  return {
    enabled: d(raw.circuitBreaker?.outputGuard?.enabled, true),
    segmentLength: d(raw.circuitBreaker?.outputGuard?.segmentLength, 100),
    maxRepeatedSegments: d(raw.circuitBreaker?.outputGuard?.maxRepeatedSegments, 50),
    checkInterval: d(raw.circuitBreaker?.outputGuard?.checkInterval, 20),
  };
}

function buildCircuitBreakerConfig(raw: RawConfig): AppConfig["circuitBreaker"] {
  return {
    maxToolCalls: d(raw.circuitBreaker?.maxToolCalls, 40),
    maxConsecutiveIdentical: d(raw.circuitBreaker?.maxConsecutiveIdentical, 5),
    maxPerEventTimeMs: d(raw.circuitBreaker?.maxPerEventTimeMs, 600000),
    warningThreshold: d(raw.circuitBreaker?.warningThreshold, 20),
    slidingWindowSize: d(raw.circuitBreaker?.slidingWindowSize, 6),
    slidingWindowRepeat: d(raw.circuitBreaker?.slidingWindowRepeat, 3),
    maxRepeatAfterWarning: d(raw.circuitBreaker?.maxRepeatAfterWarning, 5),
    tokenWarningThreshold: d(raw.circuitBreaker?.tokenWarningThreshold, 50000),
    maxChainDepth: d(raw.circuitBreaker?.maxChainDepth, 100),
    outputGuard: buildOutputGuardConfig(raw),
    streamingTimeoutMs: d(raw.circuitBreaker?.streamingTimeoutMs, 120000),
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

/** 将 RawConfig 补全默认值，构建 AppConfig */
function applyDefaults(raw: RawConfig & { llm: { provider: string; model: string } }): AppConfig {
  return {
    db: buildDbConfig(raw),
    server: { port: d(raw.server?.port, 3000) },
    memory: buildMemoryConfig(raw),
    embedding: {
      dimensions: d(raw.embedding?.dimensions, 1024),
      modelPath: d(raw.embedding?.modelPath, "Xenova/bge-m3"),
    },
    llm: {
      provider: raw.llm.provider,
      model: raw.llm.model,
      apiKey: raw.llm.apiKey ?? undefined,
      apiBaseUrl: raw.llm.apiBaseUrl ?? undefined,
      default: raw.llm.default,
      models: raw.llm.models?.map(m => ({
        alias: m.alias!,
        provider: m.provider!,
        model: m.model!,
        apiKey: m.apiKey ?? undefined,
        apiBaseUrl: m.apiBaseUrl ?? undefined,
        description: m.description ?? undefined,
        strengths: m.strengths ?? undefined,
        weaknesses: m.weaknesses ?? undefined,
        contextWindow: m.contextWindow ?? undefined,
      })),
    },
    circuitBreaker: buildCircuitBreakerConfig(raw),
    feishu: buildFeishuConfig(raw),
  };
}

/**
 * 读取并解析 config.yaml，校验必填字段和类型。
 * 启动时调用一次，校验失败直接抛出异常终止进程。
 * 导出供测试使用。
 */
export function loadConfig(logger?: Logger): AppConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    const error = new Error(
      `配置文件不存在: ${CONFIG_PATH}\n` +
      "请复制 config/config.yaml.example 为 config/config.yaml 并填入实际配置。",
    );

    // 记录配置加载失败日志
    if (logger) {
      logger.error('Configuration loading failed', error, {
        configPath: CONFIG_PATH,
        reason: 'file_not_found',
      });
    }

    throw error;
  }

  const raw = yaml.load(fs.readFileSync(CONFIG_PATH, "utf8")) as RawConfig;
  validate(raw);
  const config = applyDefaults(raw);

  // 记录配置加载成功日志
  if (logger) {
    logger.info('Configuration loaded', {
      configPath: CONFIG_PATH,
      provider: config.llm.provider,
      model: config.llm.model,
      port: config.server.port,
    });
  }

  return config;
}
