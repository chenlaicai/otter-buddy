#!/usr/bin/env node
/**
 * 文档状态推进 CLI：npm run docs:advance [-- --dry-run] [-- --since-days=45]
 *
 * Issue #646 段3：每日批量推进器。流程：
 *   1. 采集 main git log + F 文档 → 链构建（与 RhiScanWorker 同源逻辑）
 *   2. planDocAdvancements 纯函数规划（R1 迭代标记 / R2 收口 / R3 高置信归档）
 *   3. --dry-run：只打印计划不动文件；默认模式改写文件 → git diff 列变更 → 提示走 PR
 *
 * R1 红线：本 CLI 改写 docs/ 下的 git 追踪文件。
 * 推荐用法（无人工介入的每日自动模式）：
 *   git worktree add .claude/worktrees/docs-advance --detach
 *   node scripts/docs-advance.mjs && git -C .claude/worktrees/docs-advance commit && gh pr create
 * 由调度器（scheduled task）或人工触发，产出每日一个汇总 PR（issue 定稿：勿逐个触发，
 * 文档 PR 噪音会淹没审查）。
 *
 * 输出：JSON 结果（plan 摘要 + skip 留痕），exit 0=有变更或无变更皆成功，非 0=失败。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectGitLogWithFiles } from "../dist/src/usecases/health/git-log-collector.js";
import { parseCommits } from "../dist/src/usecases/health/commit-parser.js";
import { collectFeatureDocs } from "../dist/src/usecases/health/feature-doc-collector.js";
import { buildFeatureChains } from "../dist/src/usecases/health/chain-builder.js";
import { planDocAdvancements, applyAdvancements } from "../dist/src/usecases/health/doc-advancer.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const sinceArg = args.find(a => a.startsWith("--since-days="));
// 默认 90 天：R3 需「静默 >60 天」证据，链尾 commit 至少 60 天前——45 天窗口装不下（会误判 doc-only）
const sinceDays = sinceArg ? parseInt(sinceArg.split("=")[1], 10) : 90;

async function main() {
  // 1. 采集（与 RhiScanWorker.buildChainsOnce 同源：git log → parse → chains）
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const commitsWithFiles = await collectGitLogWithFiles(rootDir, { since });
  const parsed = parseCommits(commitsWithFiles.map(({ sha, message }) => ({ sha, message })));
  const signalInputs = commitsWithFiles.map((c, i) => ({
    sha: c.sha,
    date: c.date,
    message: c.message,
    parsed: parsed[i],
    filesChanged: c.filesChanged,
  }));
  const docs = await collectFeatureDocs(rootDir);

  // 2. 链构建（不做 zombie 两阶段——推进器只看 commit 证据与状态，不依赖提及计数）
  const chains = buildFeatureChains(signalInputs, docs);

  // 2.5 采集每个文档文件的最后触碰 commit（R1 迭代判定证据：区分「标注与 commit 同步」与「标注后又迭代」）
  const docLastTouched = await collectDocLastTouchedShas(docs.map(d => d.filePath), rootDir);

  // 3. 规划（映射为 ChainEvidence 视图，附 docLastTouchedSha）
  const evidences = chains.map(c => ({
    featureId: c.featureId,
    doc: c.doc ? { status: c.doc.status, substatus: c.doc.substatus ?? null, filePath: c.doc.filePath } : null,
    commits: c.commits.map(cm => ({ date: cm.date, prNumber: cm.prNumber, sha: cm.sha })),
    lastCommitAt: c.lastCommitAt,
    commitCount: c.commitCount,
    docLastTouchedSha: docLastTouched.get(c.doc?.filePath ?? "") ?? null,
  }));
  const plan = planDocAdvancements(evidences);

  // 4. 输出计划
  console.log(JSON.stringify({
    scannedAt: plan.plannedAt,
    windowDays: sinceDays,
    chainCount: chains.length,
    actionCount: plan.actions.length,
    skipCount: plan.skipped.length,
    actions: plan.actions,
    skipped: plan.skipped,
  }, null, 2));

  if (dryRun) {
    console.error("[docs-advance] dry-run：未改写任何文件");
    return;
  }

  // 5. 应用（幂等）
  const changed = await applyAdvancements(plan, rootDir);
  console.error(`[docs-advance] 已改写 ${changed} 个文档（幂等：重复执行无重复改动）`);
  console.error("[docs-advance] 下一步：git add docs/ && commit + PR（每日一个汇总 PR，勿逐个触发）");
}

main().catch(err => {
  console.error("[docs-advance] 失败:", err);
  process.exit(1);
});

/** 批量查每个文档文件最后一次被哪个 commit 触碰（git log -1 --format=%H -- <path>）。
 *  未被 git 追踪过的文件返回 undefined（Map 无此 key）。 */
async function collectDocLastTouchedShas(filePaths, rootDir) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const map = new Map();
  for (const fp of filePaths) {
    try {
      const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%H", "--", fp], { cwd: rootDir });
      const sha = stdout.trim();
      if (sha) map.set(fp, sha);
    } catch {
      // 未追踪/无历史：不入 Map（undefined 语义 = 无证据，推进器保守不标）
    }
  }
  return map;
}
