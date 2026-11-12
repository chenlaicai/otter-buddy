import { describe, expect, it } from "vitest";
import {
  loadCapabilityRegistry,
  matchingCapabilityChanges,
  validateCapabilityGuardrails,
} from "../../scripts/lint-capability-guardrails.mjs";
import { checkCapabilityEvidence } from "../../scripts/check-capability-change.mjs";

const root = process.cwd();
const registry = loadCapabilityRegistry(root);

function cloneRegistry() {
  return JSON.parse(JSON.stringify(registry));
}

describe("能力保证格点门禁", () => {
  it("当前登记与 capability 文件集合精确一致", () => {
    expect(validateCapabilityGuardrails(root, registry)).toEqual([]);
  });

  it("新增测试未登记会红，杜绝静默脱离保证格点", () => {
    const changed = cloneRegistry();
    changed.capabilities = changed.capabilities.filter((entry: { file: string }) =>
      entry.file !== "tests/capability/multi-model.capability.test.ts");
    expect(validateCapabilityGuardrails(root, changed).join("\n")).toContain("未登记保证格点");
  });

  it("faux 文件级排除必须带公开 issue", () => {
    const changed = cloneRegistry();
    changed.capabilities[0].faux = "exclude";
    expect(validateCapabilityGuardrails(root, changed).join("\n")).toContain("必须登记 issue");
    changed.capabilities[0].issue = "#1234";
    expect(validateCapabilityGuardrails(root, changed)).toEqual([]);
  });

  it("无保证可以登记，但保证层不能拼错后隐身", () => {
    const changed = cloneRegistry();
    changed.capabilities[0].guarantee = "none";
    expect(validateCapabilityGuardrails(root, changed)).toEqual([]);
    changed.capabilities[0].guarantee = "well-tested";
    expect(validateCapabilityGuardrails(root, changed).join("\n")).toContain("非法");
  });

  it("变更触发只命中运行时/会话/prompt，不让文档 PR 烧 token", () => {
    expect(matchingCapabilityChanges(["docs/features/x.md"], registry)).toEqual([]);
    expect(matchingCapabilityChanges([
      "src/frameworks/agent/durable-session.ts",
      "docs/features/x.md",
    ], registry)).toEqual(["src/frameworks/agent/durable-session.ts"]);
  });

  it("护栏自身的脚本、配置与 CI 都在变更触发内，不能静默拆门", () => {
    const mechanismFiles = [
      "scripts/lint-capability-guardrails.mjs",
      "scripts/check-capability-change.mjs",
      "scripts/run-capability-parity.sh",
      "vitest.capability-faux.config.ts",
      ".github/workflows/ci.yml",
      "package.json",
    ];
    expect(matchingCapabilityChanges(mechanismFiles, registry)).toEqual(mechanismFiles);
  });
});

describe("变更触发能力证据门禁", () => {
  it("相关变更缺任一类证据都会红", () => {
    expect(checkCapabilityEvidence("")).toContain("缺「## 能力变更验证」段");
    const partial = "## 能力变更验证\n- parity: PASS — CI #1\n- 真 LLM: PASS — local log";
    expect(checkCapabilityEvidence(partial).join("\n")).toContain("换底");
  });

  it("真 LLM 不能只交自报 PASS，必须引用机器生成的 comparison manifest", () => {
    const body = `## 能力变更验证
- parity: PASS — gh run 123 / model-visible
- 真 LLM: PASS — npm run test:capability，17/17 文件
- 换底: PASS — 新增 Storage 契约测试，schema 依赖已下推
`;
    expect(checkCapabilityEvidence(body).join("\n")).toContain("comparison JSON");
  });
});
