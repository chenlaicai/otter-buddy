/**
 * check-pr-evidence 机械闸可持续测试（F20261028evpkg，S3/S4 整改固化）。
 *
 * 覆盖检视獭-mech 审视 S3（模板原文/TBD/Summary 关键词假绿）与 S4
 * （豁免双向错分：运行时 prompt 漏放、README.ts 误放、中文路径 quoting 误伤）的实测用例，
 * 及 good/bad/no-body 主路径与 D1 回归（非文档「纯文档豁免」话术绕过、合法回滚句误杀）。
 * 24 个测试用例（24 tests）由 vitest run（npm test）执行，CI test step 即机器锚点。
 */
import { describe, it, expect } from "vitest";
import {
  isDocOnlyPath,
  parseChangedPaths,
  extractSection,
  hasSubstance,
  checkEvidenceBody,
  checkEvidenceLayering,
  checkRollback,
} from "../../scripts/check-pr-evidence.mjs";

describe("isDocOnlyPath 豁免集合（S4）", () => {
  it("docs/ 全树豁免（含中文路径）", () => {
    expect(isDocOnlyPath("docs/features/x.md")).toBe(true);
    expect(isDocOnlyPath("docs/调研/中文路径.md")).toBe(true);
    expect(isDocOnlyPath("docs/research/2026/10/28/R20261028hacab-x.md")).toBe(true);
  });

  it("仓根标准文档豁免", () => {
    expect(isDocOnlyPath("README.md")).toBe(true);
    expect(isDocOnlyPath("README.en.md")).toBe(true);
    expect(isDocOnlyPath("CONTRIBUTING.md")).toBe(true);
    expect(isDocOnlyPath("SECURITY.md")).toBe(true);
    expect(isDocOnlyPath("CHANGELOG.md")).toBe(true);
    expect(isDocOnlyPath("CHANGELOG-2026.md")).toBe(true);
  });

  it("同名非文档扩展名不豁免（S4：README.ts 误放回归）", () => {
    expect(isDocOnlyPath("README.ts")).toBe(false);
    expect(isDocOnlyPath("CHANGELOG.sh")).toBe(false);
    expect(isDocOnlyPath("SECURITY")).toBe(false);
  });

  it("运行时 prompt/行为契约不按扩展名豁免（S4：prompts/scheduled 漏放回归）", () => {
    expect(isDocOnlyPath("prompts/scheduled/daily-health-check.md")).toBe(false);
    expect(isDocOnlyPath(".pi/SYSTEM.md")).toBe(false);
    expect(isDocOnlyPath(".pi/skills/adversarial-review/SKILL.md")).toBe(false);
    expect(isDocOnlyPath(".github/pull_request_template.md")).toBe(false);
  });

  it("代码与配置触发", () => {
    expect(isDocOnlyPath("scripts/check-pr-evidence.mjs")).toBe(false);
    expect(isDocOnlyPath(".github/workflows/ci.yml")).toBe(false);
    expect(isDocOnlyPath("src/index.ts")).toBe(false);
  });

  it("子目录文档不冒充仓根白名单", () => {
    expect(isDocOnlyPath("pkg/README.md")).toBe(false);
  });
});

describe("parseChangedPaths（S4：NUL 分裂防 quoting）", () => {
  it("NUL 分裂与空项过滤", () => {
    const paths = parseChangedPaths("a.txt\0docs/中文.md\0\0b.ts\0");
    expect(paths).toEqual(["a.txt", "docs/中文.md", "b.ts"]);
  });

  it("C-style quote 形态不再需要解析（NUL 下原样保留）", () => {
    // git -z 对非 ASCII 路径输出原字节，不再有 \"docs/\\346...\" 形态
    const paths = parseChangedPaths('"docs/\\346\\226\\207.md"\0');
    expect(paths).toEqual(['"docs/\\346\\226\\207.md"']);
  });
});

describe("hasSubstance 占位判定（S3）", () => {
  it("占位词/模板说明不算实质", () => {
    expect(hasSubstance("-\n")).toBe(false);
    expect(hasSubstance("TBD\n")).toBe(false);
    expect(hasSubstance("todo\n")).toBe(false);
    expect(hasSubstance("待补充\n")).toBe(false);
    expect(hasSubstance("How to roll this back (revert commit / feature flag / manual steps).\n")).toBe(false);
    expect(hasSubstance("Describe the intent of this change.\n")).toBe(false);
  });

  it("实质内容算数", () => {
    expect(hasSubstance("revert 本 PR 即回滚\n")).toBe(true);
    expect(hasSubstance("- **机器锚点**：CI run #123\n")).toBe(true);
    expect(hasSubstance("TBD 后接实质说明则保留：revert commit abc\n")).toBe(true);
  });
});

