#!/usr/bin/env node
/**
 * 依赖分区唯一性机械闸：一个包只能出现在一个依赖分区里。
 *
 * 第一性原理：npm 对「同一个包同时写在 dependencies 与 devDependencies」不报错，
 * 但它只保留一份解析结果——在实践中以 devDependencies 那份为准。于是
 * `npm install --omit=dev`（生产安装）会**跳过这个包**，而代码里照样 import 它：
 * 生产环境启动即 ERR_MODULE_NOT_FOUND，本地与 CI 却全绿（它们不 omit dev）。
 *
 * 实证（2026-11-19 ECS 部署）：`hono` / `@hono/node-server` 两边都列，HTTP 层 import
 * hono，按 deploy.sh 装完生产依赖后服务起不来。同批还有 `playwright` 两边都列且版本
 * 不同（1.63.0 / 1.65.0），谁生效取决于 npm 的解析心情。
 *
 * 两条断言（都要过）：
 *   1. 分区互斥——同一包名不得同时出现在 dependencies / devDependencies /
 *      optionalDependencies 中（peerDependencies 是合法叠加，不参与）。
 *   2. 生产可安装提示——dependencies 的包在 package-lock.json 中带 `dev: true` 时给
 *      **警告**（不是错误）：这一层是启发式，遇到手改过的 lock 会误报；真正的红由断言 1 出。
 *
 * 退出码：0 通过 / 1 违规 / 2 读文件失败（fail-closed）。
 * 用法：node scripts/check-dependency-sections.mjs [--package package.json] [--lock package-lock.json]
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 参与互斥判定的分区。
 *
 * peerDependencies 刻意不在其中：npm 明确允许同一个包同时出现在 peerDependencies 与
 * devDependencies（「我既是别人的 peer，也自己开发时要装」是合法且常见的写法），
 * 把它算进互斥会误伤真实仓库。
 */
export const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
];

/** 声明了但仍单独提示的区（不参与互斥，仅用于报告里区分「合法叠加」与「真冲突」）。 */
export const NON_CONFLICTING_SECTION = "peerDependencies";

/**
 * 断言 1：分区互斥。
 * @param {Record<string, Record<string, string> | undefined>} pkg
 * @returns {Array<{name: string, sections: string[]}>} 违规列表（空 = 通过）
 */
export function findSectionDuplicates(pkg) {
  /** @type {Map<string, string[]>} */
  const seen = new Map();
  for (const section of DEPENDENCY_SECTIONS) {
    const table = pkg?.[section];
    if (!table || typeof table !== "object") continue;
    for (const name of Object.keys(table)) {
      const list = seen.get(name) ?? [];
      list.push(section);
      seen.set(name, list);
    }
  }
  const violations = [];
  for (const [name, sections] of seen) {
    if (sections.length > 1) violations.push({ name, sections });
  }
  // 稳定输出：按包名排序，便于 diff 与断言
  violations.sort((a, b) => a.name.localeCompare(b.name));
  return violations;
}

/**
 * 断言 2：生产可安装——dependencies 的包在 lock 中不得标记 dev。
 * @param {Record<string, Record<string, string> | undefined>} pkg
 * @param {{packages?: Record<string, {dev?: boolean, devOptional?: boolean, version?: string}>}} lock
 * @returns {Array<{name: string, entry: string, version?: string}>} 违规列表
 */
export function findDevFlaggedRuntimeDeps(pkg, lock) {
  const packages = lock?.packages ?? {};
  const violations = [];
  for (const name of Object.keys(pkg?.dependencies ?? {})) {
    const entry = packages[`node_modules/${name}`];
    // lock 里没有该条目 = 由其他包间接提供或尚未解析，不在此断言范围（交给 npm ci 自己报）
    if (!entry) continue;
    if (entry.dev === true) {
      violations.push({ name, entry: `node_modules/${name}`, version: entry.version });
    }
  }
  violations.sort((a, b) => a.name.localeCompare(b.name));
  return violations;
}

/**
 * 汇总两道断言。
 * @returns {{ok: boolean, duplicates: Array<{name: string, sections: string[]}>, devFlagged: Array<{name: string, entry: string, version?: string}>}}
 */
export function checkDependencySections(pkg, lock) {
  const duplicates = findSectionDuplicates(pkg);
  const devFlagged = findDevFlaggedRuntimeDeps(pkg, lock);
  // 只有断言 1 决定成败；devFlagged 是启发式提示（lock 手改/历史遗留会误报，不阻断）
  return { ok: duplicates.length === 0, duplicates, devFlagged };
}

/** 把违规列表渲染成人读的报错文本（CI 日志直接可见）。 */
export function formatViolations({ duplicates, devFlagged }) {
  const lines = [];
  if (duplicates.length > 0) {
    lines.push("❌ 同一包出现在多个依赖分区（npm 只保留一份解析结果，omit=dev 会静默跳过它）：");
    for (const v of duplicates) lines.push(`   - ${v.name} → ${v.sections.join(" + ")}`);
    lines.push("   修法：运行时依赖只留 dependencies；纯开发工具只留 devDependencies，两边不许都写。");
  }
  if (devFlagged.length > 0) {
    lines.push("⚠ 提示（不阻断）：dependencies 的包在 package-lock 中带 dev 标记，生产安装可能跳过它——");
    for (const v of devFlagged) lines.push(`   - ${v.name}${v.version ? `@${v.version}` : ""}（${v.entry}: dev=true）`);
    lines.push("   建议重跑 npm install --package-lock-only 让 lock 与实际分区一致。");
  }
  return lines.join("\n");
}

/** 极简参数解析（--key value / --key=value）。 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[arg.slice(2)] = next;
        i += 1;
      } else {
        out[arg.slice(2)] = true;
      }
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkgPath = resolve(typeof args.package === "string" ? args.package : "package.json");
  const lockPath = resolve(typeof args.lock === "string" ? args.lock : "package-lock.json");

  let pkg;
  let lock;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (err) {
    console.error(`❌ 读 package.json 失败：${pkgPath} —— ${err.message}`);
    return 2;
  }
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (err) {
    console.error(`❌ 读 package-lock.json 失败：${lockPath} —— ${err.message}`);
    return 2;
  }

  const result = checkDependencySections(pkg, lock);
  if (!result.ok) {
    console.error(formatViolations(result));
    return 1;
  }
  if (result.devFlagged.length > 0) console.warn(formatViolations(result));
  const depCount = Object.keys(pkg?.dependencies ?? {}).length;
  const devCount = Object.keys(pkg?.devDependencies ?? {}).length;
  const optCount = Object.keys(pkg?.optionalDependencies ?? {}).length;
  console.log(
    `✅ 依赖分区唯一：dependencies ${depCount} 个、devDependencies ${devCount} 个、optional ${optCount} 个，三区零重叠（peer 可合法叠加）`,
  );
  return 0;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  process.exit(main());
}
