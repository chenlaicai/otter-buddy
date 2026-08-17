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
  /** R20260817arnt PR-A：自 tool-factory 的重复定义收敛——工具层校验 modelAlias / 列举可用模型。
   *  形状取自 ModelInfo 的子集（单一来源，防与 frameworks 的 ModelDescriptor 双写漂移） */
  describeModels(): Array<Pick<ModelInfo, "alias" | "description" | "strengths" | "weaknesses">>;
}
