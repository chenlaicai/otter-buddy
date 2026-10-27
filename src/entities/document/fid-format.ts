/**
 * 特性/研究文档 ID 形态契约（Issue #667，单一真相源）。
 *
 * F20261027-fidr：日期可读性把「新写验收」与「历史识别」分开：
 * - 新写：日期后字母开头（天然边界）或显式 `-`（数字/字母均可）。
 * - 历史识别：保留旧数字直连与无分隔形态，不迁移文档/DB/commit。
 * F20260901fidc 的字符集合决策保持：不恢复排除 0/1/l/o 的无出处字母表。
 */

export const FID_DATE_SEGMENT = String.raw`\d{8}`;
export const FID_BODY_SEGMENT = String.raw`[a-z0-9]{4,10}`;

/** 新写后缀：字母开头无分隔，或短横线后 4–10 位字母数字（数字直连不在此列）。 */
export const FID_SUFFIX_SEGMENT = String.raw`(?:[a-z][a-z0-9]{3,9}|-[a-z0-9]{4,10})`;

/** 历史识别后缀：可选短横线 + 4–10 位字母数字。不得用于新文档/新标题验收。 */
export const FID_READ_SUFFIX_SEGMENT = String.raw`-?${FID_BODY_SEGMENT}`;

export const FID_PATTERN_SOURCE = `[FR]${FID_DATE_SEGMENT}${FID_SUFFIX_SEGMENT}`;
export const FID_READ_PATTERN_SOURCE = `[FR]${FID_DATE_SEGMENT}${FID_READ_SUFFIX_SEGMENT}`;

/** 完整新写 ID 锚定正则：用于验收；历史豁免仅在 frontmatter validator 按白名单处理。 */
export const FID_ANCHOR_REGEX = new RegExp(`^${FID_PATTERN_SOURCE}$`);

/** 完整历史 ID 锚定正则：用于 memory FTS sourceId 注入/重建，保留旧数字直连。 */
export const FID_READ_ANCHOR_REGEX = new RegExp(`^${FID_READ_PATTERN_SOURCE}$`);

/** 判断字符串是否为完整可验收的 F/R ID（不含历史白名单例外）。 */
export function isValidFid(id: string): boolean {
  return FID_ANCHOR_REGEX.test(id);
}

/** 存量 frontmatter 入库豁免：不是新 ID 的形态许可，不进入 hook/CI 验收。 */
export const LEGACY_FID_IDS: ReadonlySet<string> = new Set([
  // 4–10 位契约前的 3 位后缀真实历史 ID；read 契约仍不识别它，保持既有行为。
  "F20260731mmr",
  // 日期后数字直连的 5 个真实历史 ID：保留文件名/frontmatter/DB，不迁移。
  "F2026090326c5",
  "F202609048840",
  "F2026090211v4",
  "F202609025itn",
  "F202608119glo",
]);
