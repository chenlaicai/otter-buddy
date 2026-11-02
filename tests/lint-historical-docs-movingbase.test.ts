/**
 * #1300：moving-base 豁免误判修复——「分支内新建」豁免双条件行为锁定。
 *
 * 豁免判据（修复后）：① 窗口 ref..HEAD 内有 Add 记录（既有判据）且 ② 路径不在 base ref 树上
 * （cat-file 一票否决）——条件 2 封死「文档已在 main 存在却靠窗口内 Add 记录被放行」的全部形态。
 *
 * 场景来源（#1290 实证）：分支重建/cherry-pick 场景下窗口可能混入 main 侧 squash 合入的
 * A 形态记录、或攻击者删了重加的自造 Add——原判据只看窗口 Add，从不回答「是否已在 main」。
 *
 * 与既有套件分工：主套件（基础拦截/放行与 .doc-fix 开口）、rename 套件（R 形态）、final 套件
 * （位移守恒）、linkfix 套件（链接订正）、cibase 套件（--base 逐 commit 配对语义）各锁各面，
 * 本套件聚焦 moving-base 与自造 Add 场景，不重复覆盖。
 *
 * 已声明的残余缺口（不在本套件锁定，见特性文档 F20261102mvbs）：本地 origin/main 引用完全
 * 过期（如仅 `git fetch origin main` 更新 FETCH_HEAD）时，main 侧 squash 与分支 commit 在本地
 * 视图信息论上不可区分，pre-commit 不伪造判据——兜底为 CI --base 模式（t5 锁定）+ fetch 纪律。
 */
import { describe, it, expect, vi } from "vitest";
// F20261021ttos：临时 git 仓库结构性重活，文件级宽窗（判据见 testing-rules「重成本用例超时策略」）
vi.setConfig({ testTimeout: 20_000 });
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const LINT = fileURLToPath(new URL("../scripts/lint-historical-docs.mjs", import.meta.url));

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** 运行 lint（pre-commit 语义，无参；CI 语义传 --base），失败不抛错 */
function runLint(cwd: string, args: string[] = []) {
  const r = spawnSync(process.execPath, [LINT, ...args], { cwd, encoding: "utf8", env: { ...process.env } });
  return { stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim(), status: r.status ?? -1 };
}

function stageOnly(cwd: string, file: string) {
  git(cwd, ["reset", "-q", "--", "."]);
  git(cwd, ["add", "--", file]);
}

const OLD_DOC = "docs/features/2026/01/01/F20260101old-old-feature.md";
const NEW_DOC = "docs/features/2026/09/22/F20260922new-new-feature.md";
const OLD_DOC_CONTENT = `---\nid: F20260101old\ntitle: 旧特性\nchange_type: feature\n---\n\n# 旧特性\n\n正文内容。\n`;
const NEW_DOC_V1 = `---\nid: F20260922new\ntitle: 新特性草稿\nchange_type: feature\n---\n\n# 新特性\n\n草稿 v1。\n`;

/** 造基线仓库：main 有历史文档 OLD_DOC，origin/main=main HEAD，当前在 feature/x */
function freshRepo() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "lint-hist-mvbs-"));
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

