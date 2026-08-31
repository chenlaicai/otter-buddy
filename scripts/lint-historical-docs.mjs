#!/usr/bin/env node
/**
 * F20260831dgim: 历史特性文档不可变（commit-time gate）。
 *
 * 规则：已合入的特性/研究文档是交付时点的快照，禁止在后续分支上修改（M/R/C/D）。
 * 后续特性更新一律追加新特性文档记录变化（frontmatter from/supersedes 关联前文）。
 * 判定"历史"：该文件不是本分支新建（本分支独有 commit 里没有它的 Add 记录）。
 *
 * 逃生门（仅限结构性迁移，如 frontmatter backfill）：
 *   BYPASS_HISTORICAL_DOC_LINT=1 npm run ... 或直接带环境变量 commit
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
  if (process.env.BYPASS_HISTORICAL_DOC_LINT === "1") {
    console.warn("[lint:historical-docs] BYPASS_HISTORICAL_DOC_LINT=1，跳过（仅限结构性迁移）");
    process.exit(0);
  }
  const { errors } = findViolations();
  if (errors.length === 0) process.exit(0);

  console.error(`[lint:historical-docs] 检测到修改历史特性/研究文档（${errors.length} 个）：`);
  for (const f of errors) console.error(`  M ${f}`);
  console.error(`
错误：已合入的特性文档是交付时点的快照，禁止修改使其反映"当前状态"。
特性更新一律追加新特性文档记录变化过程（frontmatter from/supersedes 关联前文），
发现历史文档错误 → 在新文档中记录更正，不回改。
结构性迁移确需批量修改时：BYPASS_HISTORICAL_DOC_LINT=1 <commit命令>（并在特性文档中记录理由）。`);
  process.exit(1);
}

// 直接执行（非被 import 测试）时跑 main
if (process.argv[1] && process.argv[1].endsWith("lint-historical-docs.mjs")) {
  main();
}
