/**
 * 文档枚举值单一真相源。
 * 类型定义、validator、文档模板、前端展示均引用此处的常量与派生类型。
 * 加新值只改这里一处，全链路同步。
 *
 * 注意：DB 层已移除 CHECK 约束（features/research 表），枚举合法性由应用层判定。
 */

/** Feature 变更类型。bugfix 已统一为 fix（决策5）。 */
export const KNOWN_CHANGE_TYPES = [
  "feature",
  "refactor",
  "fix",
  "prompt",
  "feature-update",
] as const;

/** Feature/Research 文档 DB status 列的值类型。
 * 2026-11 语义收敛：frontmatter 的 status 字段整体退役——
 * 文档合入即不可变（lint-historical-docs 机械拦截），「生命周期状态」在机制上无法演进
 * （每日推进器已删除，classifyDocStatus 零调用点——脉络见本特性的特性文档）。
 * DB 列唯一有效语义是 archived 标记（磁盘文档消失时 sync 自动写入，见 sync-documents 对账逻辑）；
 * 新写入统一落 "active"，历史遗留值（locked/draft/implemented 等）无消费方、随下次 sync 自然收敛。 */
export type FeatureStatus = string;
export type ResearchStatus = string;

/** Research 探索类型。 */
export const KNOWN_EXPLORATION_TYPES = [
  "technical",
  "market",
  "user-research",
  "audit", // 存量 （coding-agent SDK 使用审计）在用；语义真实（对既有实现/依赖的审计型研究），收编而非改文档
] as const;

export type ChangeType = (typeof KNOWN_CHANGE_TYPES)[number];
export type ExplorationType = (typeof KNOWN_EXPLORATION_TYPES)[number];

/** 判定 change_type 是否为已知值（未知值进 SyncResult.warnings 上报，不阻断入库）。
 * ：归一化入口下沉本源——trim+ 历史拼写别名
 * （bugfix→fix / feature_update→feature-update，与 lint-intent 对齐）
 *  在此单点处理，validator/sync/mapper 调用方共用；lint-intent 侧（.mjs 无法 import
 *  TS）别名表独立维护，跨表一致性由测试断言守卫（known-values-change-type.test.ts）。 */
export function normalizeChangeType(value: string): string {
  const trimmed = value.trim();
  const LEGACY_ALIAS: Record<string, ChangeType> = {
    bugfix: "fix",
    feature_update: "feature-update",
  };
  return LEGACY_ALIAS[trimmed] ?? trimmed;
}

/** 判定 change_type 是否为已知值（归一后判定：`' fix '`/`'bugfix'` 均判合法） */
export function isKnownChangeType(value: string): boolean {
  return (KNOWN_CHANGE_TYPES as readonly string[]).includes(normalizeChangeType(value));
}

/** 判定 exploration_type 是否为已知值。 */
export function isKnownExplorationType(value: string): boolean {
  return (KNOWN_EXPLORATION_TYPES as readonly string[]).includes(value);
}
