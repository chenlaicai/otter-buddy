#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { compareCapabilityEvidence, loadJson, sha256File } from "./capability-live-evidence.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`缺 ${name}`);
  return process.argv[index + 1];
}

const basePath = path.resolve(arg("--base"));
const headPath = path.resolve(arg("--head"));
const protocolPath = path.resolve(arg("--protocol"));
const outPath = path.resolve(arg("--out"));
function readRuns(inputPath) {
  if (!fs.statSync(inputPath).isDirectory()) return [loadJson(inputPath)];
  const runs = fs.readdirSync(inputPath)
    .filter(file => file.endsWith(".json") && !file.endsWith(".vitest.json"))
    .map(file => loadJson(path.join(inputPath, file)))
    .filter(value => value.kind === "capability-live-run");
  const byId = new Map();
  for (const run of runs) {
    const previous = byId.get(run.runId);
    if (previous && Boolean(previous.manualReviewAttachment) === Boolean(run.manualReviewAttachment)) {
      throw new Error(`runId 有多个同形态 manifest: ${run.runId}`);
    }
    if (!previous || run.manualReviewAttachment) byId.set(run.runId, run);
  }
  return [...byId.values()];
}
const base = readRuns(basePath);
const head = readRuns(headPath);
const protocol = loadJson(protocolPath);
const protocolHash = sha256File(protocolPath);
const comparison = compareCapabilityEvidence(base, head, protocol);
if ([...base, ...head].some(run => run.protocol?.sha256 !== protocolHash)) {
  comparison.outcome = "BLOCKED";
  comparison.errors.push("run manifest 未绑定当前 protocol 文件哈希");
}
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(comparison, null, 2)}\n`, { flag: "wx" });
console.log(`[capability-live-compare] ${comparison.outcome} scenarios=${comparison.scenarioCount ?? 0} out=${outPath}`);
for (const error of comparison.errors) console.error(`  ${error}`);
for (const scenario of comparison.scenarios.filter(item => item.status !== "PASS")) {
  console.log(`  ${scenario.status} ${scenario.id}: ${scenario.reason}`);
}
process.exitCode = comparison.outcome === "PASS" ? 0 : comparison.outcome === "FAIL" ? 1 : 2;
