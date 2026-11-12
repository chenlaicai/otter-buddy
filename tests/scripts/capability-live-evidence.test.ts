import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  CANONICAL_INVENTORY,
  CANONICAL_INVENTORY_SHA256,
  CANONICAL_PROTOCOL,
  CANONICAL_PROTOCOL_SHA256,
  compareCapabilityEvidence,
  createRunManifest,
  hashCapabilityHarness,
  normalQuantile,
  parseCapabilitySamples,
  sha256,
  validateComparison,
  wilsonInterval,
} from "../../scripts/capability-live-evidence.mjs";
import { checkCapabilityEvidence } from "../../scripts/check-capability-change.mjs";
import type { RunManifest } from "../../scripts/capability-live-evidence.mjs";

const protocol = {
  version: 1,
  protocolId: "capability-live-noninferiority-v1",
  alpha: 0.05,
  multipleComparisons: "bonferroni",
  runsPerSide: 1,
  executionOrder: "ABAB",
  minimumValidSamplesPerSide: 50,
  absoluteHeadSuccessFloor: 0.8,
  nonInferiorityDelta: 0.2,
  invalidSamplePolicy: "inconclusive",
  referenceModel: { provider: "openai", model: "model-x", baseUrl: "https://example.invalid/v1", thinkingLevel: null },
};

function scenario(successes: number, valid = 50, skipped = 0) {
  return { id: "R4 召唤前先搜", successes, valid, skipped, invalid: 0 };
}

function run(role: "base" | "head", successes: number, valid = 50, skipped = 0): RunManifest {
  return {
    version: 1,
    kind: "capability-live-run",
    runId: role === "base" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222",
    role,
    sourceSha: role === "base" ? "a".repeat(40) : "b".repeat(40),
    mergeBaseSha: "a".repeat(40),
    startedAt: role === "base" ? "2026-11-12T00:00:00Z" : "2026-11-12T00:01:00Z",
    endedAt: role === "base" ? "2026-11-12T00:00:30Z" : "2026-11-12T00:01:30Z",
    outcome: "COMPLETE", executionInvalid: false, exitCode: successes < valid ? 1 : 0, command: "canonical-test",
    protocol: { id: protocol.protocolId, sha256: "c".repeat(64) },
    inventory: { sha256: "9".repeat(64) }, distWorkerSha256: "8".repeat(64),
    model: {
      provider: "openai", model: "model-x", baseUrl: "https://example.invalid/v1",
      thinkingLevel: null, configSha256: "d".repeat(64),
    },
    harness: { sha256: "e".repeat(64), overlay: role === "base", overlayDiffSha256: "7".repeat(64) },
    log: { path: `${role}.log`, sha256: "f".repeat(64), bytes: 100 },
    vitestResult: { sha256: "0".repeat(64), total: 1, failed: successes < valid ? 1 : 0 },
    manualReviews: [],
    hardFailures: [], invalidFailures: [], undeclaredSkips: [], inventoryErrors: [],
    sampleThresholdFailures: [], actualTests: [],
    scenarios: [scenario(successes, valid, skipped)],
  };
}

function canonicalRuns(role: "base" | "head", harnessSha = "e".repeat(64)) {
  return Array.from({ length: CANONICAL_PROTOCOL.runsPerSide }, (_, index) => {
    const item: RunManifest = run(role, 45);
    const pairStart = Date.parse("2026-11-12T00:00:00Z") + index * 120_000;
    const start = pairStart + (role === "head" ? 60_000 : 0);
    item.runId = `00000${role === "base" ? "1" : "2"}${String(index).padStart(2, "0")}-0000-4000-8000-000000000000`;
    item.startedAt = new Date(start).toISOString();
    item.endedAt = new Date(start + 60_000).toISOString();
    item.protocol = { id: CANONICAL_PROTOCOL.protocolId, sha256: CANONICAL_PROTOCOL_SHA256 };
    item.inventory = { sha256: CANONICAL_INVENTORY_SHA256 };
    item.harness.sha256 = harnessSha;
    item.actualTests = [...CANONICAL_INVENTORY.testFullNames];
    item.scenarios = CANONICAL_INVENTORY.sampledScenarioIds.map(id => ({ id, successes: 45, valid: 50, skipped: 0, invalid: 0 }));
    item.manualReviews = CANONICAL_INVENTORY.manualReviewIds.map(id => ({ id, verdict: "pass", judged_by: "独立检视獭" }));
    item.undeclaredSkips = [...CANONICAL_INVENTORY.declaredSkippedTestFullNames];
    item.vitestResult = { sha256: "0".repeat(64), total: 62, failed: 0 };
    item.model = { ...CANONICAL_PROTOCOL.referenceModel, configSha256: "d".repeat(64) };
    return item;
  });
}

