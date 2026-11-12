#!/usr/bin/env node
/** 用同一生成器重算原始证据后附着人工评审；不 rerun、不覆盖原件。 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_INVENTORY,
  CANONICAL_INVENTORY_SHA256,
  createRunManifest,
  loadJson,
  sha256,
  sha256File,
} from "./capability-live-evidence.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`缺 ${name}`);
  return process.argv[index + 1];
}
const runPath = path.resolve(arg("--run"));
const reviewsPath = path.resolve(arg("--reviews"));
const logPath = path.resolve(arg("--log"));
const vitestPath = path.resolve(arg("--vitest-result"));
const run = loadJson(runPath);
if (run.kind !== "capability-live-run" || !["INCONCLUSIVE", "FAIL"].includes(run.outcome)) throw new Error("只有缺人工评审的 INCONCLUSIVE/FAIL run 可附着");
if (run.manualReviews?.every(item => ["pass", "fail"].includes(item.verdict))) throw new Error("人工评审已完整，无附件必要");
if (run.manualReviewAttachment) throw new Error("该 run 已附着评审");
if (run.inventory?.sha256 !== CANONICAL_INVENTORY_SHA256) throw new Error("非 canonical inventory");
if (sha256File(logPath) !== run.log?.sha256) throw new Error("原始日志哈希不匹配");
const vitest = loadJson(vitestPath);
if (sha256(JSON.stringify(vitest)) !== run.vitestResult?.sha256) throw new Error("Vitest JSON 哈希不匹配");
const reviews = loadJson(reviewsPath);
const expectedIds = CANONICAL_INVENTORY.manualReviewIds;
if (JSON.stringify(Object.keys(reviews).sort()) !== JSON.stringify([...expectedIds].sort())) throw new Error("人工评审场景集合不匹配");
for (const id of expectedIds) {
  if (!["pass", "fail"].includes(reviews[id]?.verdict) || !reviews[id]?.judged_by) throw new Error(`${id} 缺 verdict/judged_by`);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shared = {
  role: run.role,
  sourceSha: run.sourceSha,
  mergeBaseSha: run.mergeBaseSha,
  protocolPath: path.join(root, "tests/capability/live-protocol.json"),
  protocol: loadJson(path.join(root, "tests/capability/live-protocol.json")),
  inventoryPath: path.join(root, "tests/capability/live-inventory.json"),
  inventory: CANONICAL_INVENTORY,
  distWorkerSha256: run.distWorkerSha256,
  model: run.model,
  command: run.command,
  logPath,
  logText: fs.readFileSync(logPath, "utf8"),
  vitestResult: vitest,
  exitCode: run.exitCode,
  startedAt: run.startedAt,
  endedAt: run.endedAt,
  runId: run.runId,
  harnessSha: run.harness?.sha256,
  harnessOverlay: run.harness?.overlay,
  overlayDiffSha256: run.harness?.overlayDiffSha256,
};
const originalRecomputed = createRunManifest({ ...shared, manualReviews: Object.fromEntries(run.manualReviews.map(item => [item.id, item])) });
if (JSON.stringify(originalRecomputed) !== JSON.stringify(run)) {
  throw new Error("原始 run 无法由 log+Vitest+exitCode 逐字段重算；拒绝借附件改变非人工无效原因");
}
const reviewedBase = createRunManifest({ ...shared, manualReviews: reviews });
if (reviewedBase.outcome === "INCONCLUSIVE") throw new Error("补齐人工评审后仍有其他无效原因");
const reviewed = {
  ...reviewedBase,
  manualReviewAttachment: {
    attachedAt: new Date().toISOString(),
    reviewsSha256: sha256File(reviewsPath),
    originalManifestSha256: sha256File(runPath),
  },
};
const out = path.join(path.dirname(runPath), `${run.runId}.reviewed.json`);
fs.writeFileSync(out, `${JSON.stringify(reviewed, null, 2)}\n`, { flag: "wx" });
fs.appendFileSync(path.join(path.dirname(runPath), "attempts.jsonl"), `${JSON.stringify({
  runId: run.runId, attachment: "manualReview", attachedAt: reviewed.manualReviewAttachment.attachedAt,
  outcome: reviewed.outcome, originalManifestSha256: reviewed.manualReviewAttachment.originalManifestSha256,
  reviewedManifestSha256: sha256File(out),
})}\n`);
console.log(`[capability-manual-review] ${reviewed.outcome} ${out}`);
