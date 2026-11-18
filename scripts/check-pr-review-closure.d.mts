/** check-pr-review-closure 机械闸类型声明（.mjs 模块供 TS 测试 import，先例 check-pr-evidence.d.mts） */

export interface PrReviewCommit {
  oid?: string | null;
}

export interface PrReview {
  commit?: PrReviewCommit | null;
  body?: string | null;
  state?: string | null;
  author?: { login?: string | null } | null;
}

export interface PrReviewData {
  headRefOid?: string | null;
  baseRefName?: string | null;
  author?: { login?: string | null } | null;
  reviews?: PrReview[];
}

export declare function extractSection(body: string, titlePattern: string): string | null;

export declare function isDocOnlyPath(p: string): boolean;

export declare function isDocOnlyDiff(paths: string[]): boolean;

export declare function checkReviewClosure(pr: PrReviewData): {
  ok: boolean;
  status: string;
  reasons: string[];
};

export declare function fetchPrReviewData(prNumber: number | string): PrReviewData;

export declare function fetchChangedPaths(baseRef: string, headRefOid: string): string[];

export declare function main(argv?: string[]): void;