describe("真 LLM 采样证据", () => {
  it("解析原始成功/有效/SKIP，不把控制台 PASS 当统计输入", () => {
    expect(parseCapabilitySamples(`[capability] R4 召唤前先搜 采样结果（2/3 成功，SKIP 1 个）:\n#1 OK`)).toEqual([
      { id: "R4 召唤前先搜", successes: 2, valid: 3, skipped: 1, invalid: 0 },
    ]);
  });

  it("重复场景 ID 响亮拒绝，不猜测合并", () => {
    const line = "[capability] same 采样结果（1/3 成功）:";
    expect(() => parseCapabilitySamples(`${line}\n${line}`)).toThrow("重复");
  });

  it("正态分位与 Wilson 区间有已知锚点", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.95996, 4);
    const [low, high] = wilsonInterval(50, 100, 1.95996);
    expect(low).toBeCloseTo(0.4038, 3);
    expect(high).toBeCloseTo(0.5962, 3);
  });
});

describe("运行完整性分类", () => {
  const baseInput = {
    role: "head", sourceSha: "b".repeat(40), mergeBaseSha: "a".repeat(40),
    protocol, model: {}, command: "npx vitest", logPath: "/tmp/x.log",
    logText: "[capability] R4 采样结果（40/50 成功）:", exitCode: 1,
    startedAt: "2026-11-12T00:00:00Z", endedAt: "2026-11-12T00:01:00Z",
    runId: "22222222-2222-4222-8222-222222222222", harnessSha: "e".repeat(64), harnessOverlay: false,
  };
  function result(title: string, status = "failed", errorName = "CapabilitySampleThresholdError") {
    return { numTotalTests: 1, numFailedTests: status === "failed" ? 1 : 0,
      testResults: [{ status, assertionResults: [{ title, fullName: title, status,
        failureMessages: status === "failed" ? [`${errorName}: failed`] : [] }] }] };
  }
  function manifest(input: Record<string, unknown>) {
    const protocolPath = path.join(process.cwd(), "tests/capability/live-protocol.json");
    const inventoryPath = path.join(process.cwd(), "tests/capability/live-inventory.json");
    const vitest = input.vitestResult as { testResults: Array<{ assertionResults: Array<{ fullName: string; status: string }> }> };
    const logText = String(input.logText ?? baseInput.logText);
    const inventory = {
      testFullNames: vitest.testResults.flatMap(file => file.assertionResults.map(item => item.fullName)),
      sampledScenarioIds: [...logText.matchAll(/\[capability\]\s+(.+?)\s+采样结果/g)].map(match => match[1]),
      manualReviewIds: [...logText.matchAll(/MANUAL_REVIEW:\s*([^\s]+)/g)].map(match => match[1]),
      declaredSkippedTestFullNames: [],
    };
    return createRunManifest({
      ...baseInput, ...input, protocolPath, inventoryPath, inventory: input.inventory ?? inventory,
      distWorkerPath: path.join(process.cwd(), "dist/src/frameworks/embedding/bge-m3-worker.js"),
    });
  }
  it("完整跑完但概率行为失败仍可比较，不偷保留一次全绿前提", () => {
    expect(manifest({ vitestResult: result("R4（3 次采样 ≥1）") }).outcome).toBe("COMPLETE");
  });
  it("确定性硬门失败与 undeclared skip 不进入概率比较", () => {
    expect(manifest({ vitestResult: result("durable 只读当前世代", "failed", "Error") }).outcome).toBe("FAIL");
    expect(manifest({ vitestResult: result("某场景", "pending") }).outcome).toBe("INCONCLUSIVE");
  });
  it("只有精确声明期 skip 合法，其他 pending 仍无效", () => {
    const vitestResult = result("声明 skip", "pending");
    expect(manifest({ vitestResult, exitCode: 0 }).outcome).toBe("INCONCLUSIVE");
    expect(manifest({
      vitestResult, exitCode: 0,
      inventory: { testFullNames: ["声明 skip"], sampledScenarioIds: ["R4"], manualReviewIds: [], declaredSkippedTestFullNames: ["声明 skip"] },
    }).outcome).toBe("COMPLETE");
  });

  it("文件/hook 失败与 invoke 超时是硬失败/无效，不看标题猜", () => {
    const hook = { numTotalTests: 0, numFailedTests: 1, testResults: [{ name: "x.ts", status: "failed", assertionResults: [] }] };
    expect(manifest({ vitestResult: hook }).outcome).toBe("FAIL");
    expect(manifest({ vitestResult: result("任意标题", "failed", "CapabilityInvalidSampleError") }).outcome).toBe("INCONCLUSIVE");
    expect(manifest({ vitestResult: result("全部 passed", "passed"), exitCode: 1 }).outcome).toBe("INCONCLUSIVE");
  });

  it("采样+硬失败可完整解释非零退出，不错标 executionInvalid", () => {
    const assertions = [
      { title: "行为", fullName: "行为", status: "failed", failureMessages: ["CapabilitySampleThresholdError: x"] },
      { title: "硬门", fullName: "硬门", status: "failed", failureMessages: ["AssertionError: y"] },
    ];
    const vitestResult = { numTotalTests: 2, numFailedTests: 2,
      testResults: [{ status: "failed", assertionResults: assertions }] };
    const run = manifest({ vitestResult });
    expect(run.outcome).toBe("FAIL");
    expect(run.executionInvalid).toBe(false);
  });

  it("完整 inventory 多一个/少一个场景都使运行无效", () => {
    const vitestResult = result("R4（3 次采样 ≥1）");
    expect(manifest({ vitestResult, inventory: { testFullNames: [], sampledScenarioIds: [], manualReviewIds: [] } }).outcome).toBe("INCONCLUSIVE");
  });

  it("manual review 未判决或缺责任人不能静默通过", () => {
    const logText = "[capability] R4 采样结果（40/50 成功）:\nMANUAL_REVIEW: seriousness-mode-switch 采样信号";
    expect(manifest({ logText, vitestResult: result("R4（3 次采样 ≥1）") }).outcome).toBe("INCONCLUSIVE");
    expect(manifest({
      logText, vitestResult: result("R4（3 次采样 ≥1）"),
      manualReviews: { "seriousness-mode-switch": { verdict: "pass", judged_by: "独立检视獭" } },
    }).outcome).toBe("COMPLETE");
  });
});

