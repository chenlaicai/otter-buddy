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
   *  形状取自 ModelInfo 子集（单一来源）。注意：仅 alias 受编译器硬校验（唯一必填），
   *  可选字段（description/strengths/weaknesses）在 ModelDescriptor 侧删除不会编译报错——
   *  消费方须用可选链访问（现状 pi-session-factory/tool-factory 均如此） */
  describeModels(): Array<Pick<ModelInfo, "alias" | "description" | "strengths" | "weaknesses">>;
}
