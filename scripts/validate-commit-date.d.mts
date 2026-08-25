/**
 * Type declarations for scripts/validate-commit-date.mjs
 */
export interface ValidationResult {
  valid: boolean;
  status: 'ok' | 'skip' | 'fail' | 'bad_date';
  idDate?: string;
  systemDate?: string;
  diffDays?: number;
}

export function validateCommitDate(firstLine: string, now?: Date): ValidationResult;
