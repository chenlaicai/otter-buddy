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
import type { Model, Api } from "@earendil-works/pi-ai";

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
  model: Model<Api>;
}

/**
 * ModelPool：模型连接池。
 * 启动时构建，条目集不可变；默认 alias 可在运行时切换（settings 页，F20260806cnp6），
 * 切换只影响之后新建的 session，既有 session 保持原模型。
 *
 * ModelPool 同时实现 ModelPoolLike（usecases/ports），用于 settings-controller 等
 * interface-adapters 组件通过端口接口访问模型数据，避免 interface-adapters → frameworks 的层级违规。
 */
import type { ModelPoolLike, ModelInfo } from "@usecases/ports/model-pool-like";

export class ModelPool implements ModelPoolLike {
  private readonly entries: Map<string, ModelEntry>;
  private defaultAlias: string;
  private defaultModel: Model<Api>;

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

  /** 运行时切换默认模型；alias 不存在时抛错 */
  setDefaultAlias(alias: string): void {
    const entry = this.entries.get(alias);
    if (!entry) {
      throw new Error(`ModelPool: cannot set default to unknown alias "${alias}"`);
    }
    this.defaultAlias = alias;
    this.defaultModel = entry.model;
  }

  /**
   * 按 alias 获取 pi-ai Model。
   * 不存在时回退到默认模型。
   */
  getModel(alias: string | null | undefined): Model<Api> {
    if (!alias) return this.defaultModel;
    const entry = this.entries.get(alias);
    return entry ? entry.model : this.defaultModel;
  }

  /** 获取默认模型 */
  getDefaultModel(): Model<Api> {
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

  /** 返回所有条目（含 model 对象），供 ensurePiCodingAgent 注册 provider + 设 key */
  getAllEntries(): Array<{ alias: string; config: ModelConfig; model: Model<Api> }> {
    const result: Array<{ alias: string; config: ModelConfig; model: Model<Api> }> = [];
    for (const [alias, entry] of this.entries) {
      result.push({ alias, config: entry.config, model: entry.model });
    }
    return result;
  }

  /** 返回所有模型信息（不含 pi-ai model 对象），用于 settings DTO 等场景 */
  getModelInfos(): ModelInfo[] {
    const result: ModelInfo[] = [];
    for (const [alias, entry] of this.entries) {
      result.push({
        alias,
        provider: entry.config.provider,
        model: entry.config.model,
        description: entry.config.description,
        strengths: entry.config.strengths,
        weaknesses: entry.config.weaknesses,
        contextWindow: entry.config.contextWindow,
      });
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
  models: Array<{ config: ModelConfig; model: Model<Api> }>,
): ModelPool {
  const entries = new Map<string, ModelEntry>();
  for (const m of models) {
    entries.set(m.config.alias, { config: m.config, model: m.model });
  }
  return new ModelPool(defaultAlias, entries);
}
