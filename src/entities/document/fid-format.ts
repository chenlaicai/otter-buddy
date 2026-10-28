/**
 * 特性/研究文档 ID 形态契约（Issue #667，单一真相源）。
 *
 * F20261027fidrx（搭档 2026-10-28 最终决策）：新写日期后固定 5 个小写字母，
 * 不用中划线，不限 0/1/l/o；历史识别继续兼容旧 4–10 位字母数字及可选分隔符，
 * 不迁移文档/DB/commit。
 */

export const FID_DATE_SEGMENT = String.raw`\d{8}`;
export const FID_BODY_SEGMENT = String.raw`[a-z0-9]{4,10}`;

/** 新写后缀：恰好 5 个小写字母。日期边界由固定长度与纯字母共同保证。 */
export const FID_SUFFIX_SEGMENT = String.raw`[a-z]{5}`;

/** 历史识别后缀：可选短横线 + 4–10 位字母数字。不得用于新文档/新标题验收。 */
export const FID_READ_SUFFIX_SEGMENT = String.raw`-?${FID_BODY_SEGMENT}`;

export const FID_PATTERN_SOURCE = `[FR]${FID_DATE_SEGMENT}${FID_SUFFIX_SEGMENT}`;
export const FID_READ_PATTERN_SOURCE = `[FR]${FID_DATE_SEGMENT}${FID_READ_SUFFIX_SEGMENT}`;

/** 完整新写 ID 锚定正则：用于验收；历史豁免仅在 frontmatter validator 按白名单处理。 */
export const FID_ANCHOR_REGEX = new RegExp(`^${FID_PATTERN_SOURCE}$`);

/** 完整历史 ID 锚定正则：用于 memory FTS sourceId 注入/重建，保留旧形态。 */
export const FID_READ_ANCHOR_REGEX = new RegExp(`^${FID_READ_PATTERN_SOURCE}$`);

/** 判断字符串是否为完整可验收的 F/R ID（不含历史白名单例外）。 */
export function isValidFid(id: string): boolean {
  return FID_ANCHOR_REGEX.test(id);
}

/**
 * 存量 frontmatter 入库豁免：由 scripts/lint-docs.mjs 扫描 docs/features+research
 * 的既有文档生成，严格新写 OR 当前磁盘旧 ID 集。不是新 ID 许可，不进入 hook/CI。
 * 代码只保留 mmr 作为语义示例；不再把 898 个非 5 字母历史 ID 硬编码进运行时。
 */
export const LEGACY_FID_IDS: ReadonlySet<string> = new Set(["F20260731mmr"]);
