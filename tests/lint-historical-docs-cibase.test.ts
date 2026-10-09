/**
 * F20261009hcig（#1281）：lint-historical-docs --base CI 模式行为锁定。
 *
 * 与既有三个套件分离（先例：rename/final 套件），聚焦 --base 逐 commit 重放语义：
 * 1. 同 commit 配对语义（本任务最关键约束）：
 *    - 红：无关 commit 塞 .doc-fix + 独立 commit 改历史文档 → CI 模式必拦
 *      （range 聚合「存在 .doc-fix 就放行」是被否方案——新绕过面）
 *    - 绿：.doc-fix 与 frontmatter 订正在同一 commit → 放行
 * 2. pre-commit 模式零回归：既有三套件全绿（本文件不重复覆盖，见 lint-historical-docs*.test.ts）
 * 3. base ref 不可解析 → 宽松放行 exit 0（fork PR 场景不误伤）
 * 4. merge commit 处置：跳过不检查（实测修正：up-to-date gate 强制 merge main + squash
 *    对消 .doc-fix 的误报面不可接受；非 merge commit 逐个全量重放，取舍见特性文档）
 * 5. 分支新建文档修改放行（isAddedOnBranch 的 range 内自洽：log 上界 = 父 commit）
 * 6. --base 缺参数 → exit 2（调用错误，立即红）
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LINT = fileURLToPath(new URL("../scripts/lint-historical-docs.mjs", import.meta.url));

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** 运行 lint 脚本（可传 CLI 参数），失败不抛错 */
function runLint(cwd: string, args: string[] = []) {
  const r = spawnSync("node", [LINT, ...args], { cwd, encoding: "utf8", env: { ...process.env } });
  return { stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim(), status: r.status ?? -1 };
}

const OLD_DOC = "docs/features/2026/01/01/F20260101old-old-feature.md";
const NEW_DOC = "docs/features/2026/08/31/F20260831new-new-feature.md";
const OLD_DOC_CONTENT = `---\nid: F20260101old\ntitle: 旧特性\nchange_type: feature\n---\n\n# 旧特性\n\n正文内容。\n`;

let repo: string;

/** 造一个基线仓库：main 上有历史文档 + origin/main 指向 main HEAD，当前在 feature/x */
function freshRepo(tmp: string) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), tmp));
  git(r, ["init", "-b", "main"]);
  git(r, ["config", "user.email", "test@test"]);
  git(r, ["config", "user.name", "test"]);
  fs.mkdirSync(path.join(r, "docs/features/2026/01/01"), { recursive: true });
  fs.writeFileSync(path.join(r, OLD_DOC), OLD_DOC_CONTENT);
  fs.writeFileSync(path.join(r, "README.md"), "# repo\n");
  git(r, ["add", "."]);
  git(r, ["commit", "-q", "-m", "main: historical doc"]);
  git(r, ["update-ref", "refs/remotes/origin/main", git(r, ["rev-parse", "HEAD"])]);
  git(r, ["checkout", "-q", "-b", "feature/x"]);
  return r;
}

/** 在 repo 中做一个 commit（files: [path, content]） */
function commitFiles(cwd: string, files: Array<[string, string]>, msg: string) {
  for (const [p, c] of files) {
    fs.mkdirSync(path.dirname(path.join(cwd, p)), { recursive: true });
    fs.writeFileSync(path.join(cwd, p), c);
    git(cwd, ["add", "--", p]);
  }
  git(cwd, ["commit", "-q", "-m", msg]);
}

