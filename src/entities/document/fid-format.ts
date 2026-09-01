/**
 * 特性/研究文档 ID 形态契约（Issue #667，单一真相源）。
 *
 * 背景：commit-parser 三处正则自 8/25（F20260825hmvp，PR #417）起持有
 * `[a-kmnp-z][2-9a-kmnp-z]{3,9}` 字母表（排除 0/1/l/o），但仓库从无「排除 l/o
 * 防混淆」的成文约定——commit-convention.md 只写 `FYYYYMMDDxxxx` 占位符，ID 由
 * 各开发獭自编。frontmatter-validator 已放行含 0/1/l/o 的 ID 入库（377 个存量
 * 后缀中 5 个被 commit-parser 漏判：mtbl/o46s/scl1/dpao/evgl——featureId 提取
 * 不出，相关特性在 commit 合规统计里被记为 no_f_prefix）。
 *
 * 本模块收敛全仓 F/R ID 形态判定（对齐 #646 doc-status.ts 值域契约先例）：
 * - 前缀：F（特性）/ R（研究）
 * - 日期段：8 位数字（YYYYMMDD）
 * - 后缀段：3-10 位小写字母数字，无字母表限制（与 ID 生成现状一致：LLM 按
 *   commit-convention.md 自编，小写字母数字混排）
 * - 注意：后缀下限 3 位是兼容历史（R20260805im），推荐 4 位（frontmatter-validator
 *   既有注释口径）
 */

/** 日期段 source：8 位数字（YYYYMMDD） */
export const FID_DATE_SEGMENT = "\\d{8}";

/** 后缀段 source：3-10 位小写字母数字（4 位推荐，3 位兼容历史） */
export const FID_SUFFIX_SEGMENT = "[a-z0-9]{3,10}";

/** 完整 F/R ID 形态 source（不带锚点，供各消费方按需拼接 ^$ 或嵌入大正则） */
export const FID_PATTERN_SOURCE = `[FR]${FID_DATE_SEGMENT}${FID_SUFFIX_SEGMENT}`;

/** 完整 F/R ID 锚定正则：整串精确匹配 */
export const FID_ANCHOR_REGEX = new RegExp(`^${FID_PATTERN_SOURCE}$`);

/** 判断字符串是否为完整合法的 F/R 文档 ID */
export function isValidFid(id: string): boolean {
  return FID_ANCHOR_REGEX.test(id);
}
