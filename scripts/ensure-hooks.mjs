#!/usr/bin/env node
/**
 * F20260902wh68: core.hooksPath 自愈脚本——worktree/环境覆盖场景的本地钩子防线（issue #684）。
 *
 * 背景（5 天 3 次复发在案：F20260821kgts 绝对路径覆盖、#476 run/_、#681 worktree 场景
 * .husky/_ 残留）：core.hooksPath 一旦被外部工具改写为失效值，git 对不存在的钩子目录
 * 静默跳过——全部本地钩子（commit-msg/pre-commit/pre-push/pre-merge-commit）静默失效，
 * 提交规范只能靠 CI 兜底。worktree 是高频现场：多条派工线并行开发，hooksPath 存共享
 * repo config，任何一条线带坏值会立即全局扩散到所有 worktree。
 *
 * 行为：
 *   node scripts/ensure-hooks.mjs          检测 + 自愈（npm prepare 入口）
 *   node scripts/ensure-hooks.mjs --check  只读校验（人工/CI 验证入口），失效时 exit 1
 *
 * 判定标准（fail-closed）：core.hooksPath 未配置，或按 git 解析规则（相对路径基于仓库根，
 * worktree 即 worktree 根）找不到可执行的 commit-msg → 视为钩子失效。
 * 修复 = 写回 .githooks（repo-local config，所有 worktree 共享，各 checkout 均含该目录）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const EXPECTED_HOOKS_PATH = ".githooks";
const REQUIRED_HOOK = "commit-msg";

function runGit(args, cwd) {
  return execFileSync("git", args, { encoding: "utf-8", cwd }).trim();
}

/** 读当前 hooksPath 值与来源。未配置返回 { value: null }。 */
function readHooksPath(cwd) {
  try {
    // --show-origin 输出形如 "file:/path/.git/config\t.githooks"
    const out = runGit(["config", "--show-origin", "--get", "core.hooksPath"], cwd);
    const idx = out.indexOf("\t");
    if (idx === -1) return { value: out, origin: "unknown" };
    return { value: out.slice(idx + 1).trim(), origin: out.slice(0, idx).trim() };
  } catch {
    return { value: null, origin: null };
  }
}

/** 按 git 解析规则把 hooksPath 解析为钩子目录（相对路径基于仓库根）。 */
function resolveHooksDir(root, hooksPath) {
  return path.isAbsolute(hooksPath) ? hooksPath : path.join(root, hooksPath);
}

/** 钩子目录是否真实可用：REQUIRED_HOOK 存在且可执行。 */
function hooksDirUsable(root, hooksPath) {
  if (!hooksPath) return false;
  const hookFile = path.join(resolveHooksDir(root, hooksPath), REQUIRED_HOOK);
  try {
    fs.accessSync(hookFile, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function main() {
  const checkOnly = process.argv.includes("--check");
  let root;
  try {
    root = runGit(["rev-parse", "--show-toplevel"], process.cwd());
  } catch {
    console.error("[ensure-hooks] 错误：当前目录不在 git 仓库内。");
    process.exit(1);
  }

  const { value, origin } = readHooksPath(process.cwd());

  if (hooksDirUsable(root, value)) {
    console.log(`[ensure-hooks] core.hooksPath=${value} ✓（来源 ${origin}，钩子目录可解析）`);
    return;
  }

  const reason = value === null ? "未配置 core.hooksPath" : `指向失效目录：${resolveHooksDir(root, value)}（无可用 ${REQUIRED_HOOK}）`;
  if (checkOnly) {
    console.error(`[ensure-hooks] ✗ 本地钩子失效：${reason}（来源 ${origin ?? "n/a"}）`);
    console.error("[ensure-hooks] 本地 commit-msg/pre-commit 等钩子会被 git 静默跳过，规范只剩 CI 兜底。");
    console.error("[ensure-hooks] 修复：npm run hooks:fix（等价于 npm run prepare）");
    process.exit(1);
  }

  // 自愈：写回仓库约定的 .githooks（repo-local，所有 worktree 共享）
  try {
    runGit(["config", "core.hooksPath", EXPECTED_HOOKS_PATH], process.cwd());
  } catch (err) {
    console.error(`[ensure-hooks] ✗ 写回 core.hooksPath 失败：${err.message}`);
    process.exit(1);
  }
  const after = readHooksPath(process.cwd());
  if (hooksDirUsable(root, after.value)) {
    console.log(`[ensure-hooks] 已自愈：core.hooksPath '${value ?? "(未配置)"}'（${reason}）→ '${after.value}'（来源 ${after.origin}）`);
    console.log("[ensure-hooks] 各 worktree 共享 repo config，此修复对全部 worktree 即时生效。");
  } else {
    console.error(`[ensure-hooks] ✗ 已写回 '${EXPECTED_HOOKS_PATH}' 但钩子目录仍不可用，请检查仓库完整性（应有 ${EXPECTED_HOOKS_PATH}/${REQUIRED_HOOK}）。`);
    process.exit(1);
  }
}

main();
