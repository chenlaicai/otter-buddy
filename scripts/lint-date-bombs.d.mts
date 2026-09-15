/**
 * F20260915dabm: lint-date-bombs.mjs 的类型声明。
 * Why: TypeScript strict 模式下 .mjs 需要声明文件才能消除 TS7016。
 */
export declare const FID_DATE_RE: RegExp;
export declare const ISO_DATE_RE: RegExp;
export declare const EXEMPTION_COMMENT: string;

export interface ScanResult {
  file: string;
  line: number;
  column: number;
  pattern: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface ScanOptions {
  excludePatterns?: Array<string | RegExp>;
  rootDir?: string;
}

export declare function scanFile(filePath: string, options?: ScanOptions): ScanResult[];
export declare function scanProject(rootDir: string, options?: ScanOptions): { errors: ScanResult[]; warnings: ScanResult[] };