describe("证据分层两层判定（S3：Summary 关键词假绿回归）", () => {
  it("只在 Summary 提「机器锚点」不算分层声明", () => {
    const body = "## Summary\n机器锚点很有用\n## Rollback\nrevert 即回滚\n";
    const errors = checkEvidenceLayering(body);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("缺「## 证据分层声明」段");
  });

  it("分层段缺 agent 陈述层报错", () => {
    const body =
      "## 证据分层声明\n- **机器锚点**：CI run #123\n## Rollback\nrevert\n";
    const errors = checkEvidenceLayering(body);
    expect(errors.some((e) => e.includes("agent 陈述"))).toBe(true);
  });

  it("两层齐全通过", () => {
    const body =
      "## 证据分层声明\n- **机器锚点**：CI run #123\n- **agent 陈述**[未复验]：预期效果\n## Rollback\nrevert\n";
    expect(checkEvidenceLayering(body)).toEqual([]);
  });

  it("两层标识齐全、层内容为「无」通过", () => {
    const body =
      "## 证据分层声明\n- **机器锚点**：无\n- **agent 陈述**：无\n## Rollback\n纯文档，revert 即回滚\n";
    expect(checkEvidenceLayering(body)).toEqual([]);
    expect(checkRollback(body)).toEqual([]);
  });

  it("D1a 回归：非文档 PR 的「无（纯文档豁免）」全无层标识 → 判红", () => {
    const body =
      "## 证据分层声明\n无（纯文档豁免）\n## Rollback\nrevert 即回滚\n";
    const errors = checkEvidenceLayering(body);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("机器锚点"))).toBe(true);
    expect(errors.some((e) => e.includes("agent 陈述"))).toBe(true);
  });

  it("D1b 回归：合法回滚句不被占位前缀误杀", () => {
    expect(hasSubstance("Remove the feature flag and restart the service.\n")).toBe(true);
    expect(hasSubstance("Remove the old migration table, then redeploy.\n")).toBe(true);
    expect(checkRollback("## Rollback\nRemove the feature flag and restart the service.\n")).toEqual([]);
  });
});

describe("checkEvidenceBody 主路径（S3 假绿回归组）", () => {
  const goodBody = [
    "## Summary",
    "F20261028evpkg 机械闸整改。",
    "## Rollback",
    "revert 本 PR 即回滚（纯增量，无数据迁移）",
    "## 证据分层声明",
    "- **机器锚点**：CI run 40641881、commit sha fcb353aa",
    "- **agent 陈述**[未复验]：决策质量改善预期",
  ].join("\n");

  it("good body 通过", () => {
    expect(checkEvidenceBody(goodBody, { trigger: true })).toEqual([]);
  });

  it("原 PR 模板原文直接当 body → 拒绝（S3 用例①）", () => {
    const templateBody = [
      "## Summary",
      "Describe the intent of this change and the user-visible or system-level impact.",
      "## Why",
      "Explain the motivation for this change.",
      "## What Changed",
      "-",
      "## Affected Areas",
      "- [ ] ...",
      "## Risks",
      "-",
      "## Rollback",
      "How to roll this back (revert commit / feature flag / manual steps).",
    ].join("\n");
    const errors = checkEvidenceBody(templateBody, { trigger: true });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("Rollback"))).toBe(true);
    expect(errors.some((e) => e.includes("证据分层"))).toBe(true);
  });

  it("Rollback: TBD + Summary 提关键词 → 拒绝（S3 用例②）", () => {
    const body = ["## Summary", "机器锚点", "## Rollback", "TBD"].join("\n");
    const errors = checkEvidenceBody(body, { trigger: true });
    expect(errors.some((e) => e.includes("Rollback"))).toBe(true);
    expect(errors.some((e) => e.includes("证据分层"))).toBe(true);
  });

  it("no body → 拒绝", () => {
    expect(checkEvidenceBody("", { trigger: true }).length).toBe(1);
    expect(checkEvidenceBody("   \n", { trigger: true }).length).toBe(1);
  });

  it("纯文档交付不触发 → 不检查 body", () => {
    expect(checkEvidenceBody("", { trigger: false })).toEqual([]);
    expect(checkEvidenceBody("随便写", { trigger: false })).toEqual([]);
  });
});

describe("extractSection 边界", () => {
  it("取到下一个二级标题为止", () => {
    const body = "## Rollback\nrevert\n## Verification\nok";
    expect(extractSection(body, "Rollback")).toContain("revert");
    expect(extractSection(body, "Rollback")).not.toContain("ok");
  });

  it("标题带括号后缀可提取（PR 模板实际格式回归）", () => {
    const body =
      "## 证据分层声明（改系统状态的交付必须填写）\n- **机器锚点**：CI run #123\n- **agent 陈述**[未复验]：x\n## Rollback（写回滚方式）\nrevert 即回滚\n";
    expect(checkEvidenceLayering(body)).toEqual([]);
    expect(checkRollback(body)).toEqual([]);
  });

  it("缺失段返回 null", () => {
    expect(extractSection("## Summary\nx", "Rollback")).toBeNull();
  });
});
