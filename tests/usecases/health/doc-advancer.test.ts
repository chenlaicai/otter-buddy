import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { planDocAdvancements, applyAdvancements } from "@usecases/health/doc-advancer";
import type { ChainEvidence } from "@usecases/health/doc-advancer";

const NOW = new Date("2026-09-01T12:00:00+08:00");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

/** 构造链证据 */
function chain(
  fid: string,
  status: string | null,
  opts: {
    substatus?: string | null;
    commits?: Array<{ daysAgo: number; pr?: number | null }>;
  } = {},
): ChainEvidence {
  const commits = (opts.commits ?? []).map(c => ({
    date: daysAgo(c.daysAgo),
    prNumber: c.pr === undefined ? null : c.pr,
  }));
  const last = commits.length > 0 ? commits[commits.length - 1]!.date : null;
  return {
    featureId: fid,
    doc: { status, substatus: opts.substatus ?? null, filePath: `docs/features/${fid}.md` },
    commits,
    lastCommitAt: last,
    commitCount: commits.length,
  };
}

describe("#646 段3 planDocAdvancements 推进计划", () => {
  it("R1 迭代标记：纯 implemented ∧ 标注后叉有代码 commit ≤14 天 → mark-iterating", () => {
    const evidence: ChainEvidence = {
      featureId: "F20260901r1aa",
      doc: { status: "implemented", substatus: null, filePath: "docs/features/F20260901r1aa.md" },
      commits: [
        { date: daysAgo(30), prNumber: 100, sha: "sha-doc" },
        { date: daysAgo(5), prNumber: 101, sha: "sha-code" },
      ],
      lastCommitAt: daysAgo(5),
      commitCount: 2,
      docLastTouchedSha: "sha-doc",
    };
    const plan = planDocAdvancements([evidence], { now: NOW });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ fid: "F20260901r1aa", kind: "mark-iterating" });
  });

  it("R1 不误标：纯 implemented 但静默 >14 天 → 无动作（既不标迭代也不收口）", () => {
    const plan = planDocAdvancements(
      [
        {
          ...chain("F20260901r1ab", "implemented", { commits: [{ daysAgo: 30, pr: 100 }] }),
          docLastTouchedSha: "sha-x",
        },
      ],
      { now: NOW },
    );
    expect(plan.actions).toHaveLength(0);
  });

  it("R1 幂等前置：已带 substatus:active 的 implemented → 不重复标", () => {
    const plan = planDocAdvancements(
      [chain("F20260901r1ac", "implemented", { substatus: "active", commits: [{ daysAgo: 5, pr: 100 }] })],
      { now: NOW },
    );
    expect(plan.actions.filter(a => a.kind === "mark-iterating")).toHaveLength(0);
  });

  it("R2 迭代收口：implemented+active ∧ 静默 >14 天 → close-iteration", () => {
    const plan = planDocAdvancements(
      [chain("F20260901r2aa", "implemented", { substatus: "active", commits: [{ daysAgo: 20, pr: 100 }] })],
      { now: NOW },
    );
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ fid: "F20260901r2aa", kind: "close-iteration" });
  });

  it("R2 不误收：implemented+active 且 5 天前有 commit → 保持迭代中，无动作", () => {
    const plan = planDocAdvancements(
      [chain("F20260901r2ab", "implemented", { substatus: "active", commits: [{ daysAgo: 5, pr: 100 }] })],
      { now: NOW },
    );
    expect(plan.actions).toHaveLength(0);
  });

  it("R3 高置信归档：development ∧ 全 commit 带 PR ∧ 静默 >60 天 → archive", () => {
    const plan = planDocAdvancements(
      [
        chain("F20260901r3aa", "development", {
          commits: [
            { daysAgo: 90, pr: 100 },
            { daysAgo: 70, pr: 101 },
          ],
        }),
      ],
      { now: NOW },
    );
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ fid: "F20260901r3aa", kind: "archive", fromStatus: "development" });
  });

  it("R3 不满足高置信：存在无 PR 号 commit → 跳过留痕（交僵尸阶梯）", () => {
    const plan = planDocAdvancements(
      [
        chain("F20260901r3ab", "development", {
          commits: [
            { daysAgo: 90, pr: 100 },
            { daysAgo: 70, pr: null },
          ],
        }),
      ],
      { now: NOW },
    );
    expect(plan.actions).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.fid).toBe("F20260901r3ab");
    expect(plan.skipped[0]!.reason).toContain("僵尸阶梯");
  });

  it("R3 不满足静默：全 PR 但 30 天前有 commit → 无动作", () => {
    const plan = planDocAdvancements(
      [chain("F20260901r3ac", "development", { commits: [{ daysAgo: 30, pr: 100 }] })],
      { now: NOW },
    );
    expect(plan.actions).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
  });

  it("未知值不碰：status: wip → 跳过留痕（验收标准）", () => {
    const plan = planDocAdvancements(
      [chain("F20260901unkw", "wip", { commits: [{ daysAgo: 90, pr: 100 }] })],
      { now: NOW },
    );
    expect(plan.actions).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.reason).toContain("unknown");
  });

  it("真终态不碰：final/locked/archived → 无动作无留痕", () => {
    const plan = planDocAdvancements(
      [
        chain("F20260901fnal", "final", { commits: [{ daysAgo: 5 }] }),
        chain("F20260901lock", "locked", { commits: [{ daysAgo: 5 }] }),
        chain("F20260901arch", "archived", { commits: [{ daysAgo: 5 }] }),
      ],
      { now: NOW },
    );
    expect(plan.actions).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
  });

  it("doc-only 无 commit：不推进（无实现证据不猜）", () => {
    const plan = planDocAdvancements([chain("F20260901doconly", "development")], { now: NOW });
    expect(plan.actions).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
  });

  it("orphan 链无文档：跳过不炸", () => {
    const orphan: ChainEvidence = {
      featureId: "F20260901orph",
      doc: null,
      commits: [{ date: daysAgo(5), prNumber: 1 }],
      lastCommitAt: daysAgo(5),
      commitCount: 1,
    };
    const plan = planDocAdvancements([orphan], { now: NOW });
    expect(plan.actions).toHaveLength(0);
  });

  it("review/reviewed 在途变体：满足 R3 条件同样归档", () => {
    const plan = planDocAdvancements(
      [chain("F20260901revw", "reviewed", { commits: [{ daysAgo: 90, pr: 100 }] })],
      { now: NOW },
    );
    expect(plan.actions[0]).toMatchObject({ kind: "archive", fromStatus: "reviewed" });
  });
});

