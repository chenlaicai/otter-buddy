/** ModelPool 面向 usecases/interface-adapters 层的接口（跨层端口） */

/** 模型信息条目（apiKey/apiBaseUrl/pi-ai model 对象不暴露） */
export interface ModelInfo {
  alias: string;
  provider: string;
  model: string;
  description?: string;
  strengths?: string[];
  weaknesses?: string[];
  contextWindow?: number;
}

export interface ModelPoolLike {
  getDefaultAlias(): string;
  setDefaultAlias(alias: string): void;
  hasModel(alias: string): boolean;
  /** 返回所有模型信息（不含 pi-ai model 对象），用于 settings DTO 等场景 */
  getModelInfos(): ModelInfo[];
}
