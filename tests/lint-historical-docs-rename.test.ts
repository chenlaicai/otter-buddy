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

  it("#1273 严重 1：rename + 轻度编辑 + NUL 字节（R 配对 + Binary 零 hunk）→ 拒绝（零 hunk ≠ 内容零变化）", () => {
    const renamed = "docs/features/2026/01/01/F20260101old-binary-bypass.md";
    git(repo, ["mv", OLD_DOC, renamed]);
    // 轻度编辑（相似度>R50%，rename 检测存活）+ NUL 字节 → git diff 呈 R097 + "Binary files differ"（零 hunk）
    // （重写太狠会跌入 A+D，走的是另一条拦截面，锁不住本修复）
    const body = OLD_DOC_CONTENT.replace("正文内容。", "正文被替换。\n混入 NUL：\0");
    fs.writeFileSync(path.join(repo, renamed), body);
    fs.writeFileSync(path.join(repo, ".doc-fix"), "声明文本（但正文被改且含 NUL）\n");
    stageOnly(repo, ".");
    const status = git(repo, ["diff", "--cached", "--name-status"]);
    expect(status).toMatch(new RegExp(`^R\\d{2,3}\\t${OLD_DOC}\\t${renamed}$`, "m")); // R 配对存活
    const err = runLintExpectFail(repo);
    expect(err).toMatch(/超出 frontmatter 块|历史特性\/研究文档/);
    git(repo, ["reset", "-q", "--", "."]);
    git(repo, ["checkout", "--", OLD_DOC]);
    fs.rmSync(path.join(repo, renamed), { force: true });
    fs.rmSync(path.join(repo, ".doc-fix"), { force: true });
  });

  it("#1273 严重 2 跨树 A+D 两步链：移出→重写→移回 → 拒绝（oldPath 也入管辖）", () => {
    // 步骤 1：mv 出树（staged）→ lint 拒（含声明也拒：旧路径在树内，移出后 newFmLastLine 读不到树外路径的索引？不，读得到）
    const outside = "tmp-escaped2/F20260101old-out.md";
    fs.mkdirSync(path.join(repo, "tmp-escaped2"), { recursive: true });
    git(repo, ["mv", OLD_DOC, outside]);
    // 步骤 2：在树外彻底重写 + mv 回新 slug 名（相似度<50% 退化 A+D：旧路径 D 在树内、新路径 A 在树内）
    const rewritten = "!!! Totally rewritten content !!!\n".repeat(30);
    fs.writeFileSync(path.join(repo, outside), rewritten);
    git(repo, ["add", "--", outside]);
    const back = "docs/features/2026/01/01/F20260101old-rewritten-back.md";
    fs.mkdirSync(path.join(repo, "docs/features/2026/01/01"), { recursive: true });
    fs.writeFileSync(path.join(repo, back), rewritten);
    fs.rmSync(path.join(repo, outside), { force: true });
    stageOnly(repo, "."); // git add . 含删除（OLD_DOC 已被 mv 掉，不在磁盘，不能显式 add）
    // 两步链收口后 staged 形态断言：无论 git 呈 R 配对还是 A+D，rewritten-back 必在 staged
    const status = git(repo, ["diff", "--cached", "--name-status"]);
    expect(status).toMatch(/rewritten-back/);
    // 两步链完成后 staged 形态：old → back 的 R 配对（相似度低）或 A+D——无论哪种形态都要拦
    const err = runLintExpectFail(repo);
    expect(err).toMatch(/历史特性\/研究文档|超出 frontmatter 块/);
    git(repo, ["reset", "-q", "--", "."]);
    git(repo, ["checkout", "--", OLD_DOC]);
    fs.rmSync(path.join(repo, "tmp-escaped2"), { recursive: true, force: true });
    fs.rmSync(path.join(repo, back), { force: true });
  });

  it("#1273 delta 严重 1（probeD 形态）：树内→树外纯 rename + .doc-fix → 拒绝（移出语义=删除历史文档）", () => {
    // 第一轮修复只拒了 oldPath 在树外（回迁方向），漏了移出方向——probeD 实测 exit=0
    const outside = "tmp-escaped3/F20260101old-moved-out.md";
    fs.mkdirSync(path.join(repo, "tmp-escaped3"), { recursive: true });
    git(repo, ["mv", OLD_DOC, outside]); // 纯 git mv，R100，内容零变化，但 newPath 在树外
    fs.writeFileSync(path.join(repo, ".doc-fix"), "把文档移到仓库根目录方便查阅（移出语义=删除）\n");
    stageOnly(repo, ".");
    const err = runLintExpectFail(repo);
    expect(err).toMatch(/历史特性\/研究文档|超出 frontmatter 块/);
    git(repo, ["reset", "-q", "--", "."]);
    git(repo, ["checkout", "--", OLD_DOC]);
    fs.rmSync(path.join(repo, "tmp-escaped3"), { recursive: true, force: true });
    fs.rmSync(path.join(repo, ".doc-fix"), { force: true });
  });

  it("#1273 delta 严重 2（probeC 真两 commit 形态）：移出 commit 后重写+移回+删残留 → 拒绝（D 树外渊源入册）", () => {
    // 与上一用例的本质区别：step1 先真实 commit（不在同一次 staging 里）——
    // 此形态下 step2 的 staged 区只剩 A（树内回迁）+ D（树外残留删除），第一轮过滤两侧均不命中
    const outside = "tmp-escaped4/F20260101old-out.md";
    fs.mkdirSync(path.join(repo, "tmp-escaped4"), { recursive: true });
    git(repo, ["mv", OLD_DOC, outside]);
    stageOnly(repo, ".");
    git(repo, ["commit", "-q", "-m", "step1: move out (attack setup)"]); // step1 落为真 commit
    // step2：树外彻底重写 → 移回树内新 slug 名 → 删除树外残留
    const rewritten = "!!! totally rewritten body !!!\n".repeat(20);
    const back = "docs/features/2026/01/01/F20260101old-back.md";
    fs.writeFileSync(path.join(repo, outside), rewritten);
    fs.writeFileSync(path.join(repo, back), rewritten);
    fs.rmSync(path.join(repo, outside), { force: true });
    stageOnly(repo, ".");
    const status = git(repo, ["diff", "--cached", "--name-status"]);
    expect(status).toMatch(new RegExp(`^A\\t${back}$`, "m")); // A 形态（rename 检测跨 commit 不存）
    const err = runLintExpectFail(repo);
    // 回迁 A 判历史（HEAD 无此路径但渊源为历史文档——D 侧渊源入册后整体拦截）
    expect(err).toMatch(/历史特性\/研究文档|超出 frontmatter 块/);
    // 收尾：step1 已 commit（OLD_DOC 在其中被 mv 掉），直接 hard reset 回基线
    git(repo, ["reset", "-q", "--hard"]);
    git(repo, ["reset", "-q", "--hard", "HEAD~1"]);
    fs.rmSync(path.join(repo, "tmp-escaped4"), { recursive: true, force: true });
    fs.rmSync(path.join(repo, back), { force: true });
  });
});