describe("base/head 非劣比较", () => {
  it("绝对底线与非劣区间同时满足才 PASS", () => {
    const result = compareCapabilityEvidence(run("base", 45), run("head", 45), protocol);
    expect(result.outcome).toBe("PASS");
    expect(result.scenarios[0].differenceCi?.[0]).toBeGreaterThan(-0.2);
  });

  it("n=3 即使 3/3 也只能 INCONCLUSIVE，不能冒充分布证明", () => {
    const result = compareCapabilityEvidence(run("base", 3, 3), run("head", 3, 3), protocol);
    expect(result.outcome).toBe("INCONCLUSIVE");
    expect(result.scenarios[0].reason).toContain("有效样本不足");
  });

  it("SKIP 不缩分母凑阈值，直接 INCONCLUSIVE", () => {
    const result = compareCapabilityEvidence(run("base", 50, 50), run("head", 1, 1, 49), protocol);
    expect(result.outcome).toBe("INCONCLUSIVE");
    expect(result.scenarios[0].reason).toContain("SKIP");
  });

  it("head 跌破绝对底线是 FAIL，即使 base 更差", () => {
    const result = compareCapabilityEvidence(run("base", 20), run("head", 35), protocol);
    expect(result.outcome).toBe("FAIL");
    expect(result.scenarios[0].reason).toContain("绝对底线");
  });

  it("区间跨非劣界限不能猜 PASS", () => {
    const result = compareCapabilityEvidence(run("base", 25), run("head", 45), protocol);
    expect(result.outcome).toBe("PASS"); // 改善场景不惩罚
    const symmetric = compareCapabilityEvidence(run("base", 25), run("head", 40), protocol);
    expect(symmetric.outcome).toBe("PASS");
    const uncertain = compareCapabilityEvidence(run("base", 45), run("head", 40), protocol);
    expect(uncertain.outcome).toBe("INCONCLUSIVE");
  });

  it("预注册多轮必须数量精确、runId 唯一且 ABAB 交错", () => {
    const p = { ...protocol, runsPerSide: 2 };
    const b1 = run("base", 45);
    const h1 = run("head", 45);
    const b2 = run("base", 45);
    const h2 = run("head", 45);
    b2.runId = "33333333-3333-4333-8333-333333333333";
    h2.runId = "44444444-4444-4444-8444-444444444444";
    b2.startedAt = "2026-11-12T00:02:00Z"; b2.endedAt = "2026-11-12T00:02:30Z";
    h2.startedAt = "2026-11-12T00:03:00Z"; h2.endedAt = "2026-11-12T00:03:30Z";
    expect(compareCapabilityEvidence([b1, b2], [h1, h2], p).outcome).toBe("PASS");
    expect(compareCapabilityEvidence([b1], [h1], p).outcome).toBe("BLOCKED");
    expect(compareCapabilityEvidence([b1, b2], [h1, { ...h2, runId: h1.runId }], p).outcome).toBe("BLOCKED");
    expect(compareCapabilityEvidence([b1, b2], [h1, { ...h2, startedAt: "2026-11-12T00:01:30Z" }], p).outcome).toBe("BLOCKED");
    expect(compareCapabilityEvidence([b1, b2], [{ ...h1, endedAt: "2026-11-12T10:00:00Z" }, h2], p).outcome).toBe("BLOCKED");
  });

  it("base 可有明确硬缺陷，head 必须零硬失败；INVALID 基线仍拒判", () => {
    const base = run("base", 45);
    base.outcome = "FAIL"; base.hardFailures = ["旧 identity wire 缺失"];
    expect(compareCapabilityEvidence(base, run("head", 45), protocol).outcome).toBe("PASS");
    const invalidBase = run("base", 45);
    invalidBase.outcome = "FAIL"; invalidBase.hardFailures = ["旧 identity wire 缺失"];
    invalidBase.invalidFailures = ["429 quota"];
    expect(compareCapabilityEvidence(invalidBase, run("head", 45), protocol).outcome).toBe("BLOCKED");
    expect(compareCapabilityEvidence(run("base", 45), { ...run("head", 45), outcome: "FAIL", hardFailures: ["新硬失败"] }, protocol).outcome).toBe("BLOCKED");
    for (const kind of ["exit0-failed", "abnormal-exit", "count-mismatch"]) {
      const invalid = { ...run("base", 45), outcome: "FAIL", hardFailures: [kind], executionInvalid: true };
      expect(compareCapabilityEvidence(invalid, run("head", 45), protocol).outcome).toBe("BLOCKED");
    }
  });

  it("base 人工 fail 到 head pass 是合法修复，head 人工 fail 仍拒绝", () => {
    const base = run("base", 45);
    base.outcome = "FAIL";
    base.manualReviews = [{ id: "seriousness-mode-switch", verdict: "fail", judged_by: "独立检视獭" }];
    const head = run("head", 45);
    head.manualReviews = [{ id: "seriousness-mode-switch", verdict: "pass", judged_by: "独立检视獭" }];
    expect(compareCapabilityEvidence(base, head, protocol).outcome).toBe("PASS");
    const badHead = { ...head, outcome: "FAIL", manualReviews: [{ id: "seriousness-mode-switch", verdict: "fail", judged_by: "独立检视獭" }] };
    expect(compareCapabilityEvidence(base, badHead, protocol).outcome).toBe("BLOCKED");
  });

  it("v1 旧 manifest 缺 executionInvalid 也 fail-closed", () => {
    const legacy = run("base", 45);
    delete (legacy as Partial<RunManifest>).executionInvalid;
    expect(compareCapabilityEvidence(legacy, run("head", 45), protocol).outcome).toBe("BLOCKED");
  });

  it("模型配置漂移不可比", () => {
    const head = run("head", 45);
    head.model.model = "other-model";
    const result = compareCapabilityEvidence(run("base", 45), head, protocol);
    expect(result.outcome).toBe("BLOCKED");
    expect(result.errors.join("\n")).toContain("模型");
  });

  it("场景静默消失是 FAIL，不以共同子集出绿", () => {
    const head = run("head", 45);
    head.scenarios = [];
    const result = compareCapabilityEvidence(run("base", 45), head, protocol);
    expect(result.outcome).toBe("BLOCKED"); // 整个 run 空场景先拒判
    head.scenarios = [{ ...scenario(45), id: "另一个场景" }];
    const missing = compareCapabilityEvidence(run("base", 45), head, protocol);
    expect(missing.outcome).toBe("FAIL");
    expect(missing.scenarios.some(item => item.reason.includes("缺失"))).toBe(true);
  });
});

