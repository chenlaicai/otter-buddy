import {
  isKnownChangeType,
  isKnownFeatureStatus,
  isKnownResearchStatus,
  isKnownExplorationType,
} from "./known-values";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /** F20260803mval: 未知枚举值等软警告，不阻断入库，进 SyncResult 上报健康端点 */
  warnings: string[];
}

export function validateFeatureFrontmatter(
  fm: Record<string, unknown>,
  filePath?: string
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  validateCommonFields(fm, errors);

  // 结构字段缺失，短路返回避免级联错误
  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  validateFeatureId(fm.id, errors);
  validateSummary(fm.summary, errors);
  validateFeatureStatus(fm.status, warnings);
  validateChangeType(fm.change_type, warnings);
  validateSupersedesPrefix(fm.supersedes, "F", errors);
  if (filePath) {
    validateFilePath(fm.id as string, filePath, errors);
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateResearchFrontmatter(
  fm: Record<string, unknown>,
  filePath?: string
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  validateCommonFields(fm, errors);

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  validateResearchId(fm.id, errors);
  validateSummary(fm.summary, errors);
  validateResearchStatus(fm.status, warnings);
  validateExplorationType(fm.exploration_type, warnings);
  validateSupersedesPrefix(fm.supersedes, "R", errors);
  if (filePath) {
    validateFilePath(fm.id as string, filePath, errors);
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateCommonFields(fm: Record<string, unknown>, errors: string[]): void {
  if (!fm.id || typeof fm.id !== "string") errors.push("Missing id");
  // F20260803mval: title 加 trim 校验，防纯空格通过
  if (!fm.title || typeof fm.title !== "string" || (fm.title as string).trim().length === 0) {
    errors.push("Missing or blank title");
  }
  if (!fm.summary || typeof fm.summary !== "string") errors.push("Missing summary");
}

function validateFeatureId(id: unknown, errors: string[]): void {
  // 后缀 4-10 位小写字母数字（4 位推荐，放宽兼容历史）
  if (id && !/^F\d{8}[a-z0-9]{3,10}$/.test(id as string)) {
    errors.push(`Invalid feature ID format: ${id}`);
  }
}

function validateResearchId(id: unknown, errors: string[]): void {
  if (id && !/^R\d{8}[a-z0-9]{3,10}$/.test(id as string)) {
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

/** F20260803mval: 未知值进 warnings 不阻断（应用层不再硬卡语义枚举） */
function validateFeatureStatus(status: unknown, warnings: string[]): void {
  if (status && typeof status === "string" && !isKnownFeatureStatus(status)) {
    warnings.push(`Unknown feature status: ${status}`);
  }
}

function validateChangeType(changeType: unknown, warnings: string[]): void {
  if (changeType && typeof changeType === "string" && !isKnownChangeType(changeType as string)) {
    warnings.push(`Unknown change_type: ${changeType}`);
  }
}

function validateResearchStatus(status: unknown, warnings: string[]): void {
  if (status && typeof status === "string" && !isKnownResearchStatus(status)) {
    warnings.push(`Unknown research status: ${status}`);
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
 * ID 格式：F20260722mk74，其中 20260722 是日期
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
