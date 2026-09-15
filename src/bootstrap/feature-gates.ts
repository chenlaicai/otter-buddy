/**
 * F20260915cfgt：功能开关门控（装配层）——唯一推断发生地。
 *
 * 层职责边界（方案「层职责边界」段）：
 * - 配置层（config-service.buildFeaturesConfig）纯函数只做归一化，输出三态 boolean|undefined
 * - 本层 gateOn()：显式 true/false 短路；未配置（undefined）时执行存量推断
 *
 * 分类原则（搭档 2026-09-15 定调）：
 * - 工作内容优化（每日复盘）→ 默认开
 * - 海獭系统优化（self-healing）→ 默认关，除作者外无人关心
 * - 个人场景（paper-trading / recruiting）→ 默认关，显式启用
 *
 * 兼容策略：老部署未写 features 段时按 DB 存量 active 任务推断（行为不变），
 * 推断命中 warn 提醒可显式声明。显式配置永远优先，推断不覆盖用户意愿。
 */

import type { AppConfig } from "@frameworks/config";import type { ScheduledTaskRepository } from "@usecases/scheduled-task/scheduled-task-repository";
import type { Logger } from "@usecases/ports/logger";

/** 三态门：显式配置短路，未配置走存量推断 */
export async function gateOn(
  explicit: boolean | undefined,
  infer: () => Promise<boolean>,
): Promise<boolean> {
  if (explicit !== undefined) return explicit;
  return await infer();
}

/** 各功能域的 DB 存量任务名匹配（推断依据：active 任务存在 = 部署者在用） */
const DOMAIN_TASK_NAMES: Record<'selfHealing' | 'paperTrading' | 'recruiting', readonly string[]> = {
  selfHealing: ['self-healing-analysis'],
  paperTrading: ['paper-trading-match-orders', 'paper-trading-daily-trading'],
  recruiting: ['recruiting-daily-summary'],
};

export interface FeatureGates {
  dailyReview: boolean;
  selfHealing: boolean;
  paperTrading: boolean;
  recruiting: boolean;
}

/**
 * 解析四个功能开关的最终生效值。
 * 单次 getAllActive() 共用查询（顺序安全：platforms 阶段 DB 已就绪）。
 */
export async function resolveFeatureGates(deps: {
  features: AppConfig["features"];
  scheduledTaskRepo: ScheduledTaskRepository;
  /** recruiting 双通道之一：apiKey 存在 = 更强的意图信号（真配了密钥说明确实在用） */
  recruitingApiKey?: string;
  logger: Logger;
}): Promise<FeatureGates> {
  const { features, scheduledTaskRepo, recruitingApiKey, logger } = deps;

  // Why 一次查询供三处推断共用：三域任务名匹配同一份数据，分散查询无收益
  const activeTasks = await scheduledTaskRepo.getAllActive();
  const activeNames = new Set(activeTasks.map(t => t.name));

  const inferFromDb = (domain: keyof typeof DOMAIN_TASK_NAMES, label: string): boolean => {
    const hit = DOMAIN_TASK_NAMES[domain].some(name => activeNames.has(name));
    if (hit) {
      // Why warn：推断只兜「未配置」的底，用户应知晓可显式声明（显式配置永远优先）
      logger.info(`features.${label} 未显式配置，由 DB 存量 active 任务推断为 true（建议在 config.yaml features 段显式声明）`);
    }
    return hit;
  };

  const recruitingInfer = async (): Promise<boolean> => {
    if (recruitingApiKey) return true;
    return inferFromDb('recruiting', 'recruiting');
  };

  return {
    // dailyReview 是新功能，无存量可推断，缺省 on（工作复习是通用默认体验）
    dailyReview: await gateOn(features.dailyReview, async () => true),
    selfHealing: await gateOn(features.selfHealing, async () => inferFromDb('selfHealing', 'selfHealing')),
    paperTrading: await gateOn(features.paperTrading, async () => inferFromDb('paperTrading', 'paperTrading')),
    recruiting: await gateOn(features.recruiting, recruitingInfer),
  };
}
