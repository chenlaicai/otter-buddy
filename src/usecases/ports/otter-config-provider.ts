import type { OtterPromptConfig } from "@contract/api/otter";

export type OtterType = 'big' | 'small';

export interface OtterConfig {
  systemPrompt?: string | OtterPromptConfig;
  otterType: OtterType;
}

export interface OtterConfigProvider {
  getConfig(otterId: string): OtterConfig | null;
  setConfig(otterId: string, config: OtterConfig): void;
  deleteConfig(otterId: string): void;
  hasConfig(otterId: string): boolean;
}
