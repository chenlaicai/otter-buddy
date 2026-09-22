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
 *   声明文件随 commit 进 git 历史、随 PR diff 可见——比环境变量更不易悄悄绕过，且理由强制留痕。
 *   工具链在消费后负责删除该文件（一次性用途）。
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
 *  边界：新增后 commit 再修改的场景，log 范围含产生 Add 的 commit，判定为分支新建 */
function isAddedOnBranch(file, ref) {
  try {
    const out = git(["log", `${ref}..HEAD`, "--follow", "--diff-filter=A", "--format=%H", "--", file]);
    return out.length > 0;
  } catch {
    return false;
  }
}

/** 解析 staged 状态行（git diff --cached --name-status），返回 {status, path} */
function parseStatusLine(line) {
  const [rawStatus, ...rest] = line.split("\t");
  // 重命名/复制格式："R100\told\tnew" —— 目标路径是最后一列
  const filePath = rest[rest.length - 1];
  return { status: rawStatus[0], filePath };
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
    .filter((e) => !isAddedOnBranch(e.filePath, ref))
    .map((e) => e.filePath);
  return { errors, degraded: false };
}

function main() {
  const { errors } = findViolations();
  if (errors.length === 0) process.exit(0);

  // 显式开口：staged 区存在 .doc-fix 声明文件（内容≥10字符，写清订正理由）则放行
  const declaration = readDocFixDeclaration();
  if (declaration.ok) {
    console.warn(`[lint:historical-docs] .doc-fix 声明文件存在，放行 ${errors.length} 个历史文档修改（仅限元数据订正）：`);
    for (const f of errors) console.warn(`  M ${f}`);
    console.warn(`  声明理由：${declaration.reason}`);
    console.warn(`  提示：.doc-fix 为一次性声明文件，提交后请删除（git rm .doc-fix）。`);
    process.exit(0);
  }

  console.error(`[lint:historical-docs] 检测到修改历史特性/研究文档（${errors.length} 个）：`);
  for (const f of errors) console.error(`  M ${f}`);
  console.error(`
错误：已合入的特性文档是交付时点的快照，禁止修改使其反映"当前状态"。

正当通道（二选一）：
  ① 元数据订正（frontmatter 字段修正 / id 对齐 / 格式订正）：
     在仓库根目录新建 .doc-fix 文件并 staged 进同一个 commit，内容写清订正理由（≥10 字符）。
     声明文件随 commit 进 git 历史、随 PR diff 可见；提交后删除该文件。
  ② 内容/设计修改：
     禁止回改历史文档——新建特性文档记录变化（frontmatter from/supersedes 关联前文）。
${declaration.hint}`);
  process.exit(1);
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
    return { ok: false, hint: `（.doc-fix 存在但理由不足 10 字符："${reason}"）` };
  }
  return { ok: true, reason };
}

// 直接执行（非被 import 测试）时跑 main
if (process.argv[1] && process.argv[1].endsWith("lint-historical-docs.mjs")) {
  main();
}
