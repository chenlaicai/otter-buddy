#!/usr/bin/env node
/**
 * 真 LLM 概率行为证据：运行 manifest、采样日志解析与 base/head 非劣比较。
 * 本地运行没有 CI secret，故真实性仍由独立审视核对原始日志；本模块只保证
 * 证据结构、配置/场景可比性、哈希与预注册统计口径，不宣称本地 JSON 不可伪造。
 */
import { Buffer } from "node:buffer";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CANONICAL_INVENTORY } from "./capability-live-inventory.mjs";

export const EVIDENCE_VERSION = 1;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

/** 合入门使用仓内 canonical 常量，不用 PR 当前 JSON 自己定义“什么算 PASS”。
 *  协议演进必须同时改常量、JSON 与独立预注册审视；CI 会对不一致响亮拒判。 */
export const CANONICAL_PROTOCOL = Object.freeze({
  version: 1,
  protocolId: "capability-live-noninferiority-v1",
  alpha: 0.05,
  multipleComparisons: "bonferroni",
  runsPerSide: 17,
  executionOrder: "ABAB",
  minimumValidSamplesPerSide: 50,
  absoluteHeadSuccessFloor: 0.8,
  nonInferiorityDelta: 0.2,
  invalidSamplePolicy: "inconclusive",
  referenceModel: Object.freeze({
    provider: "openai",
    model: "deepseek-v4.1-flash",
    baseUrl: "https://st8tp3ajl0df3n8b8l8qu.apigateway-cn-beijing.volceapi.com/v1",
    thinkingLevel: null,
  }),
  notes: "50 是检测约 0.90→0.70 劣化的初始下限，不是通用充分样本量；场景可在看 head 结果前预注册更严格值，禁止事后放宽。",
});
export const CANONICAL_PROTOCOL_SHA256 = "ef873493a7ebc98038af603d909033990a0e3f4f7e8eb2e23259db93d21349ed";
export const CANONICAL_INVENTORY_SHA256 = "3dde5a4a5477967a8bd73d90e1ee00539c76ca801fbfcc264adf4c758b0c5874";
export { CANONICAL_INVENTORY };

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

export function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function validateProtocol(protocol) {
  const errors = [];
  if (protocol?.version !== 1) errors.push("protocol.version 必须为 1");
  if (protocol?.protocolId !== "capability-live-noninferiority-v1") errors.push("未知 protocolId");
  if (!(protocol?.alpha > 0 && protocol.alpha < 1)) errors.push("alpha 必须在 (0,1)");
  if (protocol?.multipleComparisons !== "bonferroni") errors.push("当前只支持预注册 Bonferroni 多重比较");
  if (!Number.isInteger(protocol?.runsPerSide) || protocol.runsPerSide < 1) errors.push("runsPerSide 必须预注册为正整数");
  if (protocol?.executionOrder !== "ABAB") errors.push("当前只支持 base/head ABAB 交错执行");
  if (!Number.isInteger(protocol?.minimumValidSamplesPerSide) || protocol.minimumValidSamplesPerSide < 1) {
    errors.push("minimumValidSamplesPerSide 必须为正整数");
  }
  if (!(protocol?.absoluteHeadSuccessFloor >= 0 && protocol.absoluteHeadSuccessFloor <= 1)) {
    errors.push("absoluteHeadSuccessFloor 必须在 [0,1]");
  }
  if (!(protocol?.nonInferiorityDelta > 0 && protocol.nonInferiorityDelta <= 1)) {
    errors.push("nonInferiorityDelta 必须在 (0,1]");
  }
  if (protocol?.invalidSamplePolicy !== "inconclusive") errors.push("无效样本必须导向 INCONCLUSIVE");
  for (const field of ["provider", "model", "baseUrl"]) {
    if (typeof protocol?.referenceModel?.[field] !== "string" || !protocol.referenceModel[field]) errors.push(`referenceModel.${field} 必须预注册`);
  }
  return errors;
}

