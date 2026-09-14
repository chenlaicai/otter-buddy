/**
 * Type declarations for scripts/validate-commit-date.mjs
 */
export interface ValidationResult {
  valid: boolean;
  status: 'ok' | 'skip' | 'fail' | 'bad_date';
  idDate?: string;
  /** F20260914prdb: 基准日期（可注入 PR 创建时间），原 systemDate 更名（全仓零消费方，无兼容包袱） */
  baseDate?: string;
  diffDays?: number;
}

export function validateCommitDate(firstLine: string, now?: Date): ValidationResult;
