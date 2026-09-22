#!/usr/bin/env node
/**
 * F20260831dgim: 历史特性文档不可变（commit-time gate）。
 * F20260922dfch: BYPASS 环境变量自觉制 → `.doc-fix` 声明文件显式开口（搭档决策 2026-09-22）。
 *
 * 规则：已合入的特性/研究文档是交付时点的快照，禁止在后续分支上修改（M/R/C/D）。
 * 后续特性更新一律追加新特性文档记录变化（frontmatter from/supersedes 关联前文）。
 * 判定"历史"：该文件不是本分支新建（本分支独有 commit 里没有它的 Add 记录）。
 *
 * 显式开口（仅限元数据订正：frontmatter 字段修正、id 对齐、格式订正——内容/设计修改一律走 supersede 新文档）：
 *   在仓库根目录新建 `.doc-fix` 文件并 staged 进同一个 commit，文件内容写明订正理由（≥10 字符）。
 *   声明文件随 commit 历史与 PR commits 可见（squash 合并下不进 main 净 diff）——比环境变量更不易悄悄绕过，且理由强制留痕。
 *   机械边界（F20260922dfch 严重 1 处置）：除声明文件外，每个历史文档的变更行必须全部落在 frontmatter
 *   块内（首个 --- 至次个 ---）；正文实质修改（增/删非空行）即使配 .doc-fix 也拒绝放行——「仅限元数据」
 *   是机制不是约定。提交后由使用者删除 .doc-fix（lint 仅提示；忘删 fail-closed：残留且未变更的声明不开启通道）。
 *
 * 退出码：0 通过 / 1 有违规 / 2 环境异常（宽松放行，不误伤）。
 */
import { execFileSync } from "node:child_process";

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...opts }).trim();
}