export function validateRunInventory(run, inventory) {
  const errors = [];
  const sorted = values => [...(values ?? [])].sort();
  if (JSON.stringify(sorted(run.actualTests ?? [])) !== JSON.stringify(sorted(inventory.testFullNames))) errors.push("实际 62 项测试与 canonical inventory 不一致");
  if (JSON.stringify(sorted((run.scenarios ?? []).map(item => item.id))) !== JSON.stringify(sorted(inventory.sampledScenarioIds))) errors.push("实际采样场景与 canonical inventory 不一致");
  if (JSON.stringify(sorted((run.manualReviews ?? []).map(item => item.id))) !== JSON.stringify(sorted(inventory.manualReviewIds))) errors.push("人工场景与 canonical inventory 不一致");
  if (JSON.stringify(sorted(run.undeclaredSkips ?? [])) !== JSON.stringify(sorted(inventory.declaredSkippedTestFullNames))) errors.push("skip 集合不等于 canonical 声明期 skip");
  return errors;
}

/** 解析 expectSampledBehavior 的公开输出；SKIP 不计成功也不计有效样本。 */
export function parseCapabilitySamples(logText) {
  const scenarios = [];
  const re = /\[capability\]\s+(.+?)\s+采样结果（(\d+)\/(\d+)\s+成功(?:，SKIP\s+(\d+)\s+个)?(?:，INVALID\s+(\d+)\s+个)?）/g;
  for (const match of logText.matchAll(re)) {
    scenarios.push({
      id: match[1].trim(),
      successes: Number(match[2]),
      valid: Number(match[3]),
      skipped: Number(match[4] ?? 0),
      invalid: Number(match[5] ?? 0),
    });
  }
  const duplicate = scenarios.find((item, index) => scenarios.findIndex(other => other.id === item.id) !== index);
  if (duplicate) throw new Error(`采样场景 ID 重复，拒绝猜测归属: ${duplicate.id}`);
  return scenarios;
}

export function hashCapabilityHarness(root) {
  const files = [];
  function walk(dir, relative) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const rel = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile() && /\.(?:ts|json)$/.test(entry.name)) files.push([rel, sha256File(full)]);
    }
  }
  walk(path.join(root, "tests/capability"), "tests/capability");
  walk(path.join(root, "tests/helpers"), "tests/helpers");
  for (const file of [
    "vitest.capability.config.ts", "config/config.test.yaml", "package.json", "package-lock.json",
    "scripts/capability-live-evidence.mjs", "scripts/run-capability-live.mjs", "scripts/compare-capability-live.mjs",
    "scripts/capability-live-inventory.mjs", "scripts/attach-capability-manual-review.mjs",
  ]) {
    if (fs.existsSync(path.join(root, file))) files.push([file, sha256File(path.join(root, file))]);
  }
  files.sort(([a], [b]) => a.localeCompare(b));
  return sha256(files.map(([file, hash]) => `${file}\0${hash}\n`).join(""));
}

