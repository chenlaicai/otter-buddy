#!/usr/bin/env node
/** 每轮干净 build + 全量真 LLM capability；失败也生成 manifest，原始文件不覆盖。 */
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createRunManifest,
  hashCapabilityHarness,
  loadJson,
  sha256,
  validateProtocol,
} from "./capability-live-evidence.mjs";

function arg(name, required = true) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && !value) throw new Error(`缺 ${name}`);
  return value;
}

const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
if (rootResult.status !== 0) throw new Error("必须在 git worktree 内运行");
const cwd = rootResult.stdout.trim();
if (process.argv.includes("--")) throw new Error("证据运行禁止 Vitest 文件/标题过滤；必须执行 canonical 全量 inventory");
const role = arg("--role");
if (!["base", "head"].includes(role)) throw new Error("--role 必须为 base/head");
const outDir = path.resolve(arg("--out"));
const protocolPath = path.resolve(arg("--protocol", false) ?? path.join(cwd, "tests/capability/live-protocol.json"));
const inventoryPath = path.join(cwd, "tests/capability/live-inventory.json");
const protocol = loadJson(protocolPath);
const inventory = loadJson(inventoryPath);
const protocolErrors = validateProtocol(protocol);
if (protocolErrors.length) throw new Error(protocolErrors.join("\n"));
const manualReviewsPath = arg("--manual-reviews", false);
const manualReviews = manualReviewsPath ? loadJson(path.resolve(manualReviewsPath)) : {};

const sourceSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).stdout.trim();
const mergeBaseSha = spawnSync("git", ["merge-base", "HEAD", "origin/main"], { cwd, encoding: "utf8" }).stdout.trim();
if (role === "base" && sourceSha !== mergeBaseSha) throw new Error("base run 必须 checkout 当前 head 与 origin/main 的 merge-base");
if (role === "head" && sourceSha === mergeBaseSha) throw new Error("head run 不能只指向 merge-base");

// porcelain 首列可能是空格；先 trim 会删掉首个文件的状态位并吞掉路径首字符。
const dirty = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).stdout;
const harnessOverlay = process.argv.includes("--allow-harness-overlay");
if (dirty && !harnessOverlay) throw new Error("worktree 有未提交改动，拒绝生成可归因证据；先提交或在 base 显式使用 --allow-harness-overlay");
if (dirty && role !== "base") throw new Error("只有 base 允许当前版本 harness 覆盖");
if (dirty && harnessOverlay) {
  const paths = dirty.split("\n").filter(line => line.trim()).map(line => line.slice(3));
  const allowed = file => /^tests\/(?:capability|helpers)\//.test(file) ||
    ["config/config.test.yaml", "vitest.capability.config.ts", "package.json", "package-lock.json",
      "scripts/capability-live-evidence.mjs", "scripts/run-capability-live.mjs", "scripts/compare-capability-live.mjs",
      "scripts/capability-live-inventory.mjs", "scripts/attach-capability-manual-review.mjs"].includes(file);
  const illegal = paths.filter(file => !allowed(file));
  if (illegal.length) throw new Error(`base overlay 污染被测源码或非 harness 文件: ${illegal.join(", ")}`);
}
const overlayDiff = harnessOverlay ? spawnSync("git", ["diff", "--binary"], { cwd, encoding: "utf8" }).stdout : "";

const reference = protocol.referenceModel;
const model = {
  provider: arg("--provider"),
  model: arg("--model"),
  baseUrl: arg("--base-url"),
  thinkingLevel: process.env.OTTER_TEST_LLM_THINKING_LEVEL ?? null,
};
for (const [field, expected] of Object.entries(reference)) {
  if (model[field] !== expected) throw new Error(`实际模型必须匹配预注册参考模型：${field}=${expected}`);
}
if (!process.env.OTTER_TEST_LLM_API_KEY) throw new Error("缺 OTTER_TEST_LLM_API_KEY；密钥只继承给子进程，不写 manifest");

