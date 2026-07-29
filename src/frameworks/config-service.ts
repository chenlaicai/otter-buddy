/**
 * 统一配置读取模块。
 * 从 config/config.yaml 读取配置，进行校验，导出不可变配置对象。
 * 替代原 config.ts（process.env 方式）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import type { Logger } from "@usecases/ports/logger";

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
}

const CONFIG_PATH = path.resolve(process.cwd(), "config/config.yaml");

const VALID_PROVIDERS = ["openai", "anthropic"];

/** 取值或默认值 */
function d<T>(value: T | undefined, fallback: T): T {
  return value !== undefined ? value : fallback;
}

/** 校验必填字段和类型，失败直接抛异常（导出供测试） */
export function validate(raw: RawConfig): asserts raw is RawConfig & { llm: { provider: string; model: string } } {
  if (!raw.llm?.provider) {
    throw new Error("配置校验失败: llm.provider 为必填字段");
  }
  if (!raw.llm?.model) {
    throw new Error("配置校验失败: llm.model 为必填字段");
  }
  if (!VALID_PROVIDERS.includes(raw.llm.provider)) {
    throw new Error(
      `配置校验失败: llm.provider 必须是 ${VALID_PROVIDERS.join(" / ")}，当前值: ${raw.llm.provider}`,
    );
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
    maxChainDepth: d(raw.circuitBreaker?.maxChainDepth, 20),
    outputGuard: buildOutputGuardConfig(raw),
    streamingTimeoutMs: d(raw.circuitBreaker?.streamingTimeoutMs, 120000),
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
    },
    circuitBreaker: buildCircuitBreakerConfig(raw),
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

/** 不可变配置对象。启动时从 config.yaml 加载，运行期间不变。 */
export const config: AppConfig = Object.freeze(loadConfig());