beforeAll(() => {
  repo = freshRepo("lint-hist-cibase-");
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("lint-historical-docs --base CI 模式（F20261009hcig，#1281）", () => {
  it("核心红：无关 commit 塞 .doc-fix + 独立 commit 改历史文档 → 必拦（逐 commit 配对语义）", () => {
    // 攻击形态：range 内存在 .doc-fix（若按 range 聚合放行即绕过），但声明与历史文档变更不同 commit
    commitFiles(repo, [["README.md", "# repo (touched)\n"]], "unrelated change");
    commitFiles(repo, [[".doc-fix", "与本次改动无关的订正声明文本，仅用于探测配对语义\n"]], "plant declaration");
    commitFiles(
      repo,
      [[OLD_DOC, OLD_DOC_CONTENT.replace("正文内容。", "正文被篡改了。")]],
      "tamper historical doc (no paired declaration)"
    );
    const r = runLint(repo, ["--base", "origin/main"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(OLD_DOC);
    expect(r.stderr).toMatch(/同一个 commit/); // 错误信息指向配对语义
  });

  it("核心绿：.doc-fix 与 frontmatter 订正在同一 commit → 放行", () => {
    // 新仓库避免上一用例的违规历史污染（--base 扫描整个 range）
    const r2 = freshRepo("lint-hist-cibase-ok-");
    commitFiles(
      r2,
      [
        [OLD_DOC, OLD_DOC_CONTENT.replace("title: 旧特性", "title: 旧特性（订正）")],
        [".doc-fix", "订正 frontmatter title 字段（#1281 用例）\n"],
      ],
      "metadata fix with paired declaration"
    );
    const r = runLint(r2, ["--base", "origin/main"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/变更均在 frontmatter 块内/);
    fs.rmSync(r2, { recursive: true, force: true });
  });

  it("核心红变体：同 commit 声明但正文篡改 → 拒（fm 边界校验在 commit 树上工作）", () => {
    const r2 = freshRepo("lint-hist-cibase-body-");
    commitFiles(
      r2,
      [
        [OLD_DOC, OLD_DOC_CONTENT.replace("正文内容。", "正文被重写。")],
        [".doc-fix", "这是一条与实际改动毫无关系的订正理由文本\n"],
      ],
      "body tamper with fake declaration"
    );
    const r = runLint(r2, ["--base", "origin/main"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/超出 frontmatter 块/);
    fs.rmSync(r2, { recursive: true, force: true });
  });

  it("分支新建文档的后续修改 → 放行（isAddedOnBranch 在 range 内自洽，log 上界=父）", () => {
    const r2 = freshRepo("lint-hist-cibase-new-");
    commitFiles(r2, [[NEW_DOC, "# new v1\n"]], "add new doc");
    commitFiles(r2, [[NEW_DOC, "# new v2\n"]], "edit own doc");
    const r = runLint(r2, ["--base", "origin/main"]);
    expect(r.status).toBe(0);
    fs.rmSync(r2, { recursive: true, force: true });
  });

  it("历史文档修改 + 同 commit 配对声明 + 后续 commit 删 .doc-fix → 全 range 放行", () => {
    const r2 = freshRepo("lint-hist-cibase-del-");
    commitFiles(
      r2,
      [
        [OLD_DOC, OLD_DOC_CONTENT.replace("title: 旧特性", "title: 旧特性（订正）")],
        [".doc-fix", "订正 frontmatter title 字段（删除路径用例）\n"],
      ],
      "metadata fix"
    );
    git(r2, ["rm", "-q", ".doc-fix"]);
    git(r2, ["commit", "-q", "-m", "remove one-shot declaration"]);
    const r = runLint(r2, ["--base", "origin/main"]);
    expect(r.status).toBe(0);
    fs.rmSync(r2, { recursive: true, force: true });
  });

  it("base ref 不可解析 → 宽松放行 exit 0（fork PR 场景不误伤）", () => {
    const r = runLint(repo, ["--base", "origin/nonexistent-ref"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/无法解析/);
    expect(r.stderr).toMatch(/宽松放行/);
  });

  it("--base 缺参数 → exit 2（调用错误立即红，不静默）", () => {
    const r = runLint(repo, ["--base"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--base 需要一个 ref 参数/);
  });

  it("正常 merge commit（first-parent diff 无 docs 变更）→ 放行", () => {
    const r2 = freshRepo("lint-hist-cibase-merge-");
    git(r2, ["checkout", "-q", "-b", "side"]);
    commitFiles(r2, [["README.md", "# repo (side)\n"]], "side change");
    git(r2, ["checkout", "-q", "feature/x"]);
    commitFiles(r2, [[NEW_DOC, "# new doc\n"]], "feature change");
    git(r2, ["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    const r = runLint(r2, ["--base", "origin/main"]);
    expect(r.status).toBe(0);
    fs.rmSync(r2, { recursive: true, force: true });
  });

  it("merge commit 携带 docs 变更（含 evil merge 塞内容）→ 跳过不拦截（实测修正：误报面优先）", () => {
    // 实测发现：本仓 up-to-date gate 强制 PR rebase/merge main，而 main 的 squash 合入会把
    // .doc-fix 创建/删除对消（#1375 两 R099 实证）——「PR merge main」时 merge commit 的
    // first-parent diff 会把 main 来的变更记入本 PR，若检查则必红。故 merge commit 跳过；
    // 本用例锁定该行为（含 evil merge 形态，取舍见特性文档）。
    const r2 = freshRepo("lint-hist-cibase-evil-");
    git(r2, ["checkout", "-q", "-b", "side"]);
    commitFiles(r2, [["README.md", "# repo (side)\n"]], "side change");
    git(r2, ["checkout", "-q", "feature/x"]);
    commitFiles(r2, [[NEW_DOC, "# new doc\n"]], "feature change");
    // --no-commit 合并后手工篡改历史文档，作为 merge commit 内容提交（evil merge 形态）
    git(r2, ["merge", "--no-commit", "--no-ff", "side"]);
    fs.writeFileSync(path.join(r2, OLD_DOC), OLD_DOC_CONTENT.replace("正文内容。", "evil merge 里塞的篡改。"));
    git(r2, ["add", "--", OLD_DOC]);
    git(r2, ["commit", "-q", "-m", "evil merge with tampered doc"]);
    const r = runLint(r2, ["--base", "origin/main"]);
    // 跳过：非 merge commit 逐个全量校验，merge commit 不进判定（取舍见特性文档）
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/跳过 merge commit/);
    fs.rmSync(r2, { recursive: true, force: true });
  });

  it("range 内首个 commit 新增文档、后续 commit 改它 → 放行（逐 commit 粒度而非 range 聚合的佐证）", () => {
    const r2 = freshRepo("lint-hist-cibase-grain-");
    commitFiles(r2, [[NEW_DOC, "# v1\n"]], "add");
    commitFiles(r2, [[NEW_DOC, "# v2\n"]], "edit");
    commitFiles(r2, [[NEW_DOC, "# v3\n"]], "edit again");
    const r = runLint(r2, ["--base", "origin/main"]);
    expect(r.status).toBe(0);
    fs.rmSync(r2, { recursive: true, force: true });
  });
});
