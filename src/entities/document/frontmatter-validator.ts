import {
  isKnownChangeType,
  isKnownExplorationType,
} from "./known-values";
import { FID_DATE_SEGMENT, FID_SUFFIX_SEGMENT, FID_READ_SUFFIX_SEGMENT, LEGACY_FID_IDS } from "./fid-format";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /** 未知枚举值等软警告，不阻断入库，进 SyncResult 上报健康端点 */
  warnings: string[];
}

export function validateFeatureFrontmatter(
  fm: Record<string, unknown>,
  filePath?: string,
  options: { strictNewId?: boolean } = {},
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  validateCommonFields(fm, errors);

  // 结构字段缺失，短路返回避免级联错误
  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  validateFeatureId(fm.id, errors, options.strictNewId === true);
  validateSummary(fm.summary, errors);
  validateStatusRetired(fm.status, "feature", errors);
  validateChangeType(fm.change_type, warnings);
  validateTitleReadability(fm.title, warnings);
  validateSupersedesPrefix(fm.supersedes, "F", errors);
  if (filePath) {
    validateFilePath(fm.id as string, filePath, errors);
    validateFilenameSlug(filePath, warnings);
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateResearchFrontmatter(
  fm: Record<string, unknown>,
  filePath?: string,
  options: { strictNewId?: boolean } = {},
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  validateCommonFields(fm, errors);

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  validateResearchId(fm.id, errors, options.strictNewId === true);
  validateSummary(fm.summary, errors);
  validateStatusRetired(fm.status, "research", errors);
  validateExplorationType(fm.exploration_type, warnings);
  validateSupersedesPrefix(fm.supersedes, "R", errors);
  if (filePath) {
    validateFilePath(fm.id as string, filePath, errors);
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateCommonFields(fm: Record<string, unknown>, errors: string[]): void {
  if (!fm.id || typeof fm.id !== "string") errors.push("Missing id");
  // title 加 trim 校验，防纯空格通过
  if (!fm.title || typeof fm.title !== "string" || (fm.title as string).trim().length === 0) {
    errors.push("Missing or blank title");
  }
  if (!fm.summary || typeof fm.summary !== "string") errors.push("Missing summary");
}

function validateFeatureId(id: unknown, errors: string[], strictNewId = false): void {
  // 默认 read：历史文档/启动 sync 识别旧 4–10 位形态。仅 lint-docs 对本分支新增
  // 文档传 strictNewId=true，验收固定 5 字母；不把近九百篇历史写成运行时白名单。
  const suffix = strictNewId ? FID_SUFFIX_SEGMENT : FID_READ_SUFFIX_SEGMENT;
  if (
    id &&
    !LEGACY_FID_IDS.has(id as string) &&
    !new RegExp(`^F${FID_DATE_SEGMENT}${suffix}$`).test(id as string)
  ) {
    errors.push(`Invalid feature ID format: ${id}`);
  }
}

function validateResearchId(id: unknown, errors: string[], strictNewId = false): void {
  const suffix = strictNewId ? FID_SUFFIX_SEGMENT : FID_READ_SUFFIX_SEGMENT;
  if (
    id &&
    !LEGACY_FID_IDS.has(id as string) &&
    !new RegExp(`^R${FID_DATE_SEGMENT}${suffix}$`).test(id as string)
  ) {
    errors.push(`Invalid research ID format: ${id}`);
  }
}

function validateSummary(summary: unknown, errors: string[]): void {
  if (summary) {
    const len = (summary as string).trim().length;
    if (len < 1 || len > 500) {
      errors.push(`Summary length ${len} out of range [1, 500]`);
    }
  }
}

/** status 字段已退役（#2050）：文档合入即不可变，生命周期状态无法演进；
 *  归档（archived）是 sync 在磁盘文档消失时写入 DB 的系统行为，作者不可声明。
 *  frontmatter 出现 status 字段（无论值）→ error 阻断，机械拦住，不依赖执行者读 skill。 */
function validateStatusRetired(status: unknown, kind: "feature" | "research", errors: string[]): void {
  if (status !== undefined) {
    errors.push(
      `${kind} 文档的 status 字段已退役：文档状态由系统管理（archived 由 sync 自动标记），请删除 frontmatter 中的 status 行（#2050）`
    );
  }
}

function validateChangeType(changeType: unknown, warnings: string[]): void {
  if (changeType && typeof changeType === "string" && !isKnownChangeType(changeType as string)) {
    warnings.push(`Unknown change_type: ${changeType}`);
  }
}

/** 是否包含 CJK 字符（含扩展 A 区）。
 *  用于 title 可读性判定：纯英文 slug 形态（连字符连接、无空格、无 CJK）不算可读 title。 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/** title 可读性校验。
 *  主流惯例：title 是人类可读描述（如「commit-msg 钩子类型白名单与 commit-convention.md 对齐」），
 *  slug 应放文件名而非 title。纯 slug 形态（无 CJK 且无空白的连写串）报 warning，不阻断。
 *  存量 slug title 较多（过渡期），由 lint:docs 的 ratchet 上限约束只减不增。 */
export function validateTitleReadability(title: unknown, warnings: string[]): void {
  if (typeof title !== "string") return;
  const t = title.trim();
  if (!t) return;
  if (!CJK_RE.test(t) && !/\s/.test(t)) {
    warnings.push(
      `Title looks like a slug ("${t}"): use a human-readable description; slugs belong in the filename`
    );
  }
}

/** 特性文档文件名 slug 后缀校验。
 * 主流命名：F<date><id>-<slug>.md（存量 271/292）；缺 slug 后缀报 warning（评论升级为必查项），
 * 与存量兼容，逐步收紧。仅对 feature 文档生效。ID 段口径同 fid-format.ts。 */
export function validateFilenameSlug(filePath: string, warnings: string[]): void {
  const base = filePath.split("/").pop() ?? "";
  if (new RegExp(`^F${FID_DATE_SEGMENT}${FID_READ_SUFFIX_SEGMENT}\\.md$`).test(base)) {
    warnings.push(`Filename "${base}" missing slug suffix: prefer F<date><id>-<slug>.md`);
  }
}

function validateExplorationType(explorationType: unknown, warnings: string[]): void {
  if (
    explorationType &&
    typeof explorationType === "string" &&
    !isKnownExplorationType(explorationType)
  ) {
    warnings.push(`Unknown exploration_type: ${explorationType}`);
  }
}

function validateSupersedesPrefix(
  supersedes: unknown,
  expectedPrefix: string,
  errors: string[]
): void {
  if (supersedes && Array.isArray(supersedes)) {
    for (const id of supersedes) {
      if (typeof id === "string" && !id.startsWith(expectedPrefix)) {
        errors.push(`Supersedes must start with ${expectedPrefix}, got: ${id}`);
      }
    }
  }
}

/**
 * 验证文件路径是否匹配 ID 中的日期（领域规则）
 * ID 格式：其中 20260722 是日期
 * 路径格式：docs/features/2026/07/22/...
 */
function validateFilePath(id: string, filePath: string, errors: string[]): void {
  if (!id || !filePath) return;

  const dateMatch = id.match(/^[FR](\d{8})/);
  if (!dateMatch) return;

  const date = dateMatch[1];
  const year = date.slice(0, 4);
  const month = date.slice(4, 6);
  const day = date.slice(6, 8);

  const expectedPrefix = `docs/${id.startsWith("F") ? "features" : "research"}/${year}/${month}/${day}/`;
  if (!filePath.startsWith(expectedPrefix)) {
    errors.push(`File path ${filePath} does not match expected ${expectedPrefix}`);
  }
}
