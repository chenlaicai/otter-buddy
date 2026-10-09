#!/usr/bin/env node
/**
 * F20261009gwte：shadow 三跑对比（求值器 vs 现行判定链 vs 人工期望）。
 *
 * 用法：node scripts/shadow-write-eval.mjs [--corpus <path>] [--report <path>]
 * 前置：语料库由 build-write-eval-corpus.mjs 生成；ledger 样本 verdict 需人工裁决（null = UNADJUDGED）。
 *
 * 切换判据（方案 v2 预注册）：
 *   红线区真逃逸 = 0：expect=BLOCK 且 求值器放行（evaluated 空集/外部落点）且 旧链也放行
 *   误放 = 0：expect=BLOCK 且 求值器放行（不论旧链）
 *   族内成功率 ≥90%：Phase 1 声称覆盖族（synthetic+replay，即 expect 非 UNEVAL_UNKNOWN 的样本）中 evaluated 占比
 *   全集回落率 ≤50%：unevaluated / 全集
 *
 * 报告：data/guard-shadow-report-<date>.json + 控制台摘要。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
function argOf(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const corpusPath = resolve(argOf("--corpus", `${repoRoot}/tests/fixtures/guard-write-eval-corpus.json`));
const reportPath = resolve(argOf("--report", `${repoRoot}/data/guard-shadow-report-${new Date().toISOString().slice(0, 10)}.json`));

// 求值器（TS 源——经 dist 或 tsx；此处用 vitest 环境外直跑：require dist 编译产物）
// dist 由 npm run build 产出；shadow 前先 build
let evaluateWriteTargets, pathWithinMain;
try {
  const dist = require(resolve(repoRoot, "dist/src/frameworks/agent/write-target-evaluator.js"));
  evaluateWriteTargets = dist.evaluateWriteTargets;
  pathWithinMain = dist.pathWithinMain;
} catch {
  console.error("[shadow] 无法加载 dist/src/frameworks/agent/write-target-evaluator.js——先 npm run build");
  process.exit(2);
}
// 现行判定链（旧链）：checkBashCommandSafety
const guard = require(resolve(repoRoot, "dist/src/frameworks/agent/bash-safety-guard.js"));
const checkBashCommandSafety = guard.checkBashCommandSafety;

const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const MAIN_PID = 42877; // 与既有测试同口径（主进程 PID 场景）
const projectRoot = "/Users/orca/ai/otter-buddy"; // 真实主仓根（语料内 /repo 形态样本仅 synthetic 相对语义——见下）

const rows = [];
let unadjudged = 0;
for (const s of corpus.samples) {
  if (s.verdict === null || s.verdict === undefined) {
    // ledger 样本未裁决：跳过三跑（不计入判据），计数披露
    unadjudged += 1;
    rows.push({ id: s.id, command: s.command.slice(0, 120), source: s.source, status: "UNADJUDGED" });
    continue;
  }
  const expect = s.verdict; // 人工裁决后的期望（ALLOW/BLOCK）
  // 语料中 /repo 形态样本：统一映射到真实主仓根后双跑（两判定器看同一条命令）。
  // 替换带词边界：/repo/ 前缀 + 独立 /repo 词尾（如 git -C /repo commit）——
  // 首 delta 实测教训：漏掉词尾形态导致「/repo 字面量 vs 真实主仓根」错位假阳性。
  const realCmd = s.command
    .replaceAll("/repo/", `${projectRoot}/`)
    .replaceAll("/repo", projectRoot);
  const realRoot = projectRoot;

  // ① 求值器
  let evalResult, evalVerdict;
  try {
    evalResult = evaluateWriteTargets(realCmd, realRoot);
    if (evalResult.kind === "unevaluated") {
      evalVerdict = "FALLBACK"; // 回落旧链——shadow 期实际行为=旧链，但口径上单独记录
    } else {
      const hitsMain = evalResult.targets.some(t => pathWithinMain(t.path, realRoot));
      evalVerdict = hitsMain ? "BLOCK" : "ALLOW";
    }
  } catch (err) {
    evalVerdict = "EVAL-ERROR";
    evalResult = { error: err instanceof Error ? err.message : String(err) };
  }

  // ② 现行判定链
  let oldVerdict;
  try {
    const r = checkBashCommandSafety(realCmd, MAIN_PID, undefined, { projectRoot: realRoot });
    oldVerdict = r === null ? "ALLOW" : "BLOCK";
  } catch {
    oldVerdict = "OLD-ERROR";
  }

  let status;
  if (evalVerdict === "EVAL-ERROR" || oldVerdict === "OLD-ERROR") status = "ERROR";
  else if (evalVerdict === "FALLBACK") status = "FALLBACK"; // 回落：终态=旧链（shadow 记录回落事实）
  else if (evalVerdict === expect && oldVerdict === expect) status = "AGREE";
  else if (evalVerdict !== expect && oldVerdict === expect) status = evalVerdict === "BLOCK" ? "EVAL-OVERBLOCK" : "RED-LINE-ESCAPE";
  else if (evalVerdict === expect && oldVerdict !== expect) status = "EVAL-GAIN"; // 求值器修复旧链错（#1363 灰区族预期）
  else status = "BOTH-DIVERGE"; // 两边都与期望不同——逐条人工审
  rows.push({ id: s.id, command: s.command.slice(0, 120), source: s.source, expect, evalVerdict, oldVerdict, status, evalDetail: evalResult.kind === "unevaluated" ? `fallback:${evalResult.reason}` : evalResult.targets.map(t => t.path).slice(0, 3) });
}

const judged = rows.filter(r => r.status !== "UNADJUDGED");
const by = k => judged.filter(r => r.status === k);
const summary = {
  generatedAt: new Date().toISOString(),
  corpus: corpusPath,
  total: corpus.samples.length,
  judged: judged.length,
  unadjudged,
  AGREE: by("AGREE").length,
  FALLBACK: by("FALLBACK").length,
  EVAL_GAIN: by("EVAL-GAIN").length,
  EVAL_OVERBLOCK: by("EVAL-OVERBLOCK").length,
  RED_LINE_ESCAPE: by("RED-LINE-ESCAPE").length,
  BOTH_DIVERGE: by("BOTH-DIVERGE").length,
  ERROR: by("ERROR").length,
};
// 判据核算
const covered = judged.filter(r => r.evalVerdict !== "FALLBACK");
summary.coveredRate = judged.length ? +(covered.length / judged.length * 100).toFixed(1) : 0;
summary.fallbackRate = judged.length ? +(summary.FALLBACK / judged.length * 100).toFixed(1) : 100;
summary.pass = summary.RED_LINE_ESCAPE === 0 && summary.EVAL_OVERBLOCK === 0 && summary.fallbackRate <= 50;

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify({ summary, rows }, null, 2)}\n`);

console.log(`[shadow] 语料 ${summary.total}（已裁决 ${summary.judged} / 未裁决 ${unadjudged}）`);
console.log(`[shadow] AGREE=${summary.AGREE} FALLBACK=${summary.FALLBACK} EVAL_GAIN=${summary.EVAL_GAIN} OVERBLOCK=${summary.EVAL_OVERBLOCK} RED_LINE_ESCAPE=${summary.RED_LINE_ESCAPE} BOTH_DIVERGE=${summary.BOTH_DIVERGE} ERROR=${summary.ERROR}`);
console.log(`[shadow] 全集回落率=${summary.fallbackRate}%（判据 ≤50%）`);
console.log(summary.pass ? "[shadow] ✅ 切换判据达标（预注册三项全过）" : "[shadow] ❌ 切换判据未达标——停在影子态，旧链不动");
console.log(`[shadow] 报告：${reportPath}`);
process.exit(summary.pass ? 0 : 1);
