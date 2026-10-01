/**
 * F20260930lrbk（#1257）：R 形态 rename 的 .doc-fix 通道行为锁定。
 *
 * 与 tests/lint-historical-docs.test.ts（F20260831dgim 主套件）分离成独立文件：
 * 主套件的 describe 体已接近 eslint max-lines-per-function（220）上限，且其既有用例
 * 会故意遗留 OLD_DOC 的磁盘态 rename（跨用例共享一个 repo），本文件用独立迷你 fixture
 * 隔离，互不干扰。
 *
 * 背景：git mv 产生的 R 配对此前被双重误拦（isAddedOnBranch 按 oldPath 判历史 +
 * checkFrontmatterScope 单路径 diff 把 rename 展开成全文新增）——纯 rename
 * （similarity 100%）本质是文件名级元数据订正。修复后：R100 + .doc-fix 放行；
 * 无声明拦截；rename+frontmatter 编辑按两侧边界校验放行；rename+正文编辑仍拦。
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

function stageOnly(cwd: string, file: string) {
  git(cwd, ["reset", "-q", "--", "."]);
  git(cwd, ["add", "--", file]);
}

function runLint(cwd: string) {
  // 放行文案走 stderr（console.warn），spawnSync 同时取两路
  const r = spawnSync("node", [LINT], { cwd, encoding: "utf8", env: { ...process.env } });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

/** 拦截型用例专用：lint exit 非 0 时 execFileSync 抛错，取 stderr 判文案 */
function runLintExpectFail(cwd: string): string {
  try {
    execFileSync("node", [LINT], { cwd, encoding: "utf8", env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return String((e as { stderr?: Buffer }).stderr ?? "");
  }
  return "";
}

const OLD_DOC = "docs/features/2026/01/01/F20260101old-old-feature.md";
const OLD_DOC_CONTENT = `---\nid: F20260101old\ntitle: 旧特性\nchange_type: feature\n---\n\n# 旧特性\n\n正文内容。\n`;

let repo: string;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "lint-hist-rename-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@test"]);
  git(repo, ["config", "user.name", "test"]);
  fs.mkdirSync(path.join(repo, "docs/features/2026/01/01"), { recursive: true });
  fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT);
  fs.writeFileSync(path.join(repo, "README.md"), "# repo\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "main: historical doc"]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["update-ref", "refs/remotes/origin/main", head]);
  git(repo, ["checkout", "-q", "-b", "feature/x"]);
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("lint-historical-docs rename 通道（#1257，F20260930lrbk）", () => {
  it("R100 纯 rename + .doc-fix → 放行（修复前被双重误拦，#1257 的通道）", () => {
    const renamed = "docs/features/2026/01/01/F20260101old-pure-rename.md";
    git(repo, ["mv", OLD_DOC, renamed]); // 纯 git mv，R100，内容零变化
    fs.writeFileSync(path.join(repo, ".doc-fix"), "文件名补 slug 后缀订正（文件名级元数据）\n");
    stageOnly(repo, renamed);
    git(repo, ["add", "--", OLD_DOC, ".doc-fix"]);
    const status = git(repo, ["diff", "--cached", "--name-status"]);
    expect(status).toMatch(new RegExp(`^R100\\t${OLD_DOC}\\t${renamed}$`, "m"));
    const r = runLint(repo);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/变更均在 frontmatter 块内/);
    // 收尾：恢复旧路径 + 删残留
    git(repo, ["reset", "-q", "--", "."]);
    git(repo, ["checkout", "--", OLD_DOC]);
    fs.rmSync(path.join(repo, renamed), { force: true });
    fs.rmSync(path.join(repo, ".doc-fix"), { force: true });
  });

  it("纯 rename 但无 .doc-fix → 拦截（声明对 rename 通道同样强制）", () => {
    const renamed = "docs/features/2026/01/01/F20260101old-nofix.md";
    git(repo, ["mv", OLD_DOC, renamed]);
    stageOnly(repo, renamed);
    git(repo, ["add", "--", OLD_DOC]);
    const err = runLintExpectFail(repo);
    expect(err).toMatch(/历史特性\/研究文档/);
    git(repo, ["reset", "-q", "--", "."]);
    git(repo, ["checkout", "--", OLD_DOC]);
    fs.rmSync(path.join(repo, renamed), { force: true });
  });

  it("rename + frontmatter 内编辑 → 放行（old/new 两侧边界校验）", () => {
    const renamed = "docs/features/2026/01/01/F20260101old-rename-edit.md";
    git(repo, ["mv", OLD_DOC, renamed]);
    fs.writeFileSync(
      path.join(repo, renamed),
      OLD_DOC_CONTENT.replace("title: 旧特性", "title: 旧特性（订正）")
    );
    fs.writeFileSync(path.join(repo, ".doc-fix"), "rename 同时订正 frontmatter title 字段\n");
    stageOnly(repo, ".");
    const r = runLint(repo);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/变更均在 frontmatter 块内/);
    git(repo, ["reset", "-q", "--", "."]);
    git(repo, ["checkout", "--", OLD_DOC]);
    fs.rmSync(path.join(repo, renamed), { force: true });
    fs.rmSync(path.join(repo, ".doc-fix"), { force: true });
  });

  it("rename + 正文编辑 → 拒绝（rename 通道不豁免正文边界）", () => {
    const renamed = "docs/features/2026/01/01/F20260101old-rename-body.md";
    git(repo, ["mv", OLD_DOC, renamed]);
    fs.writeFileSync(path.join(repo, renamed), OLD_DOC_CONTENT.replace("正文内容。", "正文被重写了。"));
    fs.writeFileSync(path.join(repo, ".doc-fix"), "rename 声明理由文本（但正文被改了）\n");
    stageOnly(repo, ".");
    const err = runLintExpectFail(repo);
    expect(err).toMatch(/超出 frontmatter 块/);
    git(repo, ["reset", "-q", "--", "."]);
    git(repo, ["checkout", "--", OLD_DOC]);
    fs.rmSync(path.join(repo, renamed), { force: true });
    fs.rmSync(path.join(repo, ".doc-fix"), { force: true });
  });
});
