export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateFeatureFrontmatter(
  fm: Record<string, unknown>,
  filePath?: string
): ValidationResult {
  const errors: string[] = [];
  validateCommonFields(fm, errors);

  // 如果基础字段缺失，短路返回，避免级联错误
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  validateFeatureId(fm.id, errors);
  validateSummary(fm.summary, errors);
  validateFeatureStatus(fm.status, errors);
  validateChangeType(fm.change_type, errors);
  validateSupersedesPrefix(fm.supersedes, "F", errors);
  if (filePath) {
    validateFilePath(fm.id as string, filePath, errors);
  }

  return { valid: errors.length === 0, errors };
}

export function validateResearchFrontmatter(
  fm: Record<string, unknown>,
  filePath?: string
): ValidationResult {
  const errors: string[] = [];
  validateCommonFields(fm, errors);

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  validateResearchId(fm.id, errors);
  validateSummary(fm.summary, errors);
  validateExplorationType(fm.exploration_type, errors);
  validateSupersedesPrefix(fm.supersedes, "R", errors);
  if (filePath) {
    validateFilePath(fm.id as string, filePath, errors);
  }

  return { valid: errors.length === 0, errors };
}

function validateCommonFields(fm: Record<string, unknown>, errors: string[]): void {
  if (!fm.id || typeof fm.id !== "string") errors.push("Missing id");
  if (!fm.title || typeof fm.title !== "string") errors.push("Missing title");
  if (!fm.summary || typeof fm.summary !== "string") errors.push("Missing summary");
}

function validateFeatureId(id: unknown, errors: string[]): void {
  if (id && !/^F\d{8}[a-z0-9]{4}$/.test(id as string)) {
    errors.push(`Invalid feature ID format: ${id}`);
  }
}

function validateResearchId(id: unknown, errors: string[]): void {
  if (id && !/^R\d{8}[a-z0-9]{4}$/.test(id as string)) {
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

function validateFeatureStatus(status: unknown, errors: string[]): void {
  const validStatuses = ["draft", "development", "locked", "archived"];
  if (status && !validStatuses.includes(status as string)) {
    errors.push(`Invalid status: ${status}`);
  }
}

function validateChangeType(changeType: unknown, errors: string[]): void {
  const validChangeTypes = ["feature", "refactor", "fix"];
  if (changeType && !validChangeTypes.includes(changeType as string)) {
    errors.push(`Invalid change_type: ${changeType}`);
  }
}

function validateExplorationType(explorationType: unknown, errors: string[]): void {
  const validExplorationTypes = ["technical", "market", "user-research"];
  if (explorationType && !validExplorationTypes.includes(explorationType as string)) {
    errors.push(`Invalid exploration_type: ${explorationType}`);
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