describe("lint-historical-docs #1300: moving-base 豁免双条件", () => {
  it("攻击者自造 Add（删历史文档重加同路径）后再改正文 → 拦截（cat-file 一票否决直封）", () => {
    const r = freshRepo();
    // step1：分支内删掉历史文档再原样重加——给 OLD_DOC 造出窗口内 Add 记录
    git(r, ["rm", "-q", OLD_DOC]);
    git(r, ["commit", "-q", "-m", "evict: rm historical doc"]);
    fs.mkdirSync(path.join(r, "docs/features/2026/01/01"), { recursive: true });
    fs.writeFileSync(path.join(r, OLD_DOC), OLD_DOC_CONTENT);
    git(r, ["add", "."]);
    git(r, ["commit", "-q", "-m", "re-add: forge Add record"]);
    // 窗口内有 Add（自造），但路径在 origin/main 树上存在 → 一票否决，不豁免
    fs.writeFileSync(path.join(r, OLD_DOC), OLD_DOC_CONTENT.replace("正文内容。", "正文内容（篡改）。"));
    stageOnly(r, OLD_DOC);
    const out = runLint(r);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain(OLD_DOC);
    fs.rmSync(r, { recursive: true, force: true });
  });

  it("#1290 复刻（origin/main 新鲜）：基于新 main 重建分支修改已合入文档正文 → 拦截", () => {
    const r = freshRepo();
    // feature/x 提交新文档（分支侧 Add）
    fs.mkdirSync(path.join(r, "docs/features/2026/09/22"), { recursive: true });
    fs.writeFileSync(path.join(r, NEW_DOC), NEW_DOC_V1);
    git(r, ["add", "."]);
    git(r, ["commit", "-q", "-m", "feat: new doc (draft)"]);
    // 模拟 squash 合入 main（main 侧对 NEW_DOC 呈 A 形态）并 fetch（origin/main 前移）
    git(r, ["checkout", "-q", "main"]);
    fs.mkdirSync(path.dirname(path.join(r, NEW_DOC)), { recursive: true });
    fs.writeFileSync(path.join(r, NEW_DOC), NEW_DOC_V1);
    git(r, ["add", "."]);
    git(r, ["commit", "-q", "-m", "main: squash merge feature (#N)"]);
    const mainHead = git(r, ["rev-parse", "HEAD"]);
    git(r, ["update-ref", "refs/remotes/origin/main", mainHead]); // fetch 后引用新鲜
    // 基于新 main 重建分支，cherry-pick 场景 = 直接在重建分支上修改正文
    git(r, ["checkout", "-q", "-b", "rebuild/main-side"]);
    fs.writeFileSync(path.join(r, NEW_DOC), NEW_DOC_V1.replace("草稿 v1。", "草稿 v1（正文修改）。"));
    stageOnly(r, NEW_DOC);
    const out = runLint(r);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain(NEW_DOC);
    fs.rmSync(r, { recursive: true, force: true });
  });

  it("分支内新建文档提交后再修改（正常迭代载体）→ 放行（一票否决不误伤）", () => {
    const r = freshRepo();
    fs.mkdirSync(path.join(r, "docs/features/2026/09/22"), { recursive: true });
    fs.writeFileSync(path.join(r, NEW_DOC), NEW_DOC_V1);
    git(r, ["add", "."]);
    git(r, ["commit", "-q", "-m", "feat: new doc (draft)"]);
    // 路径不在 origin/main 树上 → 否决不触发，窗口 Add 命中分支侧 commit → 豁免
    fs.writeFileSync(path.join(r, NEW_DOC), NEW_DOC_V1.replace("草稿 v1。", "草稿 v2 迭代。"));
    stageOnly(r, NEW_DOC);
    const out = runLint(r);
    expect(out.status).toBe(0);
    fs.rmSync(r, { recursive: true, force: true });
  });

  it("历史文档正文修改（基础形态，无 .doc-fix）→ 拦截（issue 验证探针 1 回归）", () => {
    const r = freshRepo();
    fs.writeFileSync(path.join(r, OLD_DOC), OLD_DOC_CONTENT.replace("正文内容。", "正文内容（篡改）。"));
    stageOnly(r, OLD_DOC);
    const out = runLint(r);
    expect(out.status).toBe(1);
    fs.rmSync(r, { recursive: true, force: true });
  });

  it("CI --base 模式（ref 新鲜）逐 commit 重放 #1290 场景 → 正文修改 commit 拦截（pre-commit 残余缺口的兜底）", () => {
    const r = freshRepo();
    // 复刻事故链：feature 新文档 → main squash → 本地 origin/main 停留过期位（模拟仅更新 FETCH_HEAD）
    fs.mkdirSync(path.join(r, "docs/features/2026/09/22"), { recursive: true });
    fs.writeFileSync(path.join(r, NEW_DOC), NEW_DOC_V1);
    git(r, ["add", "."]);
    git(r, ["commit", "-q", "-m", "feat: new doc (draft)"]);
    git(r, ["checkout", "-q", "main"]);
    fs.mkdirSync(path.dirname(path.join(r, NEW_DOC)), { recursive: true });
    fs.writeFileSync(path.join(r, NEW_DOC), NEW_DOC_V1);
    git(r, ["add", "."]);
    git(r, ["commit", "-q", "-m", "main: squash merge feature (#N)"]);
    const mainHead = git(r, ["rev-parse", "HEAD"]);
    // 本地 origin/main 保持过期（指向 main 侧 squash 之前）——pre-commit 视角的盲区现场
    git(r, ["checkout", "-q", "-b", "rebuild/stale-local", mainHead]);
    fs.writeFileSync(path.join(r, NEW_DOC), NEW_DOC_V1.replace("草稿 v1。", "草稿 v1（正文修改）。"));
    git(r, ["add", "."]);
    git(r, ["commit", "-q", "-m", "rebuild: body edit without .doc-fix"]);
    // CI 模式 base ref 为推送时的新鲜 origin/main（模拟服务端视角）
    git(r, ["update-ref", "refs/remotes/origin/main", mainHead]);
    const out = runLint(r, ["--base", "origin/main"]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain(NEW_DOC);
    fs.rmSync(r, { recursive: true, force: true });
  });
});
