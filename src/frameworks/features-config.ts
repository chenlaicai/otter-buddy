/**
 * F20260915cfgt：features 段归一化（从 config-service.ts 拆出，控文件行数）。
 *
 * 层职责边界（方案「层职责边界」段）：
 * - 本文件是纯函数：只读自身段 raw.features，不做任何推断——
 *   apiKey/DB 存量推断在装配层（bootstrap/feature-gates.ts）
 * - 三态输出：显式 true/false 原样保留；undefined = 未配置（缺省决策在装配层）
 */

import type { Logger } from "@usecases/ports/logger";

/** features 段的原始（未归一化）输入形状，与 config-service.RawConfig.features 同构 */
export interface RawFeatures {
  selfHealing?: boolean;
  paperTrading?: boolean;
  recruiting?: boolean;
}

export interface NormalizedFeatures {
  selfHealing: boolean | undefined;
  paperTrading: boolean | undefined;
  recruiting: boolean | undefined;
}

/** 归一化单字段：非法值（字符串等）归 undefined + warn；null（YAML 空值占位）归 undefined 不 warn */
function norm(key: keyof RawFeatures, v: boolean | null | undefined, logger?: Logger): boolean | undefined {
  if (typeof v === "boolean") return v;
  // Why 不对 null warn：YAML 里「key:」（空值）是常见占位写法，属合法未配置
  if (v !== undefined && v !== null) {
    logger?.warn(`config.features.${String(key)} 值非法（${JSON.stringify(v)}），按未配置处理`);
  }
  return undefined;
}

/** 附件段默认值（F20260915cfgt 从 config-service 迁来，控行数） */
export function buildRawAttachmentsConfig(raw: { attachments?: { storageRoot?: string; maxImageBytes?: number; maxDocumentBytes?: number } }): { storageRoot: string; maxImageBytes: number; maxDocumentBytes: number } {
  return {
    storageRoot: raw.attachments?.storageRoot ?? "./data/attachments",
    maxImageBytes: raw.attachments?.maxImageBytes ?? 10 * 1024 * 1024,
    maxDocumentBytes: raw.attachments?.maxDocumentBytes ?? 20 * 1024 * 1024,
  };
}

export function buildFeaturesConfig(raw: { features?: RawFeatures }, logger?: Logger): NormalizedFeatures {
  return {
    selfHealing: norm("selfHealing", raw.features?.selfHealing, logger),
    paperTrading: norm("paperTrading", raw.features?.paperTrading, logger),
    recruiting: norm("recruiting", raw.features?.recruiting, logger),
  };
}
