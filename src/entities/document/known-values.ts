/**
 * 文档枚举值单一真相源（F20260803mval）。
 * 类型定义、validator、文档模板、前端展示均引用此处的常量与派生类型。
 * 加新值只改这里一处，全链路同步。
 *
 * 注意：DB 层已移除 CHECK 约束（features/research 表），枚举合法性由应用层判定。
 */

/** Feature 变更类型。bugfix 已统一为 fix（F20260803mval 决策5）。 */
export const KNOWN_CHANGE_TYPES = [
  "feature",
  "refactor",
  "fix",
  "prompt",
  "feature-update",
] as const;

/** Feature 文档状态（工作流生命周期）。
 *  active：F20260827spcs（#455）补录——存量 33 篇在用（lint 长期误报 Unknown），
 *  语义为「已上线生效中」，介于 implemented 与 final 之间使用。 */
export const KNOWN_FEATURE_STATUSES = [
  "draft",
  "proposed",
  "design",
  "development",
  "active",
  "locked",
  "final",
  "implemented",
  "archived",
] as const;

/** Research 文档状态，与 Feature 共用生命周期。 */
export const KNOWN_RESEARCH_STATUSES = KNOWN_FEATURE_STATUSES;

/** Research 探索类型。 */
export const KNOWN_EXPLORATION_TYPES = ["technical", "market", "user-research"] as const;

export type ChangeType = (typeof KNOWN_CHANGE_TYPES)[number];
export type FeatureStatus = (typeof KNOWN_FEATURE_STATUSES)[number];
export type ResearchStatus = (typeof KNOWN_RESEARCH_STATUSES)[number];
export type ExplorationType = (typeof KNOWN_EXPLORATION_TYPES)[number];

/** 判定 change_type 是否为已知值（未知值进 SyncResult.warnings 上报，不阻断入库）。 */
export function isKnownChangeType(value: string): boolean {
  return (KNOWN_CHANGE_TYPES as readonly string[]).includes(value);
}

/** 判定 feature status 是否为已知值。 */
export function isKnownFeatureStatus(value: string): boolean {
  return (KNOWN_FEATURE_STATUSES as readonly string[]).includes(value);
}

/** 判定 research status 是否为已知值。 */
export function isKnownResearchStatus(value: string): boolean {
  return (KNOWN_RESEARCH_STATUSES as readonly string[]).includes(value);
}

/** 判定 exploration_type 是否为已知值。 */
export function isKnownExplorationType(value: string): boolean {
  return (KNOWN_EXPLORATION_TYPES as readonly string[]).includes(value);
}
