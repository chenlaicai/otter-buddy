/** check-pr-evidence 机械闸类型声明（.mjs 模块供 TS 测试 import，先例 anchor-hex-detector.d.mts） */
export declare function isDocOnlyPath(p: string): boolean;
export declare function parseChangedPaths(text: string): string[];
export declare function extractSection(body: string, titlePattern: string): string | null;
export declare function hasSubstance(sectionText: string): boolean;
export declare function checkEvidenceLayering(prBody: string): string[];
export declare function checkRollback(prBody: string): string[];
export declare function checkEvidenceBody(
  prBody: string,
  opts: { trigger: boolean },
): string[];