describe("#646 段3 applyAdvancements frontmatter 改写", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-advancer-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const DOC_TEMPLATE = (status: string, substatus?: string) =>
    `---\nid: F20260901appl\ntitle: 测试文档\nsummary: 测试\nstatus: ${status}${substatus ? `\nsubstatus: ${substatus}` : ""}\ntags: []\n---\n\n正文内容\n`;

  async function writeDoc(content: string): Promise<void> {
    const dir = path.join(tmpDir, "docs/features");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "F20260901appl.md"), content, "utf-8");
  }

  async function readDoc(): Promise<string> {
    return fs.readFile(path.join(tmpDir, "docs/features/F20260901appl.md"), "utf-8");
  }

  const PLAN = (actions: Parameters<typeof applyAdvancements>[0]["actions"]) => ({
    actions,
    skipped: [],
    gapDispositions: [],
    plannedAt: NOW.toISOString(),
  });

  it("archive：status 值替换，其余 frontmatter 原样", async () => {
    await writeDoc(DOC_TEMPLATE("development"));
    const changed = await applyAdvancements(
      PLAN([
        {
          fid: "F20260901appl",
          kind: "archive",
          reason: "test",
          filePath: "docs/features/F20260901appl.md",
          fromStatus: "development",
        },
      ]),
      tmpDir,
    );
    expect(changed).toBe(1);
    const out = await readDoc();
    expect(out).toContain("status: implemented");
    expect(out).toContain("title: 测试文档");
    expect(out).toContain("正文内容");
  });

  it("archive 保留行内注释：`status: development # 备注` 只换值不丢注释", async () => {
    await writeDoc(`---\nid: F20260901appl\ntitle: t\nsummary: s\nstatus: development   # 设计评审通过待实现\ntags: []\n---\nbody\n`);
    await applyAdvancements(
      PLAN([
        { fid: "F20260901appl", kind: "archive", reason: "test", filePath: "docs/features/F20260901appl.md", fromStatus: "development" },
      ]),
      tmpDir,
    );
    const out = await readDoc();
    expect(out).toMatch(/status: implemented\s+# 设计评审通过待实现/);
  });

  it("mark-iterating：status 行后插入 substatus: active", async () => {
    await writeDoc(DOC_TEMPLATE("implemented"));
    await applyAdvancements(
      PLAN([
        { fid: "F20260901appl", kind: "mark-iterating", reason: "test", filePath: "docs/features/F20260901appl.md" },
      ]),
      tmpDir,
    );
    const out = await readDoc();
    expect(out).toMatch(/status: implemented\nsubstatus: active/);
  });

  it("close-iteration：删除 substatus 行", async () => {
    await writeDoc(DOC_TEMPLATE("implemented", "active"));
    await applyAdvancements(
      PLAN([
        { fid: "F20260901appl", kind: "close-iteration", reason: "test", filePath: "docs/features/F20260901appl.md" },
      ]),
      tmpDir,
    );
    const out = await readDoc();
    expect(out).not.toContain("substatus");
    expect(out).toContain("status: implemented");
  });

  it("幂等性（验收标准）：同一 plan apply 两次，第二次 changed=0 且文件内容不变", async () => {
    await writeDoc(DOC_TEMPLATE("development"));
    const plan = PLAN([
      { fid: "F20260901appl", kind: "archive", reason: "test", filePath: "docs/features/F20260901appl.md", fromStatus: "development" },
    ]);
    const first = await applyAdvancements(plan, tmpDir);
    const midState = await readDoc();
    const second = await applyAdvancements(plan, tmpDir);
    const endState = await readDoc();
    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(endState).toBe(midState);
  });

  it("mark-iterating 幂等：已有 substatus 行 → 无改动", async () => {
    await writeDoc(DOC_TEMPLATE("implemented", "active"));
    const changed = await applyAdvancements(
      PLAN([
        { fid: "F20260901appl", kind: "mark-iterating", reason: "test", filePath: "docs/features/F20260901appl.md" },
      ]),
      tmpDir,
    );
    expect(changed).toBe(0);
  });

  it("文件不存在：跳过不炸（changed=0）", async () => {
    const changed = await applyAdvancements(
      PLAN([
        { fid: "F20260901gone", kind: "archive", reason: "test", filePath: "docs/features/F20260901gone.md", fromStatus: "development" },
      ]),
      tmpDir,
    );
    expect(changed).toBe(0);
  });
});

