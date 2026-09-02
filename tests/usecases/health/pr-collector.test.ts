import { describe, it, expect } from "vitest";
import { collectOpenPrs, extractFeatureIds } from "@usecases/health/pr-collector";

/**
 * F20260902sigm PrCollector 测试：
 * - PR↔链关联三级规则（commit FID > body FID > branch name 不提取）
 * - lastActivity = max(commit, review, comment)
 * - 降级语义：gh 失败 → 空数组，不抛错
 */

const NOW_ISO = "2026-09-02T04:00:00Z";
const dayAgo = (n: number) => new Date(new Date(NOW_ISO).getTime() - n * 24 * 60 * 60 * 1000).toISOString();

function makeRunner(listRows: unknown, views: Record<number, unknown> = {}, fail?: "list" | "view") {
  return async (_cmd: string, args: string[]) => {
    if (fail === "list" && args.includes("list")) throw new Error("gh not found");
    if (fail === "view" && args.includes("view")) throw new Error("rate limited");
    if (args.includes("list")) return { stdout: JSON.stringify(listRows) };
    const num = Number(args[2]);
    return { stdout: JSON.stringify(views[num] ?? {}) };
  };
}

describe("extractFeatureIds", () => {
  it("从文本提取 FID（F/R 前缀，去重保持出现序）", () => {
    expect(extractFeatureIds("[F20260901abcd][web][New Feature] x 和 [F20260901abcd] 重复与 R20260801efgh"))
      .toEqual(["F20260901abcd", "R20260801efgh"]);
  });

  it("后缀 <4 位不匹配（fid-format 契约 {4,10}）；null/空安全", () => {
    expect(extractFeatureIds("F20260901abc 太短")).toEqual([]);
    expect(extractFeatureIds(null)).toEqual([]);
    expect(extractFeatureIds(undefined)).toEqual([]);
    expect(extractFeatureIds("")).toEqual([]);
  });

  it("分支名里的日期串不误配（8 位日期 + 短后缀才成形如 FID 的串）", () => {
    // feature/rhi-pr2-ui：无 8 位日期段，提取不出
    expect(extractFeatureIds("feature/rhi-pr2-ui")).toEqual([]);
    // 2026-09-01 这类日期串（带连字符）不构成 FID
    expect(extractFeatureIds("2026-09-01 会议记录")).toEqual([]);
  });
});

describe("collectOpenPrs", () => {
  it("关联规则：commit message FID 优先 + body FID 补充（并集去重）", async () => {
    const list = [{
      number: 1,
      title: "汇总 PR",
      headRefName: "feature/aggregate",
      body: "关联 F20260901bbbb 与 F20260901cccc",
      url: null,
      createdAt: dayAgo(20),
    }];
    const views = {
      1: { commits: [{ committedDate: dayAgo(10), messageHeadline: "[F20260901aaaa][agent][BugFix] 修 x (#1)" }] },
    };
    const prs = await collectOpenPrs("/repo", { runner: makeRunner(list, views) });
    expect(prs).toHaveLength(1);
    expect(prs[0]!.featureIds).toEqual(["F20260901aaaa", "F20260901bbbb", "F20260901cccc"]);
  });

  it("branch name 不提取 FID（方案 S1 决策：无 hook 强制，误配率高）", async () => {
    const list = [{
      number: 2,
      title: "Bump deps",
      headRefName: "feature/F20260901xyz9-something",  // 即使分支名带 FID 形态也不提取
      body: null,
      url: null,
      createdAt: dayAgo(30),
    }];
    const prs = await collectOpenPrs("/repo", { runner: makeRunner(list, { 2: { commits: [], reviews: [], comments: [] } }) });
    expect(prs[0]!.featureIds).toEqual([]);
  });

  it("lastActivity = max(最新 commit, 最新 review, 最新 comment)", async () => {
    const list = [{ number: 3, title: "t", headRefName: "b", body: "F20260901dddd", url: "u", createdAt: dayAgo(30) }];
    const views = {
      3: {
        commits: [{ committedDate: dayAgo(10) }, { committedDate: dayAgo(5) }],
        reviews: [{ submittedAt: dayAgo(8) }],
        comments: [{ createdAt: dayAgo(12) }, { createdAt: dayAgo(2) }],  // 最新
      },
    };
    const prs = await collectOpenPrs("/repo", { runner: makeRunner(list, views) });
    expect(prs[0]!.lastActivityAt).toBe(dayAgo(2));
  });

  it("无任何活动数据 → lastActivityAt=null（不猜，判定层据此不判停滞）", async () => {
    const list = [{ number: 4, title: "t", headRefName: "b", body: null, url: null, createdAt: dayAgo(3) }];
    const prs = await collectOpenPrs("/repo", { runner: makeRunner(list, { 4: { commits: [], reviews: [], comments: [] } }) });
    expect(prs[0]!.lastActivityAt).toBeNull();
  });

  it("降级：gh list 失败 → 空数组不抛错（检测器缺失 ≠ 系统健康）", async () => {
    const prs = await collectOpenPrs("/repo", { runner: makeRunner([], {}, "list") });
    expect(prs).toEqual([]);
  });

  it("降级：单 PR view 失败 → PR 保留，lastActivityAt=null", async () => {
    const list = [{ number: 5, title: "t", headRefName: "b", body: null, url: null, createdAt: dayAgo(3) }];
    const prs = await collectOpenPrs("/repo", { runner: makeRunner(list, {}, "view") });
    expect(prs).toHaveLength(1);
    expect(prs[0]!.lastActivityAt).toBeNull();
  });

  it("降级：list 返回非数组 JSON → 空数组", async () => {
    const prs = await collectOpenPrs("/repo", { runner: makeRunner({ error: "bad" }) });
    expect(prs).toEqual([]);
  });
});
