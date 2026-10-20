/**
 * F20261019f714（M-f7148deb 第 2 条）：链接订正通道行为锁定。
 *
 * 背景：文档 rename 后引用链同步需要改历史文档正文的链接路径——此前被
 * lint-historical-docs 全拦（正文修改无开口），F20261001lrbk 因此搁置根治
 * 改走豁免（lint:docs ratchet 上限 3）。本通道补齐机械开口：.doc-fix 声明 +
 * 全部变更行是成对的纯链接路径/反引号 .md 文件名替换。
 *
 * 双向断言：链接订正放行 / 正文观点修改仍拦 / 非成对仍拦 / 无声明仍拦。
 * 独立迷你 fixture（与 rename 主套件同款隔离方式）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LINT = fileURLToPath(new URL("../scripts/lint-historical-docs.mjs", import.meta.url));

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runLint(cwd: string, args: string[] = []) {
  const r = spawnSync("node", [LINT, ...args], { cwd, encoding: "utf8", env: { ...process.env } });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

const TARGET = "docs/features/2026/01/01/F20260101tgt-old-feature.md";
const REFEREE = "docs/features/2026/01/02/F20260102ref-referencing-doc.md";
const TARGET_CONTENT = `---\nid: F20260101tgt\ntitle: 被引用文档\nchange_type: feature\n---\n\n# 被引用文档\n\n正文。\n`;
const REFEREE_CONTENT = `---\nid: F20260102ref\ntitle: 引用方文档\nchange_type: feature\n---\n\n# 引用方文档\n\n- [被引用文档](../01/F20260101tgt-old-feature.md) — 详见
- 文件清单：\`F20260101tgt-old-feature.md\`
-- 旧观点：本表只读
`;

let repo: string;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "lint-hist-linkfix-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@test"]);
  git(repo, ["config", "user.name", "test"]);
  fs.mkdirSync(path.join(repo, "docs/features/2026/01/01"), { recursive: true });
  fs.mkdirSync(path.join(repo, "docs/features/2026/01/02"), { recursive: true });
  fs.writeFileSync(path.join(repo, TARGET), TARGET_CONTENT);
  fs.writeFileSync(path.join(repo, REFEREE), REFEREE_CONTENT);
  fs.writeFileSync(path.join(repo, "README.md"), "# repo\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "main: historical docs"]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["update-ref", "refs/remotes/origin/main", head]);
  git(repo, ["checkout", "-q", "-b", "feature/linkfix"]);
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("lint-historical-docs 链接订正通道（F20261019f714，M-f7148deb 第 2 条）", () => {
  it("rename + 引用方链接同步 + .doc-fix → 放行（修复前全拦，lrbk 搁置的根治通道）", () => {
    const renamed = "docs/features/2026/01/01/F20260101tgt-new-slug.md";
    git(repo, ["mv", TARGET, renamed]);
    // 引用方两处同步：markdown 链接 + 反引号文件名 token
    fs.writeFileSync(
      path.join(repo, REFEREE),
      REFEREE_CONTENT
        .replace("../01/F20260101tgt-old-feature.md", "../01/F20260101tgt-new-slug.md")
        .replace("`F20260101tgt-old-feature.md`", "`F20260101tgt-new-slug.md`"),
    );
    fs.writeFileSync(path.join(repo, ".doc-fix"), "文档改名后的引用链同步订正（纯链接路径替换）\n");
    git(repo, ["add", "-A"]);
    const r = runLint(repo);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("纯链接路径订正");
    // 清理：恢复现场供后续用例
    git(repo, ["reset", "-q", "--hard", "HEAD"]);
  });

  it("链接改动的同行为观点修改（非路径差异）→ 仍拦（宁拦勿放）", () => {
    fs.writeFileSync(
      path.join(repo, REFEREE),
      REFEREE_CONTENT.replace("[被引用文档](../01/F20260101tgt-old-feature.md)", "[被引用文档（改了观点标题）](../01/F20260101tgt-old-feature.md)"),
    );
    fs.writeFileSync(path.join(repo, ".doc-fix"), "试图混入观点修改的链接订正声明（测试负例）\n");
    git(repo, ["add", "-A"]);
    const r = runLint(repo);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("正文实质修改");
    git(repo, ["reset", "-q", "--hard", "HEAD"]);
  });

  it("链接订正 + 无关正文行新增（非成对）→ 仍拦", () => {
    fs.writeFileSync(
      path.join(repo, REFEREE),
      REFEREE_CONTENT.replace("../01/F20260101tgt-old-feature.md", "../01/F20260101tgt-renamed.md") + "\n多出来的一行正文。\n",
    );
    fs.writeFileSync(path.join(repo, ".doc-fix"), "链接订正但夹带私货\n");
    git(repo, ["add", "-A"]);
    const r = runLint(repo);
    expect(r.status).not.toBe(0);
    git(repo, ["reset", "-q", "--hard", "HEAD"]);
  });

  it("链接订正但无 .doc-fix 声明 → 仍拦（开口必须显式声明）", () => {
    fs.writeFileSync(
      path.join(repo, REFEREE),
      REFEREE_CONTENT.replace("../01/F20260101tgt-old-feature.md", "../01/F20260101tgt-renamed.md"),
    );
    git(repo, ["add", "-A"]);
    const r = runLint(repo);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("禁止修改");
    git(repo, ["reset", "-q", "--hard", "HEAD"]);
  });

  it("纯正文修改（无链接语义）+ .doc-fix → 仍拦（原行为回归锁）", () => {
    fs.writeFileSync(
      path.join(repo, REFEREE),
      REFEREE_CONTENT.replace("# 引用方文档", "# 引用方文档（改标题）"),
    );
    fs.writeFileSync(path.join(repo, ".doc-fix"), "普通正文修改\n");
    git(repo, ["add", "-A"]);
    const r = runLint(repo);
    expect(r.status).not.toBe(0);
    git(repo, ["reset", "-q", "--hard", "HEAD"]);
  });

  it("S3 负例：内容以 --/++ 开头的观点改写行夹带链接对（前缀碰撞）→ 仍拦", () => {
    // 合法 rename + 一对合法链接/token 订正，再夹带一对 `-- 旧观点` → `++ 新观点` 改写：
    // 旧版跳 ---/+++ 字面行时这对因 diff 渲染恰成 ---/+++ 而隐形，配对账平 → 放行（fail-open）。
    const renamed = "docs/features/2026/01/01/F20260101tgt-new-slug.md";
    git(repo, ["mv", TARGET, renamed]);
    fs.writeFileSync(
      path.join(repo, REFEREE),
      REFEREE_CONTENT
        .replace("../01/F20260101tgt-old-feature.md", "../01/F20260101tgt-new-slug.md")
        .replace("`F20260101tgt-old-feature.md`", "`F20260101tgt-new-slug.md`")
        .replace("-- 旧观点：本表只读", "++ 新观点：本表可写"),
    );
    fs.writeFileSync(path.join(repo, ".doc-fix"), "链接同步夹带 --/++ 观点行改写（测试负例）\n");
    git(repo, ["add", "-A"]);
    const r = runLint(repo);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("正文实质修改");
    git(repo, ["reset", "-q", "--hard", "HEAD"]);
  });

  it("J1 负例：无任何 rename 的纯改链接指向（改溯源主张）→ 仍拦（rename 对账）", () => {
    fs.writeFileSync(
      path.join(repo, REFEREE),
      REFEREE_CONTENT.replace("../01/F20260101tgt-old-feature.md", "../01/F20260101tgt-retargeted.md"),
    );
    fs.writeFileSync(path.join(repo, ".doc-fix"), "无 rename 纯改链接指向（测试负例）\n");
    git(repo, ["add", "-A"]);
    const r = runLint(repo);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("正文实质修改");
    git(repo, ["reset", "-q", "--hard", "HEAD"]);
  });

  it("S2 base 模式（CI per-commit 回放）：rename+引用同步+声明同 commit → --base 放行；后继观点改写 commit → 整段拦", () => {
    const renamed = "docs/features/2026/01/01/F20260101tgt-cibase.md";
    git(repo, ["mv", TARGET, renamed]);
    fs.writeFileSync(
      path.join(repo, REFEREE),
      REFEREE_CONTENT
        .replace("../01/F20260101tgt-old-feature.md", "../01/F20260101tgt-cibase.md")
        .replace("`F20260101tgt-old-feature.md`", "`F20260101tgt-cibase.md`"),
    );
    fs.writeFileSync(path.join(repo, ".doc-fix"), "base 模式：改名引用同步声明（测试正例）\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "feat: rename + link sync"]);
    const ok = runLint(repo, ["--base", "origin/main"]);
    expect(ok.status).toBe(0); // S2：链接订正通道在 --base 回放同样生效（修复前此 commit 必红）
    // 后继 commit：观点改写（带声明）——逐 commit 回放必须在第二个 commit 转红
    fs.writeFileSync(
      path.join(repo, REFEREE),
      fs.readFileSync(path.join(repo, REFEREE), "utf8").replace("# 引用方文档", "# 引用方文档（观点改）"),
    );
    fs.writeFileSync(path.join(repo, ".doc-fix"), "base 模式：观点改写（测试负例）\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "feat: opinion change"]);
    const bad = runLint(repo, ["--base", "origin/main"]);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("正文实质修改");
    git(repo, ["reset", "-q", "--hard", "origin/main"]);
  });
});