// ===== R1 证据门槛：区分「PR 同步拍板」与「标注后又迭代」（2026-09-01 dry-run 实测修正） =====

// ===== #661 R1 推进器 14-60 天空窗处置：显式接受 + 留痕（不新增规则） =====

describe("#661 空窗处置：R1 关窗 ∧ R2 无 substatus ∧ R3 不适用 implemented", () => {
  const gapEvidence = (fid: string, idleDays: number): ChainEvidence => ({
    featureId: fid,
    doc: { status: "implemented", substatus: null, filePath: `docs/features/${fid}.md` },
    commits: [
      { date: daysAgo(idleDays + 30), prNumber: 100, sha: "sha-doc" },
      { date: daysAgo(idleDays), prNumber: 101, sha: "sha-code" },
    ],
    lastCommitAt: daysAgo(idleDays),
    commitCount: 2,
    docLastTouchedSha: "sha-doc", // 链尾 commit 未触碰文档（标注早于代码活动）
  });

  it("空窗核心：纯 implemented ∧ 链尾未碰文档 ∧ 静默 >14 天 → 无动作 + gapDispositions 留痕", () => {
    const plan = planDocAdvancements([gapEvidence("F20260901gapa", 30)], { now: NOW });
    expect(plan.actions).toHaveLength(0);
    expect(plan.gapDispositions).toHaveLength(1);
    expect(plan.gapDispositions[0]).toMatchObject({ fid: "F20260901gapa", idleDays: 30 });
    expect(plan.gapDispositions[0]!.reason).toContain("R2 收口等价终态");
  });

  it("空窗不误伤 R2：implemented+active ∧ 静默 >14 天 → close-iteration，不进 gapDispositions", () => {
    const evidence: ChainEvidence = {
      ...gapEvidence("F20260901gapb", 30),
      doc: { status: "implemented", substatus: "active", filePath: "docs/features/F20260901gapb.md" },
    };
    const plan = planDocAdvancements([evidence], { now: NOW });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ kind: "close-iteration" });
    expect(plan.gapDispositions).toHaveLength(0);
  });

  it("复活路径：空窗链新 commit 距今 ≤14 天 → R1 直达标记，不进 gapDispositions", () => {
    const plan = planDocAdvancements([gapEvidence("F20260901gapc", 10)], { now: NOW });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ fid: "F20260901gapc", kind: "mark-iterating" });
    expect(plan.gapDispositions).toHaveLength(0);
  });

  it("非空窗不误留痕：同步拍板（docLastTouchedSha == 链尾）∧ 静默 >14 天 → 无动作且无 gap 留痕", () => {
    const evidence: ChainEvidence = {
      featureId: "F20260901gapd",
      doc: { status: "implemented", substatus: null, filePath: "docs/features/F20260901gapd.md" },
      commits: [{ date: daysAgo(30), prNumber: 100, sha: "sha-last" }],
      lastCommitAt: daysAgo(30),
      commitCount: 1,
      docLastTouchedSha: "sha-last",
    };
    const plan = planDocAdvancements([evidence], { now: NOW });
    expect(plan.actions).toHaveLength(0);
    expect(plan.gapDispositions).toHaveLength(0);
  });

  it("幂等（空窗处置零副作用）：同一空窗链 plan 两次均无 action，留痕不触发任何文件改动", () => {
    const plan1 = planDocAdvancements([gapEvidence("F20260901gape", 30)], { now: NOW });
    const plan2 = planDocAdvancements([gapEvidence("F20260901gape", 30)], { now: NOW });
    expect(plan1.actions).toHaveLength(0);
    expect(plan2.actions).toHaveLength(0);
    expect(plan1.gapDispositions).toHaveLength(1);
    expect(plan2.gapDispositions).toHaveLength(1); // 纯留痕，重复运行无文件副作用
  });
});

