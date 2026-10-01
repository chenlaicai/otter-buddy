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
 *   R 形态 rename（#1257，F20260930lrbk）：git mv 产生的 R 配对此前被双重误拦（isAddedOnBranch 按
 *   oldPath 判历史 + checkFrontmatterScope 单路径 diff 把 rename 展开成全文新增）——纯 rename
 *   （similarity 100%，内容零变化）本质是文件名级元数据订正。修复：R 配对改从全量 diff 取 hunks，
 *   无 hunks（纯 rename）放行；有 hunks 按 old/new 两侧 frontmatter 边界校验（正文编辑仍拦）；
 *   相似度 <50% 退化为 A+D 配对的仍宁拦（大改不是文件名订正）。.doc-fix 声明对 rename 通道同样强制。
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
 *  需按旧路径查 Add。
 *  F20260922rntc delta（PR #1108 检视严重 1 + 建议 1，判定语义修订）：
 *  - R 形态（oldPath 存在）：仅按 oldPath 判定——R 行语义上内容来源是 oldPath，「任一命中」
 *    中 newPath 一侧对 R 行恒 miss（依赖 git 怪癖的偶然正确），若 git 修正行为则留误放窗口
 *  - 非 R 形态（M/D）：并集查询——`--diff-filter=A`（无 --follow）兜住高相似派生文件
 *    （--follow 与 diff-filter 交互对派生文件系统性 miss，实测坐实），`--follow --diff-filter=A`
 *    保留已提交 rename 链的溯源
 */
function isAddedOnBranch(file, ref, oldPath) {
  const hasAdd = (p) => {
    try {
      const plain = git(["log", `${ref}..HEAD`, "--diff-filter=A", "--format=%H", "--", p]);
      if (plain.length > 0) return true;
      const follow = git(["log", `${ref}..HEAD`, "--follow", "--diff-filter=A", "--format=%H", "--", p]);
      return follow.length > 0;
    } catch {
      return false;
    }
  };
  if (oldPath && oldPath !== file) return hasAdd(oldPath); // R 形态：仅按来源路径判定
  return hasAdd(file);
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
  if (modified.length === 0) return { errors: [], entries: {}, degraded: false };

  const ref = baseRef();
  if (!ref) {
    console.warn("[lint:historical-docs] 找不到基准分支（origin/main/main），宽松放行");
    return { errors: [], entries: {}, degraded: true };
  }

  const entries = Object.fromEntries(
    modified.map((e) => [e.filePath, { status: e.status, oldPath: e.oldPath }])
  );
  const errors = modified
    .filter((e) => !isAddedOnBranch(e.filePath, ref, e.oldPath))
    .map((e) => e.filePath);
  return { errors, entries, degraded: false };
}

