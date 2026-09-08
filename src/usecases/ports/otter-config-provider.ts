import type { OtterPromptConfig } from "@contract/api/otter";
import type { ModelPoolLike } from "./model-pool-like";

/** F20260820a4rt: 从联合类型改为 string，运行时校验交由 manifest loader + lint 处理 */
export type OtterType = string;

/**
 * F20260908efmd: 有效模型解析结果。
 * 所有展示面显示真实生效模型（空配置回退默认并标注）；
 * 「默认」是一种配置来源标注，不是「无模型」。
 */
export interface EffectiveModel {
  /** 恒非空（默认解析后的真实 alias） */
  alias: string;
  /** true = 配置未显式指定，跟随默认 */
  isDefault: boolean;
}

/**
 * F20260908efmd: 统一有效模型解析 helper。
 * 用于 ManageParticipant / QueryOtterProfile / createSession / restartSession 等需要展示面的点位，
 * 不重复造逻辑。
 * @param config 配置（null = 该 otter 无配置记录）
 * @param modelPool 模型池（用于获取默认 alias）
 */
export function resolveEffectiveModel(
  config: OtterConfig | null | undefined,
  modelPool: Pick<ModelPoolLike, "getDefaultAlias">,
): EffectiveModel {
  const explicitAlias = config?.modelAlias;
  if (explicitAlias) {
    return { alias: explicitAlias, isDefault: false };
  }
  return { alias: modelPool.getDefaultAlias(), isDefault: true };
}

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
