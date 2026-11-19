/** lint-issue-assertions 断言方向闸类型声明（.mjs 模块供 TS 测试 import，先例 check-pr-claim.d.mts） */

export type AssertionDirection = "problem-ok" | "good-direction" | "unclear";

export function extractAssertionSection(body: string | null | undefined): string | null;
export function classifyAssertionDirection(section: string): AssertionDirection;
