/** check-pr-anchor-discipline 类型声明（.mjs 供 TS 测试 import） */

export declare function isExcludedPath(p: string): boolean;
export declare function isHashCommentLang(p: string): boolean;
export declare function isHtmlLang(p: string): boolean;
export declare function isSupportedCodePath(p: string): boolean;
export declare function collectAnchorViolations(commentText: string): Array<{ token: string; kind: string }>;
export declare function scanTsLine(line: string): {
  comment: string | null;
  opensBlock: boolean;
  closesBlock: boolean;
};
export declare function scanHashLine(line: string): { comment: string | null; opensBlock: boolean };
export declare function annotateFile(content: string, path: string): Array<string | null>;
export declare function decodeCQuotedPath(s: string): string;
export declare function parseDiffAddedLines(diffText: string): {
  added: Array<{ path: string; line: number; content: string }>;
  files: string[];
  diffNonEmpty: boolean;
};
export declare function checkDiff(
  diffText: string,
  readFileFn?: (p: string) => string,
): {
  addedTotal: number;
  diffNonEmpty: boolean;
  violations: Array<{ path: string; line: number; content: string; token: string; kind: string }>;
};