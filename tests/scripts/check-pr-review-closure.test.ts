/**
 * check-pr-review-closure 机械闸可持续测试（F20261118rvcls）。
 *
 * 覆盖闭环谓词四条件（head 覆盖 / 通过语义 / 处置确认 / 审查者署名）的正反路径，
 * 及断环①（检视覆盖后 head 前移）、断环②（alpha 修复 commit 无 review 覆盖）的
 * 真实形态回归——实证 PR #1909 的两处断环均由「覆盖后 head 前移」触发本闸。
 */
import { describe, it, expect } from "vitest";
import { checkReviewClosure, type PrReview } from "../../scripts/check-pr-review-closure.mjs";

/** 构造一条 review：commit oid 可空，body 可定制 */
function review(oid: string | null, body: string): PrReview {
  return { commit: oid ? { oid } : null, body, state: "COMMENTED", author: { login: "chenlaicai" } };
}

/** 覆盖 head 的通过回执（满足四条件） */
const PASS_BODY = [
  "## 审查者",
  "reviewer-1902-dspro",
  "",
  "## 审查结论",
  "**通过（delta 复核）**",
  "",
  "## 上轮处置确认",
  "- minor-1 修复 ✓ 已复核",
  "- alpha 两处修复 ✓ 已复核",
].join("\n");

describe("checkReviewClosure 闭环谓词四条件", () => {
  it("四条件齐备 → closed", () => {
    const r = checkReviewClosure({
      headRefOid: "aaa1111",
      author: { login: "chenlaicai" },
      reviews: [review("aaa1111", PASS_BODY)],
    });
    expect(r).toEqual({ ok: true, status: "closed", reasons: [] });
  });

  it("无 headRefOid → undeterminable（数据不完整拒判）", () => {
    const r = checkReviewClosure({ headRefOid: null, reviews: [review("aaa1111", PASS_BODY)] });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("undeterminable");
  });

  it("无 reviews → no_review（从未走过独立检视）", () => {
    const r = checkReviewClosure({ headRefOid: "aaa1111", reviews: [] });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("no_review");
  });

  it("head 前移无覆盖 → head_not_covered（实证断环①②的核心形态）", () => {
    const r = checkReviewClosure({
      headRefOid: "ccc3333",
      author: { login: "chenlaicai" },
      reviews: [review("aaa1111", PASS_BODY)], // 检视覆盖停在旧 commit，head 已前移
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("head_not_covered");
    expect(r.reasons[0]).toContain("无检视覆盖");
  });

  it("覆盖回执结论「需要修改」→ needs_changes（优先于通过词判定）", () => {
    const r = checkReviewClosure({
      headRefOid: "aaa1111",
      reviews: [
        review(
          "aaa1111",
          "## 审查者\nreviewer-1\n## 审查结论\n**需要修改**\n## 上轮处置确认\n- x",
        ),
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("needs_changes");
  });

  it("覆盖回执无通过结论词 → no_pass_semantics", () => {
    const r = checkReviewClosure({
      headRefOid: "aaa1111",
      reviews: [review("aaa1111", "## 审查者\nreviewer-1\n## 上轮处置确认\n- x")],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("no_pass_semantics");
  });

  it("覆盖回执无处置确认段 → no_disposition", () => {
    const r = checkReviewClosure({
      headRefOid: "aaa1111",
      reviews: [review("aaa1111", "## 审查者\nreviewer-1\n**通过（delta 复核）**\n看起来不错")],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("no_disposition");
  });

  it("覆盖回执无审查者署名 → no_reviewer（挡 self-PASS）", () => {
    const r = checkReviewClosure({
      headRefOid: "aaa1111",
      reviews: [review("aaa1111", "**通过（delta 复核）**\n## 上轮处置确认\n- x")],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("no_reviewer");
  });

  it("多条 review：旧 head 断环、覆盖 head 的最后一条通过 → closed", () => {
    const r = checkReviewClosure({
      headRefOid: "ccc3333",
      reviews: [
        review("aaa1111", PASS_BODY),
        review("bbb2222", "## 审查者\nreviewer-2\n**需要修改**\n## 上轮处置确认\n- 还有问题"),
        review("ccc3333", PASS_BODY),
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("覆盖 head 的回执 body 为空 → 依次落 no_pass_semantics", () => {
    const r = checkReviewClosure({ headRefOid: "aaa1111", reviews: [review("aaa1111", "")] });
    expect(r.ok).toBe(false);
    expect(["no_pass_semantics"]).toContain(r.status);
  });
});