export function createRunManifest({
  role,
  sourceSha,
  mergeBaseSha,
  protocolPath,
  protocol,
  inventoryPath,
  inventory,
  distWorkerPath,
  distWorkerSha256,
  model,
  command,
  logPath,
  logText,
  vitestResult,
  manualReviews = {},
  exitCode,
  startedAt,
  endedAt,
  runId,
  harnessSha,
  harnessOverlay,
  overlayDiffSha256,
}) {
  const scenarios = parseCapabilitySamples(logText);
  const manualReviewIds = [...logText.matchAll(/MANUAL_REVIEW:\s*([^\s]+)/g)].map(match => match[1]).sort();
  const manualInvalid = manualReviewIds.some(id => !["pass", "fail"].includes(manualReviews[id]?.verdict) || !manualReviews[id]?.judged_by) ||
    Object.keys(manualReviews).some(id => !manualReviewIds.includes(id));
  const manualFailed = manualReviewIds.some(id => manualReviews[id]?.verdict === "fail");
  const files = vitestResult?.testResults ?? [];
  const assertions = files.flatMap(file => file.assertionResults ?? []);
  const failed = assertions.filter(item => item.status === "failed");
  const hasError = (item, name) => (item.failureMessages ?? []).some(message => message.includes(name));
  const invalidFailures = failed.filter(item => hasError(item, "CapabilityInvalidSampleError") || /Test timed out|Hook timed out/.test((item.failureMessages ?? []).join("\n")));
  const sampleFailures = failed.filter(item => hasError(item, "CapabilitySampleThresholdError"));
  const hardFailures = failed.filter(item => !invalidFailures.includes(item) && !sampleFailures.includes(item));
  const fileFailures = files.filter(file => file.status === "failed" && !(file.assertionResults ?? []).some(item => item.status === "failed"));
  const pending = assertions.filter(item => ["pending", "skipped", "todo"].includes(item.status));
  const actualTests = assertions.map(item => item.fullName).sort();
  const undeclaredSkips = pending.map(item => item.fullName);
  const inventoryErrors = validateRunInventory({
    actualTests, scenarios, undeclaredSkips,
    manualReviews: manualReviewIds.map(id => ({ id })),
  }, inventory);
  const unexplainedExit = exitCode !== 0 && failed.length > 0 && sampleFailures.length !== failed.length;
  const invalid = scenarios.some(item => item.skipped > 0 || item.invalid > 0) || invalidFailures.length > 0 ||
    !vitestResult || (exitCode === 0 && failed.length > 0) || (exitCode !== 0 && failed.length === 0) || unexplainedExit ||
    vitestResult.numFailedTests !== failed.length;
  const outcome = hardFailures.length > 0 || fileFailures.length > 0 || manualFailed ? "FAIL"
    : invalid || inventoryErrors.length > 0 || manualInvalid ? "INCONCLUSIVE" : "COMPLETE";
  return {
    version: EVIDENCE_VERSION,
    kind: "capability-live-run",
    runId,
    role,
    sourceSha,
    mergeBaseSha,
    startedAt,
    endedAt,
    exitCode,
    outcome,
    executionInvalid: invalid,
    hardFailures: [...hardFailures.map(item => item.fullName), ...fileFailures.map(file => `file/hook: ${file.name}`)],
    invalidFailures: invalidFailures.map(item => item.fullName),
    inventoryErrors,
    sampleThresholdFailures: sampleFailures.map(item => item.fullName),
    actualTests,
    undeclaredSkips,
    manualReviews: manualReviewIds.map(id => ({ id, ...manualReviews[id] })),
    protocol: {
      id: protocol.protocolId,
      sha256: sha256(fs.readFileSync(protocolPath)),
    },
    inventory: { sha256: sha256(fs.readFileSync(inventoryPath)) },
    distWorkerSha256: distWorkerSha256 ?? (fs.existsSync(distWorkerPath) ? sha256(fs.readFileSync(distWorkerPath)) : null),
    model,
    harness: { sha256: harnessSha, overlay: harnessOverlay, overlayDiffSha256 },
    command,
    log: { path: path.basename(logPath), sha256: sha256(logText), bytes: Buffer.byteLength(logText) },
    vitestResult: vitestResult ? { sha256: sha256(JSON.stringify(vitestResult)), total: vitestResult.numTotalTests, failed: vitestResult.numFailedTests } : null,
    scenarios,
  };
}

function normalCdf(x) {
  // Abramowitz-Stegun 7.1.26；统计判定只需 double 精度的稳定近似。
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * z);
  const erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z));
  return 0.5 * (1 + erf);
}