describe("#646 R1 docLastTouchedSha 证据门槛", () => {
  it("标注与链尾 commit 同步（docLastTouchedSha == 链尾 sha）：不标迭代（完成拍板非迭代）", () => {
    const plan = planDocAdvancements(
      [
        {
          ...chain("F20260901r1ba", "implemented", { commits: [{ daysAgo: 3, pr: 100 }] }),
          docLastTouchedSha: "sha-last",
        },
      ],
      { now: NOW },
    );
    // 工厂 commits 无 sha → 链尾 sha=null。手工给链尾 sha：
    const evidence = {
      featureId: "F20260901r1ba",
      doc: { status: "implemented", substatus: null, filePath: "docs/features/F20260901r1ba.md" },
      commits: [{ date: daysAgo(3), prNumber: 100, sha: "sha-last" }],
      lastCommitAt: daysAgo(3),
      commitCount: 1,
      docLastTouchedSha: "sha-last",
    };
    const plan2 = planDocAdvancements([evidence], { now: NOW });
    expect(plan.actions).toHaveLength(0);
    expect(plan2.actions).toHaveLength(0);
  });

  it("标注后链尾叉有新 commit（docLastTouchedSha ≠ 链尾 sha）→ 标迭代", () => {
    const evidence = {
      featureId: "F20260901r1bb",
      doc: { status: "implemented", substatus: null, filePath: "docs/features/F20260901r1bb.md" },
      commits: [
        { date: daysAgo(30), prNumber: 100, sha: "sha-doc-commit" },
        { date: daysAgo(3), prNumber: 101, sha: "sha-code-commit" },
      ],
      lastCommitAt: daysAgo(3),
      commitCount: 2,
      docLastTouchedSha: "sha-doc-commit",
    };
    const plan = planDocAdvancements([evidence], { now: NOW });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ fid: "F20260901r1bb", kind: "mark-iterating" });
  });

  it("无 sha 证据（docLastTouchedSha undefined）：保守不标（宁可漏标不可误标）", () => {
    const evidence = {
      ...chain("F20260901r1bc", "implemented", { commits: [{ daysAgo: 3, pr: 100 }] }),
    };
    const plan = planDocAdvancements([evidence], { now: NOW });
    expect(plan.actions).toHaveLength(0);
  });
});
