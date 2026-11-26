/**
 * issue 认领闸（check-pr-claim）机械测试。
 *
 * 覆盖谓词正反路径：无 issue 引用放行 / docs-only 豁免 / 无认领红 / 认领匹配绿 /
 * 他线认领（F-ID 不匹配）红 / release 撤销后无认领红 / 非 OPEN 跳过——以及
 * 跨对话双呈实证形态（引用了 issue 但全程零认领评论 → 必须红）的回归。
 */
import { describe, it, expect } from "vitest";
import { checkClaim, extractIssueNumbers, featureId, parseClaims } from "../../scripts/check-pr-claim.mjs";

function comment(body: string) {
  return { body, createdAt: "2026-11-19T01:00:00Z", author: { login: "chenlaicai" } };
}

const CLAIM_BODY = (worktree: string) =>
  `🦦 认领 #1951\n<!-- otter-claim: conversation=abc123; otter=大獭; worktree=${worktree}; at=2026-11-19T01:12:00+08:00 -->\n开工：测试`;

const PR = (over = {}) => ({
  state: "OPEN",
  title: "认领闸测试 PR（#1951）",
  body: "Closes #1951",
  headRefName: "fix/F20261119claim-claim-gates",
  files: [{ path: "scripts/check-pr-claim.mjs" }],
  ...over,
});

