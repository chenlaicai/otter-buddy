/**
 * F20260903（#726 拆解）：lint-skills.mjs 引用规范校验测试。
 *
 * 覆盖规则（校验 7/9，F20260903 拆解后结构）：
 *   E1: 绝对路径 .md 引用（含 /…/.pi/skills/…）→ error（agent 换 cwd 后必然读不到）
 *   E1b: 任何 _shared/ 引用（裸写或 ../ 前缀）→ error（目录已随拆解删除，必然 ENOENT）
 *   E2: 引用可见性 = 出现在任一 skill 的「## 工作流」section：
 *       - 哪都没绑定 → error
 *       - 仅其他 skill 的工作流绑定（跨 skill 绑定也算可见）→ warning
 *   7: 引用路径存在性（合法形态统一解析：本 skill 相对 + 跨 skill 裸写）
 *
 * 设计继承 PR #758 的 tests/scripts/lint-skills.test.ts（其方案被架构决策取代，
 * 诊断资产由本测试继承）。
 *
 * 测试策略：临时 skills 目录 + 临时 manifest，构造违规/合规 SKILL.md 后跑真 lint 脚本。
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT = path.resolve(__dirname, "../../scripts/lint-skills.mjs");

function makeSkillDir(root: string, name: string, body: string): void {
  const dir = path.join(root, ".pi/skills", name);
  fs.mkdirSync(dir, { recursive: true });
  const frontmatter = [
    "---",
    `name: ${name}`,
    "description: >-",
    "  Use when: 测试用。 Not for: 无. Output: 无.",
    "co_loads: []",
    "category: technique",
    "---",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter + body);
}

function makeManifest(root: string, names: string[]): void {
  const dir = path.join(root, "prompts/skills");
  fs.mkdirSync(dir, { recursive: true });
  const skills = names
    .map((n) => `  - name: ${n}\n    category: technique\n    next: []\n    not_for: []`)
    .join("\n");
  fs.writeFileSync(path.join(dir, "manifest.yaml"), `skills:\n${skills}\n`);
}

/** 在临时目录搭 skills 集合并跑 lint，返回 { exitCode, stdout+stderr } */
function runLint(skills: Record<string, { body: string; refs?: Record<string, string> }>): {
  exitCode: number;
  output: string;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lint-skill9-"));
  const names = Object.keys(skills);
  for (const [name, spec] of Object.entries(skills)) {
    makeSkillDir(tmp, name, spec.body);
    for (const [rel, content] of Object.entries(spec.refs ?? {})) {
      const full = path.join(tmp, ".pi/skills", rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
  // MIN_SKILLS=9 ratchet：补 8 个合规 pad skill（无 references 引用，不触发校验 9）
  const minimalBody = "# Pad\n\n## 工作流\n\n1. 占位。\n";
  for (let i = 0; i < 8; i++) {
    const padName = `pad${i}`;
    makeSkillDir(tmp, padName, minimalBody);
    names.push(padName);
  }
  makeManifest(tmp, names);
  try {
    const r = spawnSync("node", [SCRIPT], { encoding: "utf-8", cwd: tmp });
    return { exitCode: r.status ?? 0, output: (r.stdout ?? "") + (r.stderr ?? "") };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      output: (err.stdout ?? "") + (err.stderr ?? ""),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 最小合规 skill 骨架：有工作流 section + 参考索引 */
function skillBody(opts: { wfRef?: string; indexRef?: string; absRef?: string; sharedRef?: string }): string {
  const parts: string[] = ["# T", "", "## 工作流", "", "1. 做事"];
  if (opts.wfRef) parts[parts.length - 1] += `，详见 \`${opts.wfRef}\`。`;
  parts.push("", "## 参考（索引）", "");
  if (opts.indexRef) parts.push(`- \`${opts.indexRef}\` — 参考`);
  if (opts.absRef) parts.push(`- 绝对路径示例 \`${opts.absRef}\``);
  if (opts.sharedRef) parts.push(`- 拆解残留 \`${opts.sharedRef}\``);
  return parts.join("\n") + "\n";
}

describe("lint-skills 校验 9（F20260903 拆解后引用规范）", () => {
  it("E2: 引用只出现在参考索引、任何 skill 工作流都未内联 → error", () => {
    const r = runLint({
      alpha: {
        body: skillBody({ indexRef: "references/guide.md" }),
        refs: { "alpha/references/guide.md": "# guide" },
      },
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("未被任何 skill 工作流步骤内联");
    expect(r.output).toContain("references/guide.md");
  });

  it("E2 合规: 引用在工作流步骤内联 → 通过", () => {
    const r = runLint({
      alpha: {
        body: skillBody({ wfRef: "references/guide.md", indexRef: "references/guide.md" }),
        refs: { "alpha/references/guide.md": "# guide" },
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).not.toContain("内联");
  });

  it("E2: 跨 skill 工作流绑定 → warning 不阻断（author-response-protocol 模式）", () => {
    const r = runLint({
      review: {
        body: skillBody({ indexRef: "references/protocol.md" }),
        refs: { "review/references/protocol.md": "# protocol" },
      },
      impl: {
        body: skillBody({ wfRef: "../review/references/protocol.md", indexRef: "../review/references/protocol.md" }),
        refs: {},
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("仅由其他 skill 的工作流绑定");
  });

  it("E2: 同一文件不同引用字符串（references/x vs 跨 skill 裸写 review/references/x）按解析后路径归一", () => {
    const r = runLint({
      review: {
        body: skillBody({ wfRef: "references/protocol.md" }),
        refs: { "review/references/protocol.md": "# protocol" },
      },
      impl: {
        // 跨 skill 裸写形态：F20260903 拆解后放行（目标目录真实存在）
        body: skillBody({ wfRef: "review/references/protocol.md" }),
        refs: {},
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).not.toContain("未被任何");
  });

  it("E1: 绝对路径 .md 引用 → error", () => {
    const r = runLint({
      alpha: {
        body: skillBody({
          wfRef: "references/guide.md",
          absRef: "/some/repo/.pi/skills/other/SKILL.md",
        }),
        refs: { "alpha/references/guide.md": "# guide" },
      },
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("绝对路径引用");
  });

  it("E1b: _shared/ 裸写法残留 → error（目录已删除，F20260903 拆解）", () => {
    const r = runLint({
      alpha: {
        body: skillBody({ sharedRef: "_shared/signature-convention.md" }),
        refs: {},
      },
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("_shared/ 残留引用");
  });

  it("E1b: ../_shared/ 前缀形态同样 → error（#758 推荐的过渡写法在拆解后失效）", () => {
    const r = runLint({
      alpha: {
        body: skillBody({ sharedRef: "../_shared/signature-convention.md" }),
        refs: {},
      },
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("_shared/ 残留引用");
  });

  it("存量行为不回归: 缺失 references 文件仍报 error（校验 7）", () => {
    const r = runLint({
      alpha: { body: skillBody({ wfRef: "references/ghost.md" }), refs: {} },
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("references 路径不存在");
  });

  it("存量行为不回归: 跨 skill 裸写指向不存在的 skill → error（校验 7，按 skills 根解析）", () => {
    const r = runLint({
      alpha: { body: skillBody({ wfRef: "no-such-skill/references/guide.md" }), refs: {} },
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("references 路径不存在");
  });

  it("存量行为不回归: frontmatter 缺字段 → error（校验 1）", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lint-skill1-"));
    const dir = path.join(tmp, ".pi/skills/broken");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: broken\n---\n# B\n");
    const padBody = "# Pad\n\n## 工作流\n\n1. 占位。\n";
    for (let i = 0; i < 8; i++) makeSkillDir(tmp, `pad${i}`, padBody);
    makeManifest(tmp, ["broken", "pad0", "pad1", "pad2", "pad3", "pad4", "pad5", "pad6", "pad7"]);
    try {
      const r = spawnSync("node", [SCRIPT], { encoding: "utf-8", cwd: tmp });
      const output = (r.stdout ?? "") + (r.stderr ?? "");
      expect(r.status).toBe(1);
      expect(output).toContain("frontmatter 缺字段");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
