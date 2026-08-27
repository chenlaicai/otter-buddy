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
  /**
   * #446: 批量获取配置（单条 IN 查询），供循环场景消除 N+1。
   * 未配置的 otterId 不出现在返回 Map 中。
   *
   * 同步签名是有意为之（SQLite 同步驱动，与 getConfig 一致）；
   * 若未来换异步实现（如远程配置服务），需与 getConfig 一并改签名，
   * 与 OtterRepository.getByIds 的 async 形成对比。
   */
  getConfigs(otterIds: string[]): Map<string, OtterConfig>;
  setConfig(otterId: string, config: OtterConfig): void;
  deleteConfig(otterId: string): void;
  hasConfig(otterId: string): boolean;
}