describe("人工评审附件", () => {
  function rawCanonical(root: string, mode: "valid" | "sample" | "hard" | "exit" | "zero-fail" | "count" = "valid") {
    const item = canonicalRuns("base")[0];
    const logText = `${CANONICAL_INVENTORY.sampledScenarioIds.map(id => `[capability] ${id} 采样结果（45/50 成功）:`).join("\n")}\n${CANONICAL_INVENTORY.manualReviewIds.map(id => `MANUAL_REVIEW: ${id} 采样信号`).join("\n")}`;
    const sampleFailure = ["sample", "zero-fail", "count"].includes(mode);
    const hardFailure = mode === "hard";
    const failedName = CANONICAL_INVENTORY.testFullNames.find(name => !CANONICAL_INVENTORY.declaredSkippedTestFullNames.includes(name))!;
    const hardName = [...CANONICAL_INVENTORY.testFullNames].reverse().find(name => !CANONICAL_INVENTORY.declaredSkippedTestFullNames.includes(name))!;
    const assertions = CANONICAL_INVENTORY.testFullNames.map(fullName => ({
      fullName, title: fullName,
      status: CANONICAL_INVENTORY.declaredSkippedTestFullNames.includes(fullName) ? "pending" : (sampleFailure && fullName === failedName) || (hardFailure && fullName === hardName) ? "failed" : "passed",
      failureMessages: sampleFailure && fullName === failedName ? ["CapabilitySampleThresholdError: threshold"] : hardFailure && fullName === hardName ? ["AssertionError: hard"] : [],
    }));
    const failed = assertions.filter(item => item.status === "failed").length;
    const vitest = {
      numTotalTests: 62, numFailedTests: mode === "count" ? failed + 1 : failed,
      testResults: [{ name: "canonical.ts", status: failed ? "failed" : "passed", assertionResults: assertions }],
    };
    const exitCode = mode === "exit" ? 1 : mode === "zero-fail" ? 0 : sampleFailure || hardFailure ? 1 : 0;
    const logPath = path.join(root, "raw.log");
    fs.writeFileSync(logPath, logText);
    const vitestPath = path.join(root, "result.json");
    fs.writeFileSync(vitestPath, JSON.stringify(vitest));
    const runPath = path.join(root, "run.json");
    const manifest = createRunManifest({
      role: "base", sourceSha: item.sourceSha, mergeBaseSha: item.mergeBaseSha,
      protocolPath: path.join(process.cwd(), "tests/capability/live-protocol.json"), protocol: CANONICAL_PROTOCOL,
      inventoryPath: path.join(process.cwd(), "tests/capability/live-inventory.json"), inventory: CANONICAL_INVENTORY,
      distWorkerSha256: item.distWorkerSha256, model: item.model, command: item.command,
      logPath, logText, vitestResult: vitest, manualReviews: {}, exitCode,
      startedAt: item.startedAt, endedAt: item.endedAt, runId: item.runId,
      harnessSha: item.harness.sha256, harnessOverlay: true, overlayDiffSha256: item.harness.overlayDiffSha256,
    });
    fs.writeFileSync(runPath, JSON.stringify(manifest));
    return { item: manifest, runPath, logPath, vitestPath };
  }
  function attach(root: string, raw: ReturnType<typeof rawCanonical>) {
    const reviews = Object.fromEntries(CANONICAL_INVENTORY.manualReviewIds.map(id => [id, { verdict: "pass", judged_by: "独立检视獭" }]));
    const reviewsPath = path.join(root, "reviews.json");
    fs.writeFileSync(reviewsPath, JSON.stringify(reviews));
    return spawnSync(process.execPath, [
      "scripts/attach-capability-manual-review.mjs", "--run", raw.runPath,
      "--reviews", reviewsPath, "--log", raw.logPath, "--vitest-result", raw.vitestPath,
    ], { cwd: process.cwd(), encoding: "utf8" });
  }
  it("合法重算后不重跑、不改原件，以相同 runId 附着并保留哈希链", () => {
    for (const mode of ["valid", "sample"] as const) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "capability-review-attach-"));
      const raw = rawCanonical(root, mode);
      expect(raw.item.outcome).toBe("INCONCLUSIVE");
      const attached = attach(root, raw);
      expect(attached.stderr).toBe("");
      expect(attached.status).toBe(0);
      const reviewed = JSON.parse(fs.readFileSync(path.join(root, `${raw.item.runId}.reviewed.json`), "utf8"));
      expect(reviewed.outcome).toBe("COMPLETE");
      expect(reviewed.runId).toBe(raw.item.runId);
      expect(reviewed.manualReviewAttachment.originalManifestSha256).toBe(sha256(fs.readFileSync(raw.runPath)));
      expect(JSON.parse(fs.readFileSync(raw.runPath, "utf8")).outcome).toBe("INCONCLUSIVE");
    }
  });
  it("base 已知硬失败 + 缺人工可附着，附着后仍保留 FAIL", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "capability-review-hard-"));
    const raw = rawCanonical(root, "hard");
    expect(raw.item.outcome).toBe("FAIL");
    expect(raw.item.executionInvalid).toBe(false);
    expect(attach(root, raw).status).toBe(0);
    const reviewed = JSON.parse(fs.readFileSync(path.join(root, `${raw.item.runId}.reviewed.json`), "utf8"));
    expect(reviewed.outcome).toBe("FAIL");
  });

  it("异常退出、exit0+failed、计数矛盾都不能借附件转绿", () => {
    for (const mode of ["exit", "zero-fail", "count"] as const) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "capability-review-reject-"));
      const raw = rawCanonical(root, mode);
      const attached = attach(root, raw);
      expect(attached.status).not.toBe(0);
      expect(fs.existsSync(path.join(root, `${raw.item.runId}.reviewed.json`))).toBe(false);
    }
  });
});