function main() {
  const { errors, entries } = findViolations();
  if (errors.length === 0) process.exit(0);

  // 显式开口：staged 区存在 .doc-fix 声明文件（内容≥10字符）+ 每个历史文档变更均在 frontmatter 块内
  const declaration = readDocFixDeclaration();
  if (declaration.ok) {
    const scope = checkFrontmatterScope(errors, entries);
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

/** 读 git 引用（`:<path>` 或 `HEAD:<path>`）内容的 frontmatter 结束行号（1-based，含第二个 ---）。
 *  无合法 frontmatter 块或读取失败返回 -1（调用方宁拦）。 */
function frontmatterLastLineOf(ref) {
  let content;
  try {
    content = git(["show", ref]);
  } catch {
    return -1;
  }
  const lines = content.split("\n");
  if (!(lines[0] && lines[0].trim() === "---")) return -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return i + 1; // 1-based
  }
  return -1;
}

/** 逐 hunk 校验：新增行（+）用 new-side 行号比对新边界；删除行（-）用 old-side 行号比对旧边界。
 *  位置判定对两类行统一生效（delta-严重 1：形状判定有洞已退役）。
 *  下一 hunk 边界用行首 "\n@@" 锚定（原 indexOf("@@") 会被 hunk 体内含 @@ 的行干扰，此处顺带收紧）。
 *  返回 true = 全部变更行在界内。 */
function hunksWithinBounds(diffText, oldFmLastLine, newFmLastLine) {
  const hunks = [...diffText.matchAll(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/g)];
  let pos = 0;
  for (const hm of hunks) {
    const hunkStartInDiff = diffText.indexOf(hm[0], pos);
    pos = hunkStartInDiff + hm[0].length;
    const nextHunk = diffText.indexOf("\n@@", pos);
    const body = diffText.slice(pos, nextHunk === -1 ? undefined : nextHunk + 1);
    let oldLine = Number(hm[1]);
    let newLine = Number(hm[3]);
    for (const raw of body.split("\n")) {
      if (raw.startsWith("+")) {
        if (raw.slice(1).trim() !== "" && newLine > newFmLastLine) return false;
        newLine++;
      } else if (raw.startsWith("-")) {
        if (raw.slice(1).trim() !== "" && oldLine > oldFmLastLine) return false;
        oldLine++;
      } else {
        // 上下文行（-U0 下应无，防御）
        oldLine++;
        newLine++;
      }
    }
  }
  return true;
}

/** R 形态 rename 的 frontmatter 边界校验（#1257，F20260930lrbk）。
 *  rename 配对只在全量 staged diff 中呈现（pathspec 单路径过滤会抑制 rename 检测，实测坐实），
 *  故从全量 diff 提取本文件的 rename 段再解析：
 *  - similarity 100% 且无 hunk：纯 rename（内容零变化，文件名级元数据订正）→ 放行
 *  - 有 hunk：rename + 编辑——按 old/new 两侧 frontmatter 边界校验，正文编辑仍拦
 *  - 未匹配到 rename 配对（相似度低于阈值退化为 A+D）：宁拦（大改不是文件名订正）
 *  .doc-fix 声明在调用侧同样强制（rename 通道不是无声明后门）。 */
function checkRenameScope(oldPath, newPath, outOfScope) {
  let diff;
  try {
    diff = git(["diff", "--cached", "-U0", "-M"]);
  } catch {
    outOfScope.push(newPath);
    return;
  }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 终点：下一段段头（\n diff --git）或串尾（git() 输出被 trim，末段无尾随换行，$ 不得依赖 \n）
  const seg = diff.match(
    new RegExp(`diff --git a/${esc(oldPath)} b/${esc(newPath)}\\n[\\s\\S]*?(?:(?=\\n(?:diff --git ))|$)`)
  );
  if (!seg) {
    outOfScope.push(newPath); // rename 配对未出现（退化 A+D）→ 宁拦
    return;
  }
  const section = seg[0];
  const hunks = [...section.matchAll(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/g)];
  if (hunks.length === 0) return; // 纯 rename（similarity 100%）→ 内容零变化，放行
  const oldFmLastLine = frontmatterLastLineOf(`HEAD:${oldPath}`);
  const newFmLastLine = frontmatterLastLineOf(`:${newPath}`);
  if (oldFmLastLine === -1 || newFmLastLine === -1) {
    outOfScope.push(newPath); // 两侧任一无合法 frontmatter 块 → 宁拦
    return;
  }
  if (!hunksWithinBounds(section, oldFmLastLine, newFmLastLine)) outOfScope.push(newPath);
}

/** 校验每个历史文档的 staged 变更行全部落在 frontmatter 块内（首个 --- 至次个 ---）。
 *  判定口径（宁拦勿放）：变更行（+/- 开头、非 +++/--- 头）trim 后非空，且行号在 frontmatter 块外 → 超出。
 *  读索引区（git show :<file>）拿新版本的 frontmatter 边界，与 git diff --cached -U0 的 hunk 行号比对。
 *  #1257：entries 携带 name-status 元数据，R 形态 rename 走 checkRenameScope（全量 diff 解析 rename 对）。 */
function checkFrontmatterScope(files, entries = {}) {
  const outOfScope = [];
  for (const file of files) {
    const entry = entries[file] ?? {};
    if (entry.oldPath && entry.oldPath !== file) {
      checkRenameScope(entry.oldPath, file, outOfScope);
      continue;
    }
    const newFmLastLine = frontmatterLastLineOf(`:${file}`);
    // 无合法 frontmatter 块 / 读取失败（如纯删除）→ 无法证明变更是元数据级 → 宁拦
    if (newFmLastLine === -1) { outOfScope.push(file); continue; }
    const oldFmLastLine = frontmatterLastLineOf(`HEAD:${file}`);
    // 旧版本边界——删除行用 old-side 位置判定（delta-严重 1：形状判定有洞，
    // 正文行 "Note: important" 形状像 key:value 曾被误放；纯位置判定无此洞）；
    // HEAD 读不到（理论边角）→ 宁拦
    if (oldFmLastLine === -1) { outOfScope.push(file); continue; }

    let diff;
    try {
      diff = git(["diff", "--cached", "-U0", "--", file]);
    } catch {
      outOfScope.push(file);
      continue;
    }
    if (!hunksWithinBounds(diff, oldFmLastLine, newFmLastLine)) outOfScope.push(file);
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
