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
  /** 模型输入能力（多模态 Phase 1）：["text"] 或 ["text","image"]。
   *  显式声明后经 models-factory 覆盖 provider 模板默认值（消除隐式继承的静默变更风险）。
   *  SDK downgradeUnsupportedImages 按 Model.input 自动降级非 vision 模型的图片。 */
  input?: Array<"text" | "image">;
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
    /** LLM prompt 缓存长留存（F20260829cach）：true 时 SDK 请求携带
     *  cache_control.ttl="1h"，缓存命中窗口从默认 5 分钟扩到 1 小时。
     *  机制：bootstrap 启动时注入环境变量 PI_CACHE_RETENTION=long，
     *  pi-ai anthropic-messages 适配器读该 env 发 ttl 标记。 */
    cacheLongRetention?: boolean;
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
    /** F20260831cbkw：熔断创建的 session 年龄窗口阈值（ms）——超过此时间视为「已证明健康」，允许再次熔断 */
    healthySessionThresholdMs: number;
  };
  feishu?: {
    appId: string;
    appSecret: string;
    encryptKey?: string;
    /** 搭档（本实例主人）的飞书 open_id（F20260826fpbd）——搭档身份静态锚定，未配置时降级动态推断 */
    partnerOpenId?: string;
  };
  /** 微信通道（issue #565）——协议直连 ilink，无需 appId/Secret（扫码授权） */
  weixin?: {
    /** ilink 网关 base URL（默认 https://ilinkai.weixin.qq.com） */
    baseUrl?: string;
    /** 账号/游标持久化目录（默认 ./data/weixin） */
    stateDir?: string;
    /** 搭档的微信 ilink_user_id（命令门禁锚定，同 feishu.partnerOpenId 语义） */
    partnerUserId?: string;
    /** 静默多久（分钟）后发 context_token 预警（F20260901wxnt，默认 60；显式 0 关闭） */
    contextTokenWarnMinutes?: number;
    /** 同一用户两次预警最小间隔（分钟，默认 60；显式 0 关闭） */
    contextTokenWarnCooldownMinutes?: number;
  };
  inbound?: {
    recruiting?: {
      apiKey: string;
    };
  };
  /** Web 端 base URL,用于 IM 信道 html-card 占位符拼接跳转链接(F20260812fmdr) */
  web?: {
    baseUrl?: string;
  };
  /** 附件配置（多模态 Phase 1）。缺省全部用内置默认值 */
  attachments?: {
    /** 存储根目录（相对仓库根或绝对路径，默认 ./data/attachments） */
    storageRoot?: string;
    /** 图片大小上限（字节，默认 10MB）——Content-Length 预检 + 流式计数双重限制 */
    maxImageBytes?: number;
    /** 文档大小上限（字节，默认 20MB） */
    maxDocumentBytes?: number;
  };
}

/**
 * 更新 config.yaml 中的 llm.default 字段。
 * config.yaml 是默认模型的唯一真相源（替代原 settings DB 覆盖机制）。
 * Why: 用 write-to-temp + rename 而非 writeFileSync 同路径——
 * 同路径 writeFileSync 是 truncate+write，进程崩溃时会丢失原文件；
 * rename 在同文件系统下是原子操作，保证不会写到一半损坏配置。
 */
export function updateDefaultModelInYaml(
  alias: string,
  modelPool: { hasModel(alias: string): boolean },
  logger?: Logger,
  configPath: string = CONFIG_PATH,
): void {
  if (!modelPool.hasModel(alias)) {
    throw new Error(`模型别名 "${alias}" 不存在于 config.yaml models[] 中`);
  }

  const raw = yaml.load(fs.readFileSync(configPath, "utf8")) as RawConfig;
  if (!raw.llm) raw.llm = {};

  if (raw.llm.default === alias) return; // 无需更新

  raw.llm.default = alias;
  const content = yaml.dump(raw, { lineWidth: -1, noRefs: true });

  // Why: write-to-temp + rename —— rename 在同文件系统下是原子的，
  // 避免 truncate+write 模式下进程崩溃导致配置文件损坏
  const tmpPath = configPath + ".tmp";
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, configPath);

  if (logger) {
    logger.info(`config.yaml llm.default 已更新为: ${alias}`);
  }
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
    /** LLM prompt 缓存长留存开关（F20260829cach，缺省 true） */
    cacheLongRetention?: boolean;
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
      input?: Array<"text" | "image">;
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
    healthySessionThresholdMs?: number;
  };
  feishu?: {
    appId?: string;
    appSecret?: string;
    encryptKey?: string;
    /** 搭档（本实例主人）的飞书 open_id（F20260826fpbd） */
    partnerOpenId?: string;
  };
  weixin?: {
    /** ilink 网关（默认 https://ilinkai.weixin.qq.com） */
    baseUrl?: string;
    /** 账号/游标持久化目录（默认 ./data/weixin） */
    stateDir?: string;
    /** 搭档的微信 ilink_user_id（命令门禁，同 feishu.partnerOpenId 语义） */
    partnerUserId?: string;
    /** 静默多久（分钟）后发 context_token 预警（F20260901wxnt） */
    contextTokenWarnMinutes?: number;
    /** 同一用户两次预警最小间隔（分钟） */
    contextTokenWarnCooldownMinutes?: number;
  };
  inbound?: {
    recruiting?: {
      apiKey?: string;
    };
  };
  web?: {
    baseUrl?: string;
  };
  attachments?: {
    storageRoot?: string;
    maxImageBytes?: number;
    maxDocumentBytes?: number;
  };
}

