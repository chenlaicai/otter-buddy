/**
 * check-pr-review-closure 机械闸可持续测试（F20261118rvcls）。
 *
 * 覆盖闭环谓词四条件（head 覆盖 / 结论段通过语义 / 处置确认 / 审查者署名）的正反路径，
 * 及断环①（检视覆盖后 head 前移）、断环②（alpha 修复 commit 无 review 覆盖）的
 * 真实形态回归——实证 PR #1909 的两处断环均由「覆盖后 head 前移」触发本闸。
 * 另覆盖 S1（结论判定限定「审查结论」段，上轮处置确认的「需要修改」不误伤）与
 * A3（否定式「未通过」误受）修复回归，以及 docs-only 豁免集合。
 */
import { describe, it, expect } from "vitest";
import {
  checkReviewClosure,
  extractSection,
  isDocOnlyPath,
  isDocOnlyDiff,
  type PrReview,
} from "../../scripts/check-pr-review-closure.mjs";

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

  it("覆盖回执结论段「需要修改」→ needs_changes（优先于通过词判定）", () => {
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

  it("覆盖回执无「审查结论」段 → no_conclusion", () => {
    const r = checkReviewClosure({
      headRefOid: "aaa1111",
      reviews: [review("aaa1111", "## 审查者\nreviewer-1\n## 上轮处置确认\n- x")],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("no_conclusion");
  });

  it("结论段无通过结论词 → no_pass_semantics", () => {
    const r = checkReviewClosure({
      headRefOid: "aaa1111",
      reviews: [review("aaa1111", "## 审查者\nreviewer-1\n## 审查结论\n看起来不错\n## 上轮处置确认\n- x")],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("no_pass_semantics");
  });

  it("覆盖回执无处置确认段 → no_disposition", () => {
    const r = checkReviewClosure({
      headRefOid: "aaa1111",
      reviews: [review("aaa1111", "## 审查者\nreviewer-1\n## 审查结论\n**通过（delta 复核）**\n看起来不错")],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("no_disposition");
  });

  it("覆盖回执无审查者署名 → no_reviewer", () => {
    const r = checkReviewClosure({
      headRefOid: "aaa1111",
      reviews: [review("aaa1111", "## 审查结论\n**通过（delta 复核）**\n## 上轮处置确认\n- x")],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("no_reviewer");
  });

  it("多条 review：旧 head 断环、覆盖 head 的最后一条通过 → closed", () => {
    const r = checkReviewClosure({
      headRefOid: "ccc3333",
      reviews: [
        review("aaa1111", PASS_BODY),
        review("bbb2222", "## 审查者\nreviewer-2\n## 审查结论\n**需要修改**\n## 上轮处置确认\n- 还有问题"),
        review("ccc3333", PASS_BODY),
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("S1 回归：结论=通过但上轮处置确认含「需要修改」→ closed（不再误拒）", () => {
    const body = [
      "## 审查者",
      "reviewer-1",
      "## 审查结论",
      "**通过（delta 复核）**",
      "## 上轮处置确认",
      "| 上轮发现 | 处置终态 | 证据 |",
      "| 发现1（需要修改）→ 已修复 | 修复+delta 确认 | file:line |",
    ].join("\n");
    const r = checkReviewClosure({ headRefOid: "aaa1111", reviews: [review("aaa1111", body)] });
    expect(r).toEqual({ ok: true, status: "closed", reasons: [] });
  });

  it("A3 回归：结论段否定式「没有通过」→ neg_pass 拒绝", () => {
    const r = checkReviewClosure({
      headRefOid: "aaa1111",
      reviews: [
        review("aaa1111", "## 审查者\nreviewer-1\n## 审查结论\n我没有通过完整回归，但基本通过\n## 上轮处置确认\n- x"),
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("neg_pass");
  });

  it("覆盖 head 的回执 body 为空 → no_conclusion", () => {
    const r = checkReviewClosure({ headRefOid: "aaa1111", reviews: [review("aaa1111", "")] });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("no_conclusion");
  });
});

describe("extractSection 结论段提取", () => {
  it("提取「## 审查结论」到下一个 ## 之间的内容", () => {
    const body = "## 审查者\nreviewer-1\n## 审查结论\n**通过**\n## 上轮处置确认\n- x";
    const s = extractSection(body, "审查结论");
    expect(s).toBe("\n**通过**\n");
  });

  it("无该段 → null", () => {
    expect(extractSection("## 审查者\nreviewer-1", "审查结论")).toBeNull();
  });
});

describe("docs-only 豁免集合", () => {
  it("docs/ 全树豁免，仓根标准文档豁免", () => {
    expect(isDocOnlyPath("docs/features/x.md")).toBe(true);
    expect(isDocOnlyPath("docs/调研/中文.md")).toBe(true);
    expect(isDocOnlyPath("README.md")).toBe(true);
    expect(isDocOnlyPath("CHANGELOG-2026.md")).toBe(true);
  });

  it("代码/配置/运行时契约不豁免", () => {
    expect(isDocOnlyPath("scripts/check-pr-review-closure.mjs")).toBe(false);
    expect(isDocOnlyPath(".pi/skills/adversarial-review/SKILL.md")).toBe(false);
    expect(isDocOnlyPath(".github/workflows/ci.yml")).toBe(false);
    expect(isDocOnlyPath("src/app.ts")).toBe(false);
    expect(isDocOnlyPath("README.ts")).toBe(false);
  });

  it("isDocOnlyDiff：全 docs → true；混代码 → false；空 → false", () => {
    expect(isDocOnlyDiff(["docs/a.md", "docs/b.md"])).toBe(true);
    expect(isDocOnlyDiff(["docs/a.md", "src/app.ts"])).toBe(false);
    expect(isDocOnlyDiff([])).toBe(false);
  });
});