describe("checkClaim 认领谓词", () => {
  it("认领匹配（worktree F-ID = 分支 F-ID）→ 绿", () => {
    const r = checkClaim(PR(), { 1951: [comment(CLAIM_BODY("F20261119claim"))] });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("claimed");
  });

  it("#1899 双呈实证形态：引用 issue 但零认领评论 → 红 + 认领命令提示", () => {
    const r = checkClaim(PR(), { 1951: [] });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain("无有效 otter-claim");
    expect(r.hint).toContain("gh issue comment 1951");
  });

  it("他线认领（worktree F-ID ≠ 分支 F-ID）→ 红", () => {
    const r = checkClaim(PR(), { 1951: [comment(CLAIM_BODY("F20261118kills"))] });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain("不匹配");
  });

  it("认领被同对话 release 撤销 → 视为无认领红", () => {
    const r = checkClaim(PR(), {
      1951: [comment(CLAIM_BODY("F20261119claim")), comment("<!-- otter-claim-release: conversation=abc123 -->")],
    });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain("无有效 otter-claim");
  });

  it("迁移序列：认领→release→再认领 → 最终认领有效（时间序状态机）", () => {
    const t = (body: string, min: number) => ({ body, createdAt: `2026-11-19T01:${String(min).padStart(2, "0")}:00Z`, author: { login: "chenlaicai" } });
    const r = checkClaim(PR(), {
      1951: [
        t(CLAIM_BODY("F20261119cimp2"), 10),
        t("<!-- otter-claim-release: conversation=abc123 -->", 20),
        t(CLAIM_BODY("F20261119claim"), 30),
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("claimed");
  });

  it("无 issue 引用（非 issue 驱动）→ 放行", () => {
    const r = checkClaim(PR({ title: "重构提交", body: "无 issue 引用", headRefName: "refactor/cleanup" }), {});
    expect(r.ok).toBe(true);
    expect(r.status).toBe("no_issue_reference");
  });

  it("docs-only PR → 豁免", () => {
    const r = checkClaim(PR({ files: [{ path: "docs/features/x.md" }] }), {});
    expect(r.ok).toBe(true);
    expect(r.status).toBe("exempt_docs_only");
  });

  it("纯 AGENTS.md 变更不属 docs-only 豁免（与相邻闸同源，kimi检视獭-1954 MINOR-3）", () => {
    const r = checkClaim(PR({ files: [{ path: "AGENTS.md" }] }), {});
    expect(r.ok).toBe(false);
    expect(r.status).toBe("claim_missing_or_mismatch");
  });

  it("仓根 SECURITY.md 仍在豁免集（与 check-pr-evidence 同源）", () => {
    const r = checkClaim(PR({ files: [{ path: "SECURITY.md" }] }), {});
    expect(r.ok).toBe(true);
    expect(r.status).toBe("exempt_docs_only");
  });

  it("叙述性引用另一 PR → 不当 issue 认领对象，放行（#2001）", () => {
    const r = checkClaim(PR({ title: "重构提交", body: "上一轮 #1974 的后续整理" }), {}, {
      1974: { state: "closed", pull_request: { url: "https://api.github.com/repos/chenlaicai/otter-buddy/pulls/1974" } },
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("no_issue_reference");
  });

  it("PR 引用放行但真实未认领 OPEN issue 仍阻断（#2001 双向闸）", () => {
    const r = checkClaim(PR({ title: "修复 #2001", body: "上一轮 #1974，本轮处理 #2001" }), { 2001: [] }, {
      1974: { state: "closed", pull_request: { url: "https://api.github.com/repos/chenlaicai/otter-buddy/pulls/1974" } },
      2001: { state: "open" },
    });
    expect(r.ok).toBe(false);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toContain("issue #2001");
    expect(r.reasons[0]).not.toContain("issue #1974");
  });

  it("已关闭 issue 引用也不再要求认领（#2001 OPEN-only 边界）", () => {
    const r = checkClaim(PR({ title: "复盘提交", body: "复盘 #1999" }), {}, { 1999: { state: "closed" } });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("no_issue_reference");
  });

  it("非 OPEN → 跳过", () => {
    const r = checkClaim(PR({ state: "MERGED" }), {});
    expect(r.ok).toBe(true);
    expect(r.status).toBe("skipped_not_open");
  });

  it("分支无 F-ID 且认领存在 → 红（无法匹配）", () => {
    const r = checkClaim(PR({ headRefName: "fix/no-fid-branch" }), { 1951: [comment(CLAIM_BODY("F20261119claim"))] });
    expect(r.ok).toBe(false);
  });
});

describe("辅助函数", () => {
  it("extractIssueNumbers：closes 族优先时裸引用不计为工作对象（本 PR 实证形态回归）", () => {
    // 概述段叙述历史事故引用，尾部 Closes 族声明工作对象——裸井号引用不得误拦（kimi检视獭-1954 BLOCK-1a）
    const body = "昨日 #1899 双呈爆雷的根因修复。\n\nCloses #1951";
    expect(extractIssueNumbers("认领闸测试 PR", body)).toEqual([1951]);
  });

  it("extractIssueNumbers：closing issue URL 形态同样提取（BLOCK-1b 回归）", () => {
    expect(extractIssueNumbers("修复认领闸", "Closes https://github.com/chenlaicai/otter-buddy/issues/1951")).toEqual([1951]);
    expect(extractIssueNumbers("修复认领闸", "fixes: https://github.com/foo/bar/issues/42 关闭引用")).toEqual([42]);
  });

  it("extractIssueNumbers：无 closes 族时裸 #N 全部兜底（「修复 #N」惯用形态）", () => {
    expect(extractIssueNumbers("修复 #1", "关联 #2 与 #3")).toEqual([1, 2, 3]);
  });

  it("extractIssueNumbers：closes 动词变体与词边界（disclose 不误配）", () => {
    expect(extractIssueNumbers("", "closed #7 Resolves: #8 FIXING #9")).toEqual([7, 8, 9]);
    expect(extractIssueNumbers("", "disclose #10 未关问 bug")).toEqual([10]); // 裸兑底——disclose 不是 closes 动词，走兑底计为工作对象属已接受残余
  });

  it("extractIssueNumbers：裸 issue URL（无 closes 动词）不计为工作对象——双闸一致", () => {
    expect(extractIssueNumbers("研究", "参考 https://github.com/chenlaicai/otter-buddy/issues/1899 复盘")).toEqual([]);
  });

  it("featureId：F+日期+5 位小写字母", () => {
    expect(featureId("fix/F20261119claim-claim-gates")).toBe("F20261119claim");
    expect(featureId("no fid")).toBeNull();
  });

  it("parseClaims：认领/释放注释解析", () => {
    const claims = parseClaims([comment(CLAIM_BODY("F20261119claim"))]);
    expect(claims).toEqual([{ conversation: "abc123", otter: "大獭", worktree: "F20261119claim" }]);
    expect(parseClaims([comment("普通评论")])).toEqual([]);
  });
});
