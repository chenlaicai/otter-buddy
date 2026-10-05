/**
 * F20261001lrbk（#1273）终审检视处置锁定：quotePath 转义盲区 + 闭合标记位移守恒。
 *
 * 与 lint-historical-docs-rename.test.ts 分离：主 describe 体近 eslint
 * max-lines-per-function（220）上限，增量用例独立成文件（同 rename 通道文件先例）。
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

function stageOnly(cwd: string, file: string) {
  git(cwd, ["reset", "-q", "--", "."]);
  git(cwd, ["add", "--", file]);
}

function runLint(cwd: string) {
  const r = spawnSync("node", [LINT], { cwd, encoding: "utf8", env: { ...process.env } });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

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
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "lint-hist-final-"));
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

describe("lint-historical-docs 终审处置锁定（F20261001lrbk，#1273）", () => {
  it("终审严重 1：CJK 文件名历史文档正文篡改 → 拒绝（quotePath 转义盲区封口）", () => {
    // 默认 core.quotePath=true 时 --name-status 输出 \3xx 转义形态，^docs\/ 过滤恒 miss，
    // CJK 文件名历史文档整类逃出门禁（实测同 staged 改 CJK 文档 exit=0 零输出）。
    // fixture 时序：CJK 文档的 Add commit 留在分支上（不能 reset 掉，否则文件不在 base/磁盘），
    // 但 origin/main 指到 Add 前一个 commit——门禁视角它就是「历史文档」（不在分支 Add 记录里）
    git(repo, ["reset", "-q", "--", "."]);
    git(repo, ["checkout", "--", OLD_DOC]);
    const cjkDoc = "docs/features/2026/01/01/F20260101守.md";
    fs.writeFileSync(
      path.join(repo, cjkDoc),
      "---\nid: F20260101shou\n---\n\n# 标题\n\n正文内容。\n"
    );
    git(repo, ["add", "--", cjkDoc]);
    git(repo, ["commit", "-q", "-m", "add cjk doc (fixture in base)"]);
    // origin/main 含 CJK fixture commit → 对门禁而言它是「base 上已有的历史文档」
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    // 攻击：改正文（无声明）→ 必须拦
    fs.writeFileSync(
      path.join(repo, cjkDoc),
      "---\nid: F20260101shou\n---\n\n# 标题\n\n正文被篡改。\n"
    );
    stageOnly(repo, ".");
    let err = runLintExpectFail(repo);
    expect(err).toMatch(/历史特性\/研究文档/);
    // 带声明也拦（边界校验对转义后路径生效，正文仍在界外）
    fs.writeFileSync(path.join(repo, ".doc-fix"), "声明文本足够长xxxxxxxxxxxx\n");
    stageOnly(repo, ".");
    err = runLintExpectFail(repo);
    expect(err).toMatch(/超出 frontmatter 块|历史特性\/研究文档/);
    // 收尾：origin/main 回到正确基线（撤 fixture commit 后指向新 HEAD）
    git(repo, ["reset", "-q", "--hard"]);
    git(repo, ["reset", "-q", "--hard", "HEAD~1"]); // 撤 fixture commit
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    fs.rmSync(path.join(repo, ".doc-fix"), { force: true });
    git(repo, ["checkout", "--", OLD_DOC]);
  });

  it("终审严重 2：闭合标记位移攻击（删原 --- + H1 后插新 ---）→ 拒绝（位移守恒校验）", () => {
    git(repo, ["reset", "-q", "--", "."]);
    git(repo, ["checkout", "--", OLD_DOC]);
    // step1：删原闭合（old 行 3）+ 在 H1 后插新闭合（new 行 5）——H1 被吞进 fm
    fs.writeFileSync(
      path.join(repo, OLD_DOC),
      OLD_DOC_CONTENT.replace("---\n\n# 旧特性\n\n正文内容。", "\n\n# 旧特性\n---\n\n正文内容。")
    );
    fs.writeFileSync(path.join(repo, ".doc-fix"), "声明文本足够长xxxxxxxxxxxx\n");
    stageOnly(repo, ".");
    const err = runLintExpectFail(repo);
    expect(err).toMatch(/超出 frontmatter 块|历史特性\/研究文档/);
    // 收尾
    git(repo, ["reset", "-q", "--hard"]);
    git(repo, ["checkout", "--", OLD_DOC]);
    fs.rmSync(path.join(repo, ".doc-fix"), { force: true });
  });

  it("终审严重 2 防误伤：合法 fm 内增删行（位移守恒）→ 放行", () => {
    git(repo, ["reset", "-q", "--", "."]);
    git(repo, ["checkout", "--", OLD_DOC]);
    // fm 内删 1 行 + 插 2 行：fmDelta = +1，位移 4→5 可解释 → 必须放行
    fs.writeFileSync(
      path.join(repo, OLD_DOC),
      OLD_DOC_CONTENT
        .replace("change_type: feature\n", "")
        .replace("id: F20260101old", "id: F20260101old\nstatus: active\nsummary: s")
    );
    fs.writeFileSync(path.join(repo, ".doc-fix"), "声明文本足够长xxxxxxxxxxxx\n");
    stageOnly(repo, ".");
    const r = runLint(repo);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/变更均在 frontmatter 块内/);
    git(repo, ["reset", "-q", "--", "."]);
    git(repo, ["checkout", "--", OLD_DOC]);
    fs.rmSync(path.join(repo, ".doc-fix"), { force: true });
  });

  it("delta-5：fm 含空行的位移攻击（删空行抵账吞 H1）→ 拒绝（fmDelta 含空行记账）", () => {
    // E1 场景：fm 含 2 空行，攻击 = 删 2 空行（fm 内，抵账）+ 删原闭合 + H1 后插新闭合
    // 初版 fmDelta 只记非空行 → 删空行不记账 → 守恒等式假通过 → exit=0，H1 被吞
    git(repo, ["reset", "-q", "--", "."]);
    git(repo, ["checkout", "--", OLD_DOC]);
    const blankFm =
      "---\nid: F20260101old\ntitle: 旧特性\n\nchange_type: feature\n\n---\n\n# 旧特性\n\n正文内容。\n";
    git(repo, ["add", "--", OLD_DOC]);
    fs.writeFileSync(path.join(repo, OLD_DOC), blankFm);
    stageOnly(repo, OLD_DOC);
    git(repo, ["commit", "-q", "-m", "fm with blank lines (fixture in base)"]);
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]); // fixture 进 base
    // 攻击 staged：删 2 空行 + 删原闭合 + H1 后插新闭合
    fs.writeFileSync(
      path.join(repo, OLD_DOC),
      "---\nid: F20260101old\ntitle: 旧特性\nchange_type: feature\n\n# 旧特性\n---\n\n正文内容。\n"
    );
    fs.writeFileSync(path.join(repo, ".doc-fix"), "声明文本足够长xxxxxxxxxxxx\n");
    stageOnly(repo, ".");
    const err = runLintExpectFail(repo);
    expect(err).toMatch(/超出 frontmatter 块|历史特性\/研究文档/);
    // 收尾
    git(repo, ["reset", "-q", "--hard"]);
    git(repo, ["reset", "-q", "--hard", "HEAD~1"]);
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    fs.rmSync(path.join(repo, ".doc-fix"), { force: true });
    git(repo, ["checkout", "--", OLD_DOC]);
  });

  it("delta-5 防误伤锁：仅删 fm 内空行（合法订正）→ 放行（F 型空行误伤回归锁）", () => {
    // 终审检视备注 2：空行记账补丁前「仅删 fm 空行」被误拦且文案失实；补丁后放行，
    // 此用例防未来记账逻辑改动回退
    git(repo, ["reset", "-q", "--", "."]);
    git(repo, ["checkout", "--", OLD_DOC]);
    const withBlank =
      "---\nid: F20260101old\n\ntitle: 旧特性\nchange_type: feature\n---\n\n# 旧特性\n\n正文内容。\n";
    fs.writeFileSync(path.join(repo, OLD_DOC), withBlank);
    stageOnly(repo, OLD_DOC);
    git(repo, ["commit", "-q", "-m", "fm with blank line (fixture in base)"]);
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    // 合法订正：仅删 fm 内空行
    fs.writeFileSync(
      path.join(repo, OLD_DOC),
      "---\nid: F20260101old\ntitle: 旧特性\nchange_type: feature\n---\n\n# 旧特性\n\n正文内容。\n"
    );
    fs.writeFileSync(path.join(repo, ".doc-fix"), "删除 frontmatter 内空行（格式订正）\n");
    stageOnly(repo, ".");
    const r = runLint(repo);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/变更均在 frontmatter 块内/);
    // 收尾
    git(repo, ["reset", "-q", "--hard"]);
    git(repo, ["reset", "-q", "--hard", "HEAD~1"]);
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    fs.rmSync(path.join(repo, ".doc-fix"), { force: true });
    git(repo, ["checkout", "--", OLD_DOC]);
  });
});
