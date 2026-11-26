/** check-pr-claim 认领闸类型声明（.mjs 模块供 TS 测试 import，先例 check-pr-review-closure.d.mts） */

export interface ClaimEntry {
  conversation: string;
  otter: string;
  worktree: string;
}

export interface ClaimComment {
  body: string;
  createdAt: string;
  author?: { login?: string };
}

export interface PrForClaim {
  state?: string;
  title: string;
  body?: string;
  headRefName: string;
  files?: { path: string }[];
}

export interface ClaimResult {
  ok: boolean;
  status: "claimed" | "claim_missing_or_mismatch" | "no_issue_reference" | "exempt_docs_only" | "skipped_not_open";
  reasons: string[];
  hint?: string;
}

export function featureId(text: string | null | undefined): string | null;
export function extractIssueNumbers(title: string, body?: string): number[];
export function extractCommitIssueNumbers(message: string): number[];
export function parseClaims(comments: ClaimComment[]): ClaimEntry[];
export interface IssueReference {
  state?: string;
  pull_request?: unknown;
}
export function selectOpenIssueNumbers(issueNums: number[], references?: Record<number, IssueReference>): number[];
export function checkClaim(pr: PrForClaim, issuesComments: Record<number, ClaimComment[]>, references?: Record<number, IssueReference>): ClaimResult;