// eslint env 说明：mjs 无 TS 环境，btoa 在 node 22+ 全局可用
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

  // F20260901wxnt：contextTokenWarn* 非数字时下游 Math.max 返回 NaN → 预警条件双旁路 → 每 35s 轰炸全部用户
  if (raw.weixin) validateWeixinWarnConfig(raw.weixin);
}

/** 传入值→有限数，非法回退默认值（F20260901wxnt 发现1：YAML "60min" → NaN → 全轰炸） */
function safeFinite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 预警窗口构造（F20260901wxnt）：单键显式 0 即关闭；未配置默认 60min；clamp 下限 1 分钟（防 35s 误报）。
 * 非有限数（NaN/Infinity，如 YAML "60min"）由 safeFinite 回退默认——与 validate() 启动报错构成双层防线（构造层兑底）。
 * 归属 weixin 配置域，供 platforms.ts 装配层直接消费。
 */
export function buildContextTokenWarnConfig(
  weixin: AppConfig["weixin"],
): { afterMs: number; cooldownMs: number } | undefined {
  if (weixin?.contextTokenWarnMinutes === 0 || weixin?.contextTokenWarnCooldownMinutes === 0) return undefined;
  return {
    afterMs: Math.max(safeFinite(weixin?.contextTokenWarnMinutes, 60), 1) * 60_000,
    cooldownMs: Math.max(safeFinite(weixin?.contextTokenWarnCooldownMinutes, 60), 1) * 60_000,
  };
}

/** 校验 weixin contextTokenWarn* 字段合法性（正整数或 undefined，F20260901wxnt 发现1） */
function validateWeixinWarnConfig(weixin: NonNullable<RawConfig["weixin"]>): void {
  for (const [key, val] of Object.entries({ contextTokenWarnMinutes: weixin.contextTokenWarnMinutes, contextTokenWarnCooldownMinutes: weixin.contextTokenWarnCooldownMinutes })) {
    if (val !== undefined && (typeof val !== "number" || !Number.isInteger(val))) {
      throw new Error(`配置校验失败: weixin.${key} 必须是整数，当前值: ${String(val)}`);
    }
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
    healthySessionThresholdMs: d(raw.circuitBreaker?.healthySessionThresholdMs, 2 * 60 * 60 * 1000),
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
    partnerOpenId: raw.feishu.partnerOpenId?.trim() || undefined,
  };
}

/** 微信通道配置（issue #565）：有账号状态目录即启用（token 由 CLI 扫码落盘） */
function buildWeixinConfig(raw: RawConfig): AppConfig["weixin"] {
  const seg = raw.weixin ?? {};
  // 三字段全空 → 未启用；任一有值 → 给出完整默认（baseUrl/stateDir 有内置缺省）
  // Why: contextTokenWarn* 不参与启用判定——它们是已有 weixin 段的可选配置，
  // 单独配 warn 参数但不配 baseUrl/stateDir/partnerUserId 不应触发微信通道启动
  const anyConfigured = Boolean(seg.baseUrl || seg.stateDir || seg.partnerUserId);
  if (!anyConfigured) return undefined;
  return {
    baseUrl: seg.baseUrl?.trim() || "https://ilinkai.weixin.qq.com",
    stateDir: seg.stateDir?.trim() || "./data/weixin",
    partnerUserId: seg.partnerUserId?.trim() || undefined,
    contextTokenWarnMinutes: seg.contextTokenWarnMinutes,
    contextTokenWarnCooldownMinutes: seg.contextTokenWarnCooldownMinutes,
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

function buildWebConfig(raw: RawConfig): AppConfig["web"] {
  if (!raw.web?.baseUrl) return undefined;
  // 协议白名单(审视 F20260812fmdr R5):防止 javascript:/data: 等危险协议被注入到
  // 飞书侧 html-card 占位符的跳转链接里。配置异常时抛错阻止启动(快失败)
  if (!/^https?:\/\//i.test(raw.web.baseUrl)) {
    throw new Error(
      `配置校验失败: web.baseUrl 必须以 http:// 或 https:// 开头,当前值: ${raw.web.baseUrl}`,
    );
  }
  return { baseUrl: raw.web.baseUrl };
}

function buildAttachmentsConfig(raw: RawConfig): AppConfig["attachments"] {
  return {
    storageRoot: raw.attachments?.storageRoot ?? "./data/attachments",
    maxImageBytes: raw.attachments?.maxImageBytes ?? 10 * 1024 * 1024,
    maxDocumentBytes: raw.attachments?.maxDocumentBytes ?? 20 * 1024 * 1024,
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
        input: m.input ?? undefined,
      })),
      // F20260829cach: 缺省 true（实测 GLM anthropic 兼容端点接受 ttl 字段）
      cacheLongRetention: raw.llm.cacheLongRetention ?? true,
    },
    circuitBreaker: buildCircuitBreakerConfig(raw),
    feishu: buildFeishuConfig(raw),
    weixin: buildWeixinConfig(raw),
    inbound: buildInboundConfig(raw),
    web: buildWebConfig(raw),
    attachments: buildAttachmentsConfig(raw),
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
