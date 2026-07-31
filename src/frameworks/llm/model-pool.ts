/**
 * ModelPool：模型连接池，管理多个模型的 alias→Model 映射和能力描述。
 *
 * 职责：
 * - alias → pi-ai Model 对象的映射
 * - 模型能力描述（供 prompt 注入）
 * - 默认模型管理
 * - contextWindow 查询
 */

import type { ModelConfig } from "@frameworks/config";

/** 模型描述（供 prompt 注入） */
export interface ModelDescriptor {
  alias: string;
  description?: string;
  strengths?: string[];
  weaknesses?: string[];
  contextWindow?: number;
}

/** ModelPool 内部条目 */
interface ModelEntry {
  config: ModelConfig;
  model: unknown; // pi-ai Model 对象
}

/**
 * ModelPool：模型连接池。
 * 启动时构建，运行时不可变。
 */
export class ModelPool {
  private readonly entries: Map<string, ModelEntry>;
  private readonly defaultAlias: string;
  private readonly defaultModel: unknown;

  constructor(
    defaultAlias: string,
    entries: Map<string, ModelEntry>,
  ) {
    this.entries = entries;
    this.defaultAlias = defaultAlias;

    const defaultEntry = entries.get(defaultAlias);
    if (!defaultEntry) {
      throw new Error(`ModelPool: default alias "${defaultAlias}" not found in entries`);
    }
    this.defaultModel = defaultEntry.model;
  }

  /**
   * 按 alias 获取 pi-ai Model。
   * 不存在时回退到默认模型。
   */
  getModel(alias: string | null | undefined): unknown {
    if (!alias) return this.defaultModel;
    const entry = this.entries.get(alias);
    return entry ? entry.model : this.defaultModel;
  }

  /** 获取默认模型 */
  getDefaultModel(): unknown {
    return this.defaultModel;
  }

  /** 获取默认 alias */
  getDefaultAlias(): string {
    return this.defaultAlias;
  }

  /** 检查 alias 是否存在 */
  hasModel(alias: string): boolean {
    return this.entries.has(alias);
  }

  /** 获取模型的 contextWindow */
  getContextWindow(alias: string | null | undefined): number | undefined {
    if (!alias) return this.entries.get(this.defaultAlias)?.config.contextWindow;
    return this.entries.get(alias)?.config.contextWindow;
  }

  /** 返回所有模型描述，供 prompt 注入 */
  describeModels(): ModelDescriptor[] {
    const result: ModelDescriptor[] = [];
    for (const [alias, entry] of this.entries) {
      result.push({
        alias,
        description: entry.config.description,
        strengths: entry.config.strengths,
        weaknesses: entry.config.weaknesses,
        contextWindow: entry.config.contextWindow,
      });
    }
    return result;
  }

  /** 返回所有条目，供 ensurePiCodingAgent 遍历设 key */
  getAllEntries(): Array<{ alias: string; config: ModelConfig }> {
    const result: Array<{ alias: string; config: ModelConfig }> = [];
    for (const [alias, entry] of this.entries) {
      result.push({ alias, config: entry.config });
    }
    return result;
  }
}

/**
 * 构建 ModelPool。
 * 由 initModels() 调用，将配置中的 models[] 转换为 ModelPool。
 */
export function buildModelPool(
  defaultAlias: string,
  models: Array<{ config: ModelConfig; model: unknown }>,
): ModelPool {
  const entries = new Map<string, ModelEntry>();
  for (const m of models) {
    entries.set(m.config.alias, { config: m.config, model: m.model });
  }
  return new ModelPool(defaultAlias, entries);
}