export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new Error("normalQuantile p 必须在 (0,1)");
  let lo = -10;
  let hi = 10;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function wilsonInterval(successes, n, z) {
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const radius = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / denominator;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

/** Newcombe hybrid-score 差值区间；Bonferroni z 已含场景族多重比较。 */
export function compareScenario(base, head, protocol, scenarioCount) {
  const required = protocol.minimumValidSamplesPerSide;
  const result = {
    id: head.id,
    base: { successes: base.successes, valid: base.valid },
    head: { successes: head.successes, valid: head.valid },
    requiredPerSide: required,
    status: "INCONCLUSIVE",
    reason: "",
  };
  if (base.skipped || head.skipped || base.invalid || head.invalid) {
    result.reason = "存在 SKIP/INVALID 样本；不得缩减分母后凑阈值";
    return result;
  }
  if (base.valid < required || head.valid < required) {
    result.reason = `有效样本不足 ${required}/侧，只能判 INCONCLUSIVE`;
    return result;
  }
  const headRate = head.successes / head.valid;
  result.headRate = headRate;
  result.absoluteFloor = protocol.absoluteHeadSuccessFloor;
  if (headRate < protocol.absoluteHeadSuccessFloor) {
    result.status = "FAIL";
    result.reason = `head 观测成功率 ${headRate.toFixed(3)} 低于绝对底线 ${protocol.absoluteHeadSuccessFloor}`;
    return result;
  }
  const z = normalQuantile(1 - protocol.alpha / (2 * scenarioCount));
  const [baseLow, baseHigh] = wilsonInterval(base.successes, base.valid, z);
  const [headLow, headHigh] = wilsonInterval(head.successes, head.valid, z);
  const baseRate = base.successes / base.valid;
  const difference = headRate - baseRate;
  const lower = difference - Math.sqrt((headRate - headLow) ** 2 + (baseHigh - baseRate) ** 2);
  const upper = difference + Math.sqrt((headHigh - headRate) ** 2 + (baseRate - baseLow) ** 2);
  result.difference = difference;
  result.differenceCi = [lower, upper];
  result.nonInferiorityMargin = -protocol.nonInferiorityDelta;
  if (upper < -protocol.nonInferiorityDelta) {
    result.status = "FAIL";
    result.reason = "差值区间整体低于非劣界限，确认劣化";
  } else if (lower > -protocol.nonInferiorityDelta) {
    result.status = "PASS";
    result.reason = "达到绝对底线，且差值区间下限高于非劣界限";
  } else {
    result.reason = "未确认劣化，但非劣区间跨界限，证据不足";
  }
  return result;
}

function validateRun(run, role) {
  const errors = [];
  if (run?.version !== EVIDENCE_VERSION || run.kind !== "capability-live-run") errors.push("run manifest 版本/kind 非法");
  if (run.role !== role) errors.push(`run.role 必须为 ${role}`);
  if (!SHA_RE.test(run.sourceSha ?? "")) errors.push("sourceSha 必须为完整 commit");
  if (!SHA_RE.test(run.mergeBaseSha ?? "")) errors.push("mergeBaseSha 必须为完整 commit");
  if (!/^[0-9a-f-]{36}$/.test(run.runId ?? "")) errors.push("runId 非法");
  if (!SHA256_RE.test(run.protocol?.sha256 ?? "")) errors.push("protocol sha256 非法");
  if (!SHA256_RE.test(run.inventory?.sha256 ?? "")) errors.push("inventory sha256 非法");
  if (!SHA256_RE.test(run.distWorkerSha256 ?? "")) errors.push("dist worker sha256 非法");
  if (!SHA256_RE.test(run.harness?.sha256 ?? "")) errors.push("harness sha256 非法");
  if (!SHA256_RE.test(run.log?.sha256 ?? "") || !Number.isInteger(run.log?.bytes)) errors.push("log 哈希/大小非法");
  if (!Number.isFinite(Date.parse(run.startedAt)) || !Number.isFinite(Date.parse(run.endedAt)) || Date.parse(run.startedAt) >= Date.parse(run.endedAt)) {
    errors.push("startedAt/endedAt 非法，无法验证串行 ABAB 顺序");
  }
  if (!Array.isArray(run.scenarios) || run.scenarios.length === 0) errors.push("run 没有可比较采样场景");
  else if (new Set(run.scenarios.map(item => item.id)).size !== run.scenarios.length) errors.push("同一 run 内场景 ID 重复");
  if (!SHA256_RE.test(run.vitestResult?.sha256 ?? "")) errors.push("缺 Vitest JSON 结果哈希，无法区分行为失败与执行无效");
  if (!Array.isArray(run.manualReviews)) errors.push("manualReviews 必须显式登记（无人工场景则为空数组）");
  if (typeof run.executionInvalid !== "boolean") errors.push(`${role} 缺 executionInvalid 布尔字段；旧 manifest 不兼容，fail-closed`);
  if (run.executionInvalid === true) errors.push(`${role} executionInvalid=true，任何 outcome 都不得进入比较`);
  if (run.outcome === "COMPLETE" && ((run.hardFailures?.length ?? 0) > 0 || (run.invalidFailures?.length ?? 0) > 0 || (run.inventoryErrors?.length ?? 0) > 0)) {
    errors.push("COMPLETE 与 hard/invalid/skip 明细矛盾");
  }
  if (role === "head" && run.outcome !== "COMPLETE") errors.push(`head run=${run.outcome}，硬门失败或执行无效，不能进入概率比较`);
  if (role === "base" && !["COMPLETE", "FAIL"].includes(run.outcome)) errors.push(`base run=${run.outcome} 执行无效，不能估计基线`);
  if (role === "base" && run.outcome === "FAIL" && ((run.invalidFailures?.length ?? 0) > 0 || (run.inventoryErrors?.length ?? 0) > 0 || (run.hardFailures?.length ?? 0) + (run.manualReviews?.filter(item => item.verdict === "fail").length ?? 0) === 0)) {
    errors.push("base FAIL 只能来自明确硬/人工能力缺陷，不能携带 INVALID 或 inventory 缺口");
  }
  return errors;
}

function stableModel(run) {
  const model = run?.model ?? {};
  return {
    provider: model.provider,
    model: model.model,
    baseUrl: model.baseUrl,
    thinkingLevel: model.thinkingLevel ?? null,
    configSha256: model.configSha256,
  };
}

export function compareCapabilityEvidence(baseInput, headInput, protocol) {
  const baseRuns = (Array.isArray(baseInput) ? baseInput : [baseInput]).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const headRuns = (Array.isArray(headInput) ? headInput : [headInput]).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const errors = [
    ...validateProtocol(protocol),
    ...baseRuns.flatMap(run => validateRun(run, "base")),
    ...headRuns.flatMap(run => validateRun(run, "head")),
  ];
  if (baseRuns.length !== protocol.runsPerSide || headRuns.length !== protocol.runsPerSide) {
    errors.push(`每侧必须恰好 ${protocol.runsPerSide} 轮预注册完整运行；少跑/额外抽奖重跑均拒判`);
  }
  const allIds = [...baseRuns, ...headRuns].map(run => run.runId);
  if (new Set(allIds).size !== allIds.length) errors.push("runId 重复：不能把同一轮复制成多样本");
  for (let i = 0; i < Math.min(baseRuns.length, headRuns.length); i++) {
    if (!(Date.parse(baseRuns[i].startedAt) < Date.parse(baseRuns[i].endedAt) && Date.parse(baseRuns[i].endedAt) <= Date.parse(headRuns[i].startedAt))) {
      errors.push(`第 ${i + 1} 对不是串行 base→head（含 endedAt）顺序`);
    }
    if (i + 1 < baseRuns.length && !(Date.parse(headRuns[i].startedAt) < Date.parse(headRuns[i].endedAt) && Date.parse(headRuns[i].endedAt) <= Date.parse(baseRuns[i + 1].startedAt))) {
      errors.push(`第 ${i + 1} 对之后未按 ABAB 进入下一 base`);
    }
  }
  const anchorBase = baseRuns[0];
  const anchorHead = headRuns[0];
  for (const run of [...baseRuns.slice(1), ...headRuns.slice(1)]) {
    const anchor = run.role === "base" ? anchorBase : anchorHead;
    if (run.sourceSha !== anchor.sourceSha || run.mergeBaseSha !== anchor.mergeBaseSha) errors.push("同侧 source/base SHA 不一致");
    if (run.protocol?.sha256 !== anchor.protocol?.sha256) errors.push("同侧协议文件哈希不一致");
    if (run.harness?.sha256 !== anchor.harness?.sha256) errors.push("同侧 harness/断言哈希不一致");
    if (run.inventory?.sha256 !== anchor.inventory?.sha256) errors.push("同侧 inventory 哈希不一致");
    if (run.distWorkerSha256 !== anchor.distWorkerSha256) errors.push("同侧干净构建产物哈希不一致");
    if (JSON.stringify(stableModel(run)) !== JSON.stringify(stableModel(anchor))) errors.push("同侧模型配置指纹不一致");
    if (JSON.stringify(run.manualReviews) !== JSON.stringify(anchor.manualReviews)) errors.push("同侧人工评审 verdict 不一致");
  }
  if (anchorBase?.protocol?.id !== protocol.protocolId || anchorHead?.protocol?.id !== protocol.protocolId) errors.push("两侧 protocolId 不一致");
  if (anchorBase?.protocol?.sha256 !== anchorHead?.protocol?.sha256) errors.push("两侧协议文件哈希不一致");
  if (anchorBase?.harness?.sha256 !== anchorHead?.harness?.sha256) errors.push("两侧 harness/场景/断言哈希不一致");
  if (anchorBase?.inventory?.sha256 !== anchorHead?.inventory?.sha256) errors.push("两侧完整场景 inventory 哈希不一致");
  if (JSON.stringify(stableModel(anchorBase)) !== JSON.stringify(stableModel(anchorHead))) errors.push("两侧模型/provider/解码配置指纹不一致");
  for (const [field, expected] of Object.entries(protocol.referenceModel ?? {})) {
    if (stableModel(anchorHead)[field] !== expected) errors.push(`head 不是预注册参考模型：${field} 应为 ${expected}`);
  }
  const manualComparable = run => (run?.manualReviews ?? []).map(item => ({ id: item.id, judged_by: item.judged_by }));
  if (JSON.stringify(manualComparable(anchorBase)) !== JSON.stringify(manualComparable(anchorHead))) errors.push("两侧人工评审场景/责任人不一致");
  if (anchorBase?.sourceSha === anchorHead?.sourceSha) errors.push("base/head sourceSha 不能相同");
  if (anchorBase?.mergeBaseSha !== anchorHead?.mergeBaseSha || anchorBase?.mergeBaseSha !== anchorBase?.sourceSha) errors.push("base 必须等于共同 merge-base");

  const aggregate = runs => {
    const map = new Map();
    const missing = new Set();
    const ids = [...new Set(runs.flatMap(run => run.scenarios?.map(item => item.id) ?? []))];
    for (const id of ids) {
      const rows = runs.map(run => run.scenarios.find(item => item.id === id));
      if (rows.some(row => !row)) missing.add(id);
      const present = rows.filter(Boolean);
      map.set(id, {
        id,
        successes: present.reduce((sum, row) => sum + row.successes, 0),
        valid: present.reduce((sum, row) => sum + row.valid, 0),
        skipped: present.reduce((sum, row) => sum + row.skipped, 0),
        invalid: present.reduce((sum, row) => sum + (row.invalid ?? 0), 0),
      });
    }
    return { map, missing };
  };
  const baseAgg = aggregate(baseRuns);
  const headAgg = aggregate(headRuns);
  const ids = [...new Set([...baseAgg.map.keys(), ...headAgg.map.keys()])].sort();
  const scenarios = ids.map(id => {
    const b = baseAgg.map.get(id);
    const h = headAgg.map.get(id);
    if (!b || !h || baseAgg.missing.has(id) || headAgg.missing.has(id)) {
      return { id, status: "FAIL", reason: "场景在某一轮/某一侧缺失，禁止静默消失或只取共同子集" };
    }
    return compareScenario(b, h, protocol, ids.length);
  });
  const outcome = errors.length ? "BLOCKED" : scenarios.some(item => item.status === "FAIL") ? "FAIL"
    : scenarios.length > 0 && scenarios.every(item => item.status === "PASS") ? "PASS" : "INCONCLUSIVE";
  return {
    version: 1,
    kind: "capability-live-comparison",
    outcome,
    protocolId: protocol.protocolId,
    protocol,
    base: { runIds: baseRuns.map(run => run.runId), sourceSha: anchorBase?.sourceSha, logSha256: baseRuns.map(run => run.log?.sha256), runs: baseRuns },
    head: { runIds: headRuns.map(run => run.runId), sourceSha: anchorHead?.sourceSha, logSha256: headRuns.map(run => run.log?.sha256), runs: headRuns },
    model: stableModel(anchorHead),
    harnessSha256: anchorHead?.harness?.sha256,
    scenarioCount: ids.length,
    scenarios,
    errors,
  };
}

export function validateComparison(comparison, { expectedHead, expectedBase, expectedProtocol, expectedProtocolSha, expectedInventory, expectedInventorySha, expectedHarnessSha } = {}) {
  const errors = [];
  if (comparison?.kind !== "capability-live-comparison" || comparison.version !== 1) errors.push("comparison 版本/kind 非法");
  if (comparison.outcome !== "PASS") errors.push(`真 LLM 非劣证据为 ${comparison.outcome ?? "缺失"}，不是 PASS`);
  if (expectedHead && comparison.head?.sourceSha !== expectedHead) errors.push("comparison head 不是当前 HEAD");
  if (expectedBase && comparison.base?.sourceSha !== expectedBase) errors.push("comparison base 不是当前 merge-base");
  if (!Array.isArray(comparison.scenarios) || comparison.scenarios.length === 0) errors.push("comparison 没有场景明细");
  if (comparison.scenarios?.some(item => item.status !== "PASS")) errors.push("comparison 内仍有非 PASS 场景");
  if (expectedProtocol && JSON.stringify(comparison.protocol) !== JSON.stringify(expectedProtocol)) errors.push("comparison 使用了不同的预注册协议");
  if (expectedProtocolSha && [...(comparison.base?.runs ?? []), ...(comparison.head?.runs ?? [])].some(run => run.protocol?.sha256 !== expectedProtocolSha)) errors.push("comparison 未绑定 canonical protocol 文件哈希");
  const allRuns = [...(comparison.base?.runs ?? []), ...(comparison.head?.runs ?? [])];
  if (expectedInventorySha && allRuns.some(run => run.inventory?.sha256 !== expectedInventorySha)) errors.push("comparison 未绑定 canonical 完整场景 inventory");
  if (expectedInventory) for (const run of allRuns) errors.push(...validateRunInventory(run, expectedInventory));
  if (expectedHarnessSha && comparison.harnessSha256 !== expectedHarnessSha) errors.push("comparison harness 不是当前 HEAD 的实际 harness 指纹");
  try {
    const recomputed = compareCapabilityEvidence(comparison.base.runs, comparison.head.runs, comparison.protocol);
    if (JSON.stringify(recomputed) !== JSON.stringify({ ...comparison, errors: [] })) {
      errors.push("comparison 明细与内嵌 base/head run 重算不一致");
    }
  } catch (error) {
    errors.push(`comparison 无法重算: ${error.message}`);
  }
  return errors;
}