const childEnv = {
  ...process.env,
  OTTER_TEST_LLM_PROVIDER: model.provider,
  OTTER_TEST_LLM_MODEL: model.model,
  OTTER_TEST_LLM_BASE_URL: model.baseUrl,
};
delete childEnv.OTTER_CAPABILITY_FORCE_FAUX;
if (model.thinkingLevel === null) {
  delete childEnv.OTTER_TEST_LLM_THINKING_LEVEL;
  childEnv.OTTER_TEST_LLM_CLEAR_THINKING = "1";
} else {
  delete childEnv.OTTER_TEST_LLM_CLEAR_THINKING;
}
const localConfig = path.join(cwd, "config/config.test.local.yaml");
const configMaterial = fs.existsSync(localConfig) ? fs.readFileSync(localConfig) : Buffer.alloc(0);
const nonSecretEnv = ["OTTER_TEST_LLM_PROVIDER", "OTTER_TEST_LLM_MODEL", "OTTER_TEST_LLM_BASE_URL", "OTTER_TEST_LLM_THINKING_LEVEL", "OTTER_TEST_LLM_CLEAR_THINKING"]
  .map(key => `${key}=${childEnv[key] ?? ""}`).join("\n");
model.configSha256 = sha256(Buffer.concat([configMaterial, Buffer.from(`\n${nonSecretEnv}`)]));

fs.mkdirSync(outDir, { recursive: true });
const runId = crypto.randomUUID();
const logPath = path.join(outDir, `${runId}.log`);
const vitestResultPath = path.join(outDir, `${runId}.vitest.json`);
const manifestPath = path.join(outDir, `${runId}.json`);
const startedAt = new Date().toISOString();
const log = fs.createWriteStream(logPath, { flags: "wx" });

async function runLogged(command, args) {
  console.log(`[capability-live] $ ${[command, ...args].join(" ")}`);
  log.write(`\n$ ${[command, ...args].join(" ")}\n`);
  const child = spawn(command, args, { cwd, env: childEnv, stdio: ["inherit", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { process.stdout.write(chunk); log.write(chunk); });
  child.stderr.on("data", chunk => { process.stderr.write(chunk); log.write(chunk); });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => resolve(code ?? 1));
  });
}

console.log(`[capability-live] run=${runId} role=${role} source=${sourceSha} model=${model.provider}/${model.model}`);
const buildExit = await runLogged("npm", ["run", "build"]);
let exitCode = buildExit;
if (buildExit === 0) {
  exitCode = await runLogged("npx", [
    "vitest", "run", "--config", "vitest.capability.config.ts",
    "--reporter=default", "--reporter=json", `--outputFile.json=${vitestResultPath}`,
  ]);
}
await new Promise(resolve => log.end(resolve));
const logText = fs.readFileSync(logPath, "utf8");
const vitestResult = fs.existsSync(vitestResultPath) ? loadJson(vitestResultPath) : null;
const distWorkerPath = path.join(cwd, "dist/src/frameworks/embedding/bge-m3-worker.js");
const manifest = createRunManifest({
  role,
  sourceSha,
  mergeBaseSha,
  protocolPath,
  protocol,
  inventoryPath,
  inventory,
  distWorkerPath,
  model,
  command: "npm run build && npx vitest run --config vitest.capability.config.ts（canonical 全量）",
  logPath,
  logText,
  vitestResult,
  manualReviews,
  exitCode,
  startedAt,
  endedAt: new Date().toISOString(),
  runId,
  harnessSha: hashCapabilityHarness(cwd),
  harnessOverlay,
  overlayDiffSha256: sha256(overlayDiff),
});
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
fs.appendFileSync(path.join(outDir, "attempts.jsonl"), `${JSON.stringify({
  runId, role, sourceSha, startedAt, endedAt: manifest.endedAt, outcome: manifest.outcome,
  logSha256: manifest.log.sha256, vitestResultSha256: manifest.vitestResult?.sha256 ?? null,
  manifestSha256: sha256(fs.readFileSync(manifestPath)),
})}\n`);
console.log(`[capability-live] ${manifest.outcome} manifest=${manifestPath} logSha256=${manifest.log.sha256}`);
process.exitCode = exitCode;
