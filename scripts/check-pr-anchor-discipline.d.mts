/** check-pr-anchor-discipline 类型声明（.mjs 供 TS 测试 import，先例 check-pr-evidence.d.mts） */

export declare function isExcludedPath(p: string): boolean;
export declare function isHashCommentLang(p: string): boolean;
export declare function extractCommentText(line: string, hashLang: boolean): string | null;
export declare function collectAnchorViolations(commentText: string): Array<{ token: string; kind: string }>;
export declare function parseDiffAddedLines(diffText: string): Array<{ path: string; line: number; content: string }>;
export declare function checkDiff(diffText: string): {
  addedTotal: number;
  violations: Array<{ path: string; line: number; content: string; token: string; kind: string }>;
};