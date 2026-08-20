import type { OtterPromptConfig } from "@contract/api/otter";

/** F20260820a4rt: 从联合类型改为 string，运行时校验交由 manifest loader + lint 处理 */
export type OtterType = string;

export interface OtterConfig {
  systemPrompt?: string | OtterPromptConfig;
  otterType: OtterType;
  /** 模型别名（多模型路由，可选） */
  modelAlias?: string;
}

export interface OtterConfigProvider {
  getConfig(otterId: string): OtterConfig | null;
  setConfig(otterId: string, config: OtterConfig): void;
  deleteConfig(otterId: string): void;
  hasConfig(otterId: string): boolean;
}