/** 找基准分支引用（origin/main 优先，退化为 main，都无则返回 null 宽松放行） */
function baseRef() {
  for (const ref of ["origin/main", "main"]) {
    try {
      git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return ref;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** 该文件是否为本分支新建（在 origin/main..HEAD 全部 commit 中曾出现过 Add，含新增后修改/重命名路径）
 *  边界：新增后 commit 再修改的场景，log 范围含产生 Add 的 commit，判定为分支新建
 *  F20260922rntc（#1103）：rename R 形态溯源——staged rename 未提交时，新路径在 ref..HEAD 中
 *  查不到 Add（git log --follow 对已提交历史有效，但对「索引区里尚未提交的 rename」看不到），
 *  需同时按旧路径查 Add；任一路径命中即本分支新建。 */
function isAddedOnBranch(file, ref, oldPath) {
  try {
    const out = git(["log", `${ref}..HEAD`, "--follow", "--diff-filter=A", "--format=%H", "--", file]);
    if (out.length > 0) return true;
    if (oldPath && oldPath !== file) {
      const oldOut = git(["log", `${ref}..HEAD`, "--follow", "--diff-filter=A", "--format=%H", "--", oldPath]);
      return oldOut.length > 0;
    }
    return false;
  } catch {
    return false;
  }
}

/** 解析 staged 状态行（git diff --cached --name-status），返回 {status, path, oldPath} */
function parseStatusLine(line) {
  const [rawStatus, ...rest] = line.split("\t");
  // 重命名/复制格式："R100\told\tnew" —— 目标路径是最后一列，旧路径是倒数第二列
  const filePath = rest[rest.length - 1];
  const oldPath = rest.length >= 2 ? rest[rest.length - 2] : undefined;
  return { status: rawStatus[0], filePath, oldPath };
}

export function findViolations() {
  let staged;
  try {
    staged = git(["diff", "--cached", "--name-status"]);
  } catch {
    return { errors: [], degraded: true };
  }
  if (!staged) return { errors: [], degraded: false };

  const tracked = staged
    .split("\n")
    .filter(Boolean)
    .map(parseStatusLine)
    .filter((e) => /^docs\/(features|research)\//.test(e.filePath));

  if (tracked.length === 0) return { errors: [], degraded: false };

  const modified = tracked.filter((e) => e.status !== "A");
  if (modified.length === 0) return { errors: [], degraded: false };

  const ref = baseRef();
  if (!ref) {
    console.warn("[lint:historical-docs] 找不到基准分支（origin/main/main），宽松放行");
    return { errors: [], degraded: true };
  }

  const errors = modified
    .filter((e) => !isAddedOnBranch(e.filePath, ref, e.oldPath))
    .map((e) => e.filePath);
  return { errors, degraded: false };
}

function main() {
  const { errors } = findViolations();
  if (errors.length === 0) process.exit(0);

  // 显式开口：staged 区存在 .doc-fix 声明文件（内容≥10字符）+ 每个历史文档变更均在 frontmatter 块内
  const declaration = readDocFixDeclaration();
  if (declaration.ok) {
    const scope = checkFrontmatterScope(errors);
    if (scope.ok) {
      console.warn(`[lint:historical-docs] .doc-fix 声明文件存在且变更均在 frontmatter 块内，放行 ${errors.length} 个历史文档修改：`);
      for (const f of errors) console.warn(`  M ${f}`);
      console.warn(`  声明理由：${sanitize(declaration.reason)}`);
      console.warn(`  提示：.doc-fix 为一次性声明文件，提交后请删除（git rm .doc-fix；忘删 fail-closed 不构成绕过）。`);
      process.exit(0);
    }
    console.error(`[lint:historical-docs] .doc-fix 声明存在，但以下历史文档的变更超出 frontmatter 块（正文实质修改）：`);
    for (const f of scope.outOfScope) console.error(`  M ${f}`);
    console.error(`
.doc-fix 开口仅限元数据订正（frontmatter 块内）。正文内容/设计修改禁止回改——
请新建特性文档记录变化（frontmatter from/supersedes 关联前文），或将本次正文改动撤销后重新提交。`);
    process.exit(1);
  }

  console.error(`[lint:historical-docs] 检测到修改历史特性/研究文档（${errors.length} 个）：`);
  for (const f of errors) console.error(`  M ${f}`);
  console.error(`
错误：已合入的特性文档是交付时点的快照，禁止修改使其反映"当前状态"。

正当通道（二选一）：
  ① 元数据订正（frontmatter 字段修正 / id 对齐 / 格式订正）：
     在仓库根目录新建 .doc-fix 文件并 staged 进同一个 commit，内容写清订正理由（≥10 字符）。
     声明文件随 commit 历史与 PR commits 可见（squash 合并下不进 main 净 diff）；提交后删除该文件。
     变更行须全部落在 frontmatter 块内——正文修改即使配 .doc-fix 也会被拒。
  ② 内容/设计修改：
     禁止回改历史文档——新建特性文档记录变化（frontmatter from/supersedes 关联前文）。
${declaration.hint}`);
  process.exit(1);
}

/** 终端输出消毒：strip ANSI 转义序列与回车，防理由文本污染终端（检视建议 4）
 *  eslint no-control-regex 规避：用 u001b 构造而非字面 \x1b */
function sanitize(s) {
  const esc = String.fromCharCode(27);
  const ansi = new RegExp(esc + "\\[[0-9;]*[a-zA-Z]", "g");
  return s.replace(ansi, "").replace(/[\r\n]+/g, " ");
}

/** 校验每个历史文档的 staged 变更行全部落在 frontmatter 块内（首个 --- 至次个 ---）。
 *  判定口径（宁拦勿放）：变更行（+/- 开头、非 +++/--- 头）trim 后非空，且行号在 frontmatter 块外 → 超出。
 *  读索引区（git show :<file>）拿新版本的 frontmatter 边界，与 git diff --cached -U0 的 hunk 行号比对。 */
function checkFrontmatterScope(files) {
  const outOfScope = [];
  for (const file of files) {
    let newContent;
    try {
      newContent = git(["show", `:${file}`]);
    } catch {
      outOfScope.push(file); // 读取失败（如纯删除）宁拦
      continue;
    }
    const lines = newContent.split("\n");
    // frontmatter 块：第 1 行 ---，到下一处 --- 为止
    let fmEnd = -1;
    if (lines[0] && lines[0].trim() === "---") {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === "---") { fmEnd = i; break; }
      }
    }
    // 无合法 frontmatter 块（行号从 1 计，fmEnd 是 0-based 索引）→ 无法证明变更是元数据级 → 宁拦
    if (fmEnd === -1) { outOfScope.push(file); continue; }
    const fmLastLine = fmEnd + 1; // 1-based 行号（含第二个 ---）

    let diff;
    try {
      diff = git(["diff", "--cached", "-U0", "--", file]);
    } catch {
      outOfScope.push(file);
      continue;
    }
    // 旧版本（HEAD）的 frontmatter 边界——删除行用 old-side 位置判定（delta-严重 1：形状判定有洞，
    // 正文行 "Note: important" 形状像 key:value 曾被误放；纯位置判定无此洞）
    let oldFmLastLine = -1;
    try {
      const oldContent = git(["show", `HEAD:${file}`]);
      const oldLines = oldContent.split("\n");
      if (oldLines[0] && oldLines[0].trim() === "---") {
        for (let i = 1; i < oldLines.length; i++) {
          if (oldLines[i].trim() === "---") { oldFmLastLine = i + 1; break; } // 1-based
        }
      }
    } catch {
      oldFmLastLine = -1; // HEAD 读不到（理论边角）→ 宁拦
    }
    if (oldFmLastLine === -1) { outOfScope.push(file); continue; }

    // 逐 hunk 校验：新增行（+）用 new-side 行号比对新边界；删除行（-）用 old-side 行号比对旧边界。
    // 位置判定对两类行统一生效，形状分类器退役（delta 复核：死分支注释类一并消失）。
    let violated = false;
    const hunks = [...diff.matchAll(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/g)];
    // diff 中 hunk 之后的行序列属于该 hunk；逐行推进 old/new 两侧行号
    let pos = 0;
    for (const hm of hunks) {
      const hunkStartInDiff = diff.indexOf(hm[0], pos);
      pos = hunkStartInDiff + hm[0].length;
      const nextHunk = diff.indexOf("@@", pos);
      const body = diff.slice(pos, nextHunk === -1 ? undefined : nextHunk);
      let oldLine = Number(hm[1]);
      let newLine = Number(hm[3]);
      for (const raw of body.split("\n")) {
        if (raw.startsWith("+")) {
          if (raw.slice(1).trim() !== "" && newLine > fmLastLine) { violated = true; break; }
          newLine++;
        } else if (raw.startsWith("-")) {
          if (raw.slice(1).trim() !== "" && oldLine > oldFmLastLine) { violated = true; break; }
          oldLine++;
        } else {
          // 上下文行（-U0 下应无，防御）
          oldLine++;
          newLine++;
        }
      }
      if (violated) break;
    }
    if (violated) outOfScope.push(file);
  }
  return { ok: outOfScope.length === 0, outOfScope };
}

/** 读取 staged 区的 .doc-fix 声明文件（git show :<file> 读索引区内容，不看工作区） */
function readDocFixDeclaration() {
  let staged;
  try {
    staged = git(["diff", "--cached", "--name-only"]);
  } catch {
    return { ok: false, hint: "" };
  }
  if (!staged.split("\n").includes(".doc-fix")) {
    return { ok: false, hint: "（当前 staged 区无 .doc-fix 声明文件）" };
  }
  let content;
  try {
    content = git(["show", ":.doc-fix"]);
  } catch {
    return { ok: false, hint: "（.doc-fix 已 staged 但读取失败）" };
  }
  const reason = content.trim();
  if (reason.length < 10) {
    return { ok: false, hint: `（.doc-fix 存在但理由不足 10 字符："${sanitize(reason)}"）` };
  }
  return { ok: true, reason };
}

// 直接执行（非被 import 测试）时跑 main
if (process.argv[1] && process.argv[1].endsWith("lint-historical-docs.mjs")) {
  main();
}
