/**
 * F20260831dgim: 历史特性文档不可变——lint 脚本行为锁定。
 *
 * 在临时 git 仓库中模拟场景（每个用例先 reset 干净 staged 区，避免跨用例污染）：
 * 1. 历史文档（基准分支已合入）被修改 → 违规
 * 2. 本分支新建的文档被修改 → 通过（迭代载体）
 * 3. 非 docs/features|research 路径的修改 → 不在管辖范围
 * 4. staged .doc-fix 声明文件（理由≥10字符）→ 放行（F20260922dfch 显式开口）
 * 5. .doc-fix 理由不足 / 未 staged → 拦截（声明必须进索引区才生效）
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../scripts/lint-historical-docs.mjs", import.meta.url));

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** 运行 lint 脚本，失败不抛错，返回 {status, stdout, stderr}（spawnSync 两流都可拿） */
function runLint(cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    status: r.status ?? -1,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
}

/** 清空 staged 区再 stage 目标文件，保证用例间隔离 */
function stageOnly(cwd: string, file: string) {
  git(cwd, ["reset", "-q", "--", "."]);
  git(cwd, ["add", "--", file]);
}

let repo: string;
const OLD_DOC = "docs/features/2026/01/01/F20260101old-old-feature.md";
const NEW_DOC = "docs/features/2026/08/31/F20260831new-new-feature.md";
/** 历史文档的 frontmatter 完整形态（真实文档结构：--- 块 + 正文） */
const OLD_DOC_CONTENT = `---\nid: F20260101old\ntitle: 旧特性\nchange_type: feature\n---\n\n# 旧特性\n\n正文内容。\n`;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "lint-hist-doc-"));
  // 基准：main 分支上合入一个历史特性文档
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@test"]);
  git(repo, ["config", "user.name", "test"]);
  fs.mkdirSync(path.join(repo, "docs/features/2026/01/01"), { recursive: true });
  fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT);
  fs.writeFileSync(path.join(repo, "README.md"), "# repo\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "main: historical doc"]);

  // 伪造 origin/main 引用指向当前 commit（脚本以 origin/main..HEAD 判定本分支独有提交）
  const head = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["update-ref", "refs/remotes/origin/main", head]);

  // 本分支新建一个文档（作为迭代载体，可修改）
  git(repo, ["checkout", "-b", "feature/x"]);
  fs.mkdirSync(path.join(repo, "docs/features/2026/08/31"), { recursive: true });
  fs.writeFileSync(path.join(repo, NEW_DOC), "# new v1\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feat: new doc (draft)"]);
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("lint-historical-docs: 历史文档不可变", () => {
  it("修改已合入的历史特性文档 → 违规（exit 1）", () => {
    fs.writeFileSync(path.join(repo, OLD_DOC), "# old (edited)\n");
    stageOnly(repo, OLD_DOC);
    const r = runLint(repo);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/历史特性\/研究文档/);
    expect(r.stderr).toContain(OLD_DOC);
  });

  it("修改本分支新建的文档 → 通过（迭代载体，含已 commit 后再修改）", () => {
    fs.writeFileSync(path.join(repo, NEW_DOC), "# new v2\n");
    stageOnly(repo, NEW_DOC);
    expect(runLint(repo).status).toBe(0);
    // 新建并 commit 后再修改——曾误判场景，锁定
    git(repo, ["commit", "-m", "new doc committed"]);
    fs.writeFileSync(path.join(repo, NEW_DOC), "# new v3\n");
    stageOnly(repo, NEW_DOC);
    const r = runLint(repo);
    expect(r.status).toBe(0);
  });

  it("修改非 docs/features|research 路径 → 不拦截", () => {
    fs.writeFileSync(path.join(repo, "README.md"), "# repo (edited)\n");
    stageOnly(repo, "README.md");
    const r = runLint(repo);
    expect(r.status).toBe(0);
  });

  it("staged .doc-fix 声明文件（理由≥10字符）+ frontmatter 内变更 → 放行并警告", () => {
    fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT.replace("title: 旧特性", "title: 旧特性（订正）"));
    fs.writeFileSync(path.join(repo, ".doc-fix"), "订正 frontmatter title 字段（#1100）\n");
    stageOnly(repo, ".");
    const r = runLint(repo);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/变更均在 frontmatter 块内/);
    expect(r.stderr).toMatch(/订正 frontmatter/);
    git(repo, ["reset", "-q", "--", ".doc-fix", OLD_DOC]);
    fs.rmSync(path.join(repo, ".doc-fix"), { force: true });
    fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT);
  });

  it("严重1 锁定：.doc-fix + 正文内容修改 → 拒绝放行（开口仅限元数据是机制不是约定）", () => {
    fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT.replace("正文内容。", "正文内容被全部重写了。"));
    fs.writeFileSync(path.join(repo, ".doc-fix"), "这是一条与实际改动毫无关系的订正理由文本\n");
    stageOnly(repo, ".");
    const r = runLint(repo);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/超出 frontmatter 块/);
    expect(r.stderr).toContain(OLD_DOC);
    git(repo, ["reset", "-q", "--", ".doc-fix", OLD_DOC]);
    fs.rmSync(path.join(repo, ".doc-fix"), { force: true });
    fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT);
  });

  it(".doc-fix + frontmatter 与正文混合修改 → 拒绝放行", () => {
    fs.writeFileSync(path.join(repo, OLD_DOC),
      OLD_DOC_CONTENT.replace("title: 旧特性", "title: 订正").replace("正文内容。", "正文也改了。"));
    fs.writeFileSync(path.join(repo, ".doc-fix"), "订正 frontmatter title 字段（混了正文）\n");
    stageOnly(repo, ".");
    const r = runLint(repo);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/超出 frontmatter 块/);
    git(repo, ["reset", "-q", "--", ".doc-fix", OLD_DOC]);
    fs.rmSync(path.join(repo, ".doc-fix"), { force: true });
    fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT);
  });

  it("delta-严重1 锁定：.doc-fix + 删除正文 key:value 形状行 → 拒绝放行（位置判定，形状分类器已退役）", () => {
    // 检视獭 delta 复核实测案：正文行 "Note: important thing" 形状像 key:value，旧形状判定误放
    // 注意：本用例需先让该正文行进入 HEAD（否则会命中「文件不在 HEAD」路径而测不到删除行判定）
    fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT + "Note: important thing\n");
    stageOnly(repo, OLD_DOC);
    git(repo, ["commit", "-q", "-m", "add note line to old doc"]);
    // 该 commit 让 OLD_DOC 在 ref..HEAD 内有改动但不是 Add——isAddedOnBranch 只看 diff-filter=A，仍判历史 ✓
    fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT);
    fs.writeFileSync(path.join(repo, ".doc-fix"), "这是一条与实际改动毫无关系的订正理由文本\n");
    stageOnly(repo, ".");
    const r = runLint(repo);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/超出 frontmatter 块/);
    // 收尾必须连 HEAD 一起恢复：本用例的 commit 已把 OLD_DOC 的 HEAD 版本改成含 Note 行，
    // 后续用例基于 OLD_DOC_CONTENT 改写会产生意外 diff（曾致 3 用例连锁失败）
    git(repo, ["reset", "-q", "--", ".doc-fix", OLD_DOC]);
    fs.rmSync(path.join(repo, ".doc-fix"), { force: true });
    git(repo, ["checkout", "--", OLD_DOC]);
    fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT);
    stageOnly(repo, OLD_DOC);
    git(repo, ["commit", "-q", "-m", "restore old doc"]);
  });

  it(".doc-fix + 删除 frontmatter 字段行 → 放行（old-side 位置判定：删除行在 frontmatter 块内）", () => {
    fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT.replace("change_type: feature\n", ""));
    fs.writeFileSync(path.join(repo, ".doc-fix"), "删除多余的 change_type 字段（订正）\n");
    stageOnly(repo, ".");
    const r = runLint(repo);
    expect(r.status).toBe(0);
    git(repo, ["reset", "-q", "--", ".doc-fix", OLD_DOC]);
    fs.rmSync(path.join(repo, ".doc-fix"), { force: true });
    fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT);
  });

  it("staged .doc-fix 但理由不足 10 字符 → 拦截（提示理由不足）", () => {
    fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT.replace("title: 旧特性", "title: 改"));
    fs.writeFileSync(path.join(repo, ".doc-fix"), "太短\n");
    stageOnly(repo, ".");
    const r = runLint(repo);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/理由不足 10 字符/);
    git(repo, ["reset", "-q", "--", ".doc-fix", OLD_DOC]);
    fs.rmSync(path.join(repo, ".doc-fix"), { force: true });
    fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT);
  });

  it("理由恰 10 字符 → 边界放行（≥10 口径锁定）", () => {
    fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT.replace("title: 旧特性", "title: 改"));
    fs.writeFileSync(path.join(repo, ".doc-fix"), "1234567890"); // 恰 10 字符
    stageOnly(repo, ".");
    expect(runLint(repo).status).toBe(0);
    git(repo, ["reset", "-q", "--", ".doc-fix", OLD_DOC]);
    fs.rmSync(path.join(repo, ".doc-fix"), { force: true });
    fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT);
  });

  it(".doc-fix 在子目录（docs/.doc-fix）→ 不生效，拦截", () => {
    fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT.replace("title: 旧特性", "title: 改"));
    fs.writeFileSync(path.join(repo, "docs/.doc-fix"), "子目录的声明文件不应生效\n");
    stageOnly(repo, ".");
    const r = runLint(repo);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/无 \.doc-fix 声明文件/);
    git(repo, ["reset", "-q", "--", "docs/.doc-fix", OLD_DOC]);
    fs.rmSync(path.join(repo, "docs/.doc-fix"), { force: true });
    fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT);
  });

  it("大小写变体 .DOC-FIX → 不生效，拦截", () => {
    fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT.replace("title: 旧特性", "title: 改"));
    fs.writeFileSync(path.join(repo, ".DOC-FIX"), "大写变体声明文件不应生效\n");
    stageOnly(repo, ".");
    const r = runLint(repo);
    expect(r.status).toBe(1);
    git(repo, ["reset", "-q", "--", ".DOC-FIX", OLD_DOC]);
    fs.rmSync(path.join(repo, ".DOC-FIX"), { force: true });
    fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT);
  });

  it("工作区有 .doc-fix 但未 staged → 拦截（声明必须 staged 才生效）", () => {
    fs.writeFileSync(path.join(repo, OLD_DOC), OLD_DOC_CONTENT.replace("title: 旧特性", "title: 改"));
    fs.writeFileSync(path.join(repo, ".doc-fix"), "这个文件没有 staged 进索引区\n");
    stageOnly(repo, OLD_DOC); // 只 stage 文档，不 stage .doc-fix
    const r = runLint(repo);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/无 \.doc-fix 声明文件/);
    fs.rmSync(path.join(repo, ".doc-fix"), { force: true });
    git(repo, ["checkout", "--", OLD_DOC]);
  });

  it("rename 历史文档（git mv + 编辑新路径）→ 旧路径 D 被拦（rename 等价语义，走 .doc-fix 声明通道）", () => {
    // 实测：git mv + add 后 staged 显示 A 新路径 + D 旧路径。新路径按 A 放行（rename 等价），
    // 旧路径 D 落入拦截——结构性重排走 .doc-fix 声明通道，本用例锁定该行为
    const renamed = "docs/features/2026/01/01/F20260101old-renamed.md";
    git(repo, ["mv", OLD_DOC, renamed]);
    fs.writeFileSync(path.join(repo, renamed), "# renamed+edited\n");
    git(repo, ["reset", "-q", "--", "."]);
    git(repo, ["add", "--", renamed, OLD_DOC]);
    const r = runLint(repo);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(OLD_DOC);
  });

  it("本分支新建文档 rename 后再修改 → 通过（迭代载体）", () => {
    const renamed = "docs/features/2026/08/31/F20260831new-renamed.md";
    git(repo, ["mv", NEW_DOC, renamed]);
    fs.writeFileSync(path.join(repo, renamed), "# new renamed+edited\n");
    // 只 stage 本用例涉及的两个路径（新路径 A + 旧路径 D），
    // 避免把上一用例遗留的 OLD_DOC rename（未清理）staged 进来
    stageOnly(repo, renamed);
    git(repo, ["add", "--", NEW_DOC]);
    const r = runLint(repo);
    expect(r.status).toBe(0);
    // 收尾（探针验证序列）：reset → 恢复 HEAD 内容到 renamed（git show 写文件+add 让 git 认识）
    // → mv 回原路径 → reset。否则 staged M（内容改写）残留会让后续 R 形态 rename 用例退化成 D+A
    git(repo, ["reset", "-q", "--", "."]);
    fs.writeFileSync(path.join(repo, renamed), git(repo, ["show", `HEAD:${NEW_DOC}`]) + "\n");
    git(repo, ["add", "--", renamed]);
    git(repo, ["mv", "-f", renamed, NEW_DOC]);
    git(repo, ["reset", "-q", "--", "."]);
  });

  it("F20260922rntc（#1103）：本分支新建文档 R 形态 rename（git mv 不改内容，R100 纯 rename）→ 通过（rename 溯源修复锁定）", () => {
    // 修复前实测：R 形态（相似度≥50%）下新路径查不到 Add commit → 误拦（行为随 git 相似度漂移）
    // 用纯 git mv（不改内容）保证 R100 形态，排除内容改写导致的 D+A 退化
    const renamed = "docs/features/2026/08/31/F20260831new-r-form.md";
    git(repo, ["mv", NEW_DOC, renamed]);
    // git mv 已暂存 rename 两端，无需再 add（旧路径已不存在，add 会报 pathspec 错）
    // 确认 staged 确实是 R 形态——rename 检测需全量 diff（pathspec 单路径过滤会抑制 rename 配对，
    // 实测：-- <new> 只显示 A；全量才显示 R100 old\tnew）
    const status = git(repo, ["diff", "--cached", "--name-status"]);
    expect(status).toMatch(new RegExp(`^R\\d{2,3}\\t${NEW_DOC}\\t${renamed}$`, "m"));
    const r = runLint(repo);
    expect(r.status).toBe(0);
    // 收尾（与上一用例同序列）：reset → 恢复 HEAD 内容 → add → mv 回 → reset
    // 隐式假设（检视建议 2 注记）：恢复内容 = trim + 单 "\n"（git() helper 对输出 trim），
    // 仅对「单换行结尾」的 fixture 精确——若 fixture 改为无换行/多换行结尾，恢复会静默漂移
    git(repo, ["reset", "-q", "--", "."]);
    fs.writeFileSync(path.join(repo, renamed), git(repo, ["show", `HEAD:${NEW_DOC}`]) + "\n");
    git(repo, ["add", "--", renamed]);
    git(repo, ["mv", "-f", renamed, NEW_DOC]);
    git(repo, ["reset", "-q", "--", "."]);
  });

  it("F20260922rntc delta（PR #1108 检视严重 1）：派生文档（cp 历史文档+微改）普通修改 → 通过（无 --follow 查询兜底）", () => {
    // 实测怪癖：--follow --diff-filter=A 对高相似派生文件系统性 miss（内容来源被 follow 到历史文档，
    // Add commit 被过滤）；无 --follow 的 --diff-filter=A 按路径查直接命中 Add commit
    const derived = "docs/features/2026/08/31/F20260831der-derived.md";
    fs.writeFileSync(path.join(repo, derived), OLD_DOC_CONTENT.replace("F20260101old", "F20260831der").replace("旧特性", "派生特性"));
    stageOnly(repo, derived);
    git(repo, ["commit", "-q", "-m", "derived doc"]);
    // 普通修改
    fs.writeFileSync(path.join(repo, derived), OLD_DOC_CONTENT.replace("F20260101old", "F20260831der").replace("旧特性", "派生特性").replace("正文内容。", "正文内容，改了点。"));
    stageOnly(repo, derived);
    expect(runLint(repo).status).toBe(0);
    // 收尾：恢复到 commit 版本（该文件后续用例不用，但保持仓库干净）
    git(repo, ["reset", "-q", "--", "."]);
    git(repo, ["checkout", "--", derived]);
  });

  it("F20260922rntc delta（PR #1108 检视严重 1）：派生文档 R 形态 rename → 通过（oldPath 仅按来源判定 + 无 --follow 兜底）", () => {
    const derived = "docs/features/2026/08/31/F20260831der-derived.md";
    // 上一用例已创建并 commit 派生文档；直接 rename
    const renamed = "docs/features/2026/08/31/F20260831der-renamed.md";
    git(repo, ["mv", derived, renamed]);
    const status = git(repo, ["diff", "--cached", "--name-status"]);
    expect(status).toMatch(new RegExp(`^R\\d{2,3}\\t${derived}\\t${renamed}$`, "m"));
    expect(runLint(repo).status).toBe(0);
    // 收尾：rename 还在 staged 区时先 mv 回（reset 后 renamed 不被 git 追踪，mv 会报 not under version control）
    git(repo, ["mv", renamed, derived]);
    git(repo, ["reset", "-q", "--", "."]);
  });
});
