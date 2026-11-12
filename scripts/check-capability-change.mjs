#!/usr/bin/env node
/**
 * 变更触发能力门禁：只有 runtime/存储/会话/prompt/能力测试变更才要求
 * parity + 真 LLM + 换底实验记录；不按日历运行，不烧无关 PR 的 token。
 *
 * 机械边界：本闸验证「变更分类 + 三类证据是否在 PR 中显式呈交」，
 * 不把文本字段冒充测试执行；命令输出与 CI/本地锚点由对抗审视复核。
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  extractSection,
  hasSubstance,
  parseChangedPaths,
} from "./check-pr-evidence.mjs";
import {
  loadCapabilityRegistry,
  matchingCapabilityChanges,
} from "./lint-capability-guardrails.mjs";
import {
  CANONICAL_INVENTORY,
  CANONICAL_INVENTORY_SHA256,
  CANONICAL_PROTOCOL,
  CANONICAL_PROTOCOL_SHA256,
  hashCapabilityHarness,
  loadJson,
  validateComparison,
} from "./capability-live-evidence.mjs";

const EVIDENCE_PATTERNS = [
  { name: "parity", re: /^[-*]\s*parity\s*:\s*PASS\s*[—:-]/im },
  { name: "换底", re: /^[-*]\s*换底\s*:\s*PASS\s*[—:-]/im },
];
const LIVE_RE = /^[-*]\s*真\s*LLM\s*:\s*(PASS|FAIL|BLOCKED|INCONCLUSIVE)\s*[—:-]\s*(\S+)/im;

export function checkCapabilityEvidence(prBody, { root = process.cwd(), expectedHead, expectedBase } = {}) {
  const section = extractSection(prBody, "能力变更验证");
  if (section === null) return ["缺「## 能力变更验证」段"];
  if (!hasSubstance(section)) return ["「## 能力变更验证」段为空或仅占位"];
  const errors = EVIDENCE_PATTERNS
    .filter(item => !item.re.test(section))
    .map(item => `${item.name} 证据缺失：写「- ${item.name}: PASS — <命令与输出锚点>」`);
  const live = section.match(LIVE_RE);
  if (!live) {
    errors.push("真 LLM 非劣证据缺失：PASS 必须指向机器生成的 comparison manifest；BLOCKED/INCONCLUSIVE 不会放行");
    return errors;
  }
  if (live[1] !== "PASS") {
    errors.push(`真 LLM 非劣证据为 ${live[1]}，不能合入`);
    return errors;
  }
  const evidenceRoot = path.resolve(root, "docs/evidence/capability");
  const comparisonPath = path.resolve(root, live[2]);
  if (!comparisonPath.startsWith(`${evidenceRoot}${path.sep}`) || path.extname(comparisonPath) !== ".json") {
    errors.push("真 LLM PASS 必须引用 docs/evidence/capability/ 下的 comparison JSON");
    return errors;
  }
  if (!fs.existsSync(comparisonPath)) {
    errors.push(`真 LLM comparison 不存在: ${live[2]}`);
    return errors;
  }
  try {
    errors.push(...validateComparison(loadJson(comparisonPath), {
      expectedHead,
      expectedBase,
      expectedProtocol: CANONICAL_PROTOCOL,
      expectedProtocolSha: CANONICAL_PROTOCOL_SHA256,
      expectedInventory: CANONICAL_INVENTORY,
      expectedInventorySha: CANONICAL_INVENTORY_SHA256,
      expectedHarnessSha: hashCapabilityHarness(root),
    }));
  } catch (error) {
    errors.push(`真 LLM comparison 不可读: ${error.message}`);
  }
  return errors;
}

export function changedPathsFromGit(base = "origin/main") {
  return parseChangedPaths(execFileSync(
    "git",
    ["diff", "--name-only", "-z", `${base}...HEAD`],
    { encoding: "utf8" },
  ));
}

function main() {
  const argv = process.argv.slice(2);
  const baseIdx = argv.indexOf("--base");
  const base = baseIdx >= 0 ? argv[baseIdx + 1] : "origin/main";
  const bodyIdx = argv.indexOf("--pr-body-file");
  const prBody = bodyIdx >= 0
    ? fs.readFileSync(path.resolve(argv[bodyIdx + 1]), "utf8")
    : process.env.PR_BODY ?? "";
  const registry = loadCapabilityRegistry(process.cwd());
  const hits = matchingCapabilityChanges(changedPathsFromGit(base), registry);
  if (hits.length === 0) {
    console.log("✅ [capability-change] 无 runtime/存储/会话/prompt 变更；不触发 parity 或真 LLM 成本");
    return;
  }
  console.log(`[capability-change] 命中 ${hits.length} 个变更路径：\n${hits.map(hit => `  - ${hit}`).join("\n")}`);
  console.log("换底清单：逐项分类文件名/扩展名/schema/调用作用域依赖为语义或约定；约定依赖须下推、补契约测试或加运行时守护。");
  const expectedHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const expectedBase = execFileSync("git", ["merge-base", "HEAD", base], { encoding: "utf8" }).trim();
  const errors = checkCapabilityEvidence(prBody, { expectedHead, expectedBase });
  if (errors.length) {
    for (const error of errors) console.error(`❌ [capability-change] ${error}`);
    process.exit(1);
  }
  console.log("✅ [capability-change] parity / 真 LLM / 换底三类证据已显式呈交（真实性由对抗审视复核）");
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) main();