describe("PR 证据门消费 comparison manifest", () => {
  it("裸写 真 LLM: PASS 不再通过", () => {
    const body = "## 能力变更验证\n- parity: PASS — run 1\n- 真 LLM: PASS — 17/17\n- 换底: PASS — contract\n";
    expect(checkCapabilityEvidence(body).join("\n")).toContain("comparison JSON");
  });

  it("BLOCKED 和不存在证据都响亮失败", () => {
    const prefix = "## 能力变更验证\n- parity: PASS — run 1\n- 换底: PASS — contract\n";
    expect(checkCapabilityEvidence(`${prefix}- 真 LLM: BLOCKED — 无\n`).join("\n")).toContain("不能合入");
    expect(checkCapabilityEvidence(`${prefix}- 真 LLM: PASS — docs/evidence/capability/missing.json\n`).join("\n")).toContain("不存在");
  });

  it("PR 自己放宽 protocol 不能通过 canonical 门禁", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "capability-relaxed-gate-"));
    const dir = path.join(root, "docs/evidence/capability");
    fs.mkdirSync(dir, { recursive: true });
    const relaxed = { ...protocol, runsPerSide: 1, minimumValidSamplesPerSide: 1, absoluteHeadSuccessFloor: 0, nonInferiorityDelta: 1 };
    const comparison = compareCapabilityEvidence(run("base", 1, 1), run("head", 1, 1), relaxed);
    fs.writeFileSync(path.join(dir, "relaxed.json"), JSON.stringify(comparison));
    const body = "## 能力变更验证\n- parity: PASS — run 1\n- 真 LLM: PASS — docs/evidence/capability/relaxed.json\n- 换底: PASS — contract\n";
    expect(checkCapabilityEvidence(body, { root }).join("\n")).toContain("canonical");
  });

  it("canonical 哈希下的单场景 comparison 仍被内容级 inventory 拒绝", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "capability-subset-gate-"));
    const dir = path.join(root, "docs/evidence/capability");
    fs.mkdirSync(dir, { recursive: true });
    const harnessSha = hashCapabilityHarness(root);
    const base = canonicalRuns("base", harnessSha);
    const head = canonicalRuns("head", harnessSha);
    for (const item of [...base, ...head]) item.scenarios = item.scenarios.slice(0, 1);
    const comparison = compareCapabilityEvidence(base, head, CANONICAL_PROTOCOL);
    expect(comparison.outcome).toBe("PASS");
    fs.writeFileSync(path.join(dir, "subset.json"), JSON.stringify(comparison));
    const body = "## 能力变更验证\n- parity: PASS — run 1\n- 真 LLM: PASS — docs/evidence/capability/subset.json\n- 换底: PASS — contract\n";
    expect(checkCapabilityEvidence(body, { root }).join("\n")).toContain("采样场景");
  });

  it("当前 HEAD/base 不匹配或内部仍有非 PASS 场景都拒绝", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "capability-evidence-gate-"));
    const dir = path.join(root, "docs/evidence/capability");
    fs.mkdirSync(dir, { recursive: true });
    const harnessSha = hashCapabilityHarness(root);
    const comparison = compareCapabilityEvidence(canonicalRuns("base", harnessSha), canonicalRuns("head", harnessSha), CANONICAL_PROTOCOL);
    fs.writeFileSync(path.join(dir, "pass.json"), JSON.stringify(comparison));
    const body = "## 能力变更验证\n- parity: PASS — run 1\n- 真 LLM: PASS — docs/evidence/capability/pass.json\n- 换底: PASS — contract\n";
    expect(checkCapabilityEvidence(body, { root })).toEqual([]);
    expect(validateComparison(comparison, { expectedHead: "c".repeat(40) }).join("\n")).toContain("当前 HEAD");
    expect(validateComparison({ ...comparison, outcome: "INCONCLUSIVE" }).join("\n")).toContain("不是 PASS");
    const tampered = structuredClone(comparison);
    tampered.head.runs[0].scenarios[0].successes = 0;
    expect(validateComparison(tampered).join("\n")).toContain("重算不一致");
  });
});
