import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

// F20261106gtagl：Modification-Class 词表闸元测试。
// 双职责：
// 1. 行为验证——五值词表硬闸 + 历史惯用形态容忍（括号说明/首 token 提取）
// 2. 词表镜像一致性——.githooks/commit-msg 内联词表与 worktree-isolation SKILL
//    声明表出现同源漂移时立即变红（hook 无法 import skill 文档，测试代替 import 锁死）

const TITLE = "[F20261106gtagl][docs][Feature Update] 词表闸验收";

function runHook(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "modclass-hook-"));
  try {
    const msg = join(dir, "message");
    writeFileSync(msg, `${TITLE}\n\n${body}\n`);
    return spawnSync("sh", [".githooks/commit-msg", msg], {
      cwd: process.cwd(),
      encoding: "utf-8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("commit-msg Modification-Class 词表闸（F20261106gtagl）", () => {
  it.each([
    "Modification-Class: narrow-fix",
    "Modification-Class: narrow-fix（既有语义内修）",
    "Modification-Class: narrow-fix（审视发现修复，既有语义内）",
    "Modification-Class: scope-reduction",
    "Modification-Class: deletion",
    "Modification-Class: mechanism-addition",
    "Modification-Class: mechanism-addition（四问见特性文档设计取舍段）",
    "Modification-Class: docs-config",
    "Modification-Class: narrow-fix + deletion",
    "modification-class: narrow-fix",
    "MODIFICATION-CLASS: narrow-fix", // 键全大写：grep -i 接收 + 解析阶段大小写统一（r1 建议7 回归）
    // 非标准形态（冒号前空格）grep 不命中 → 不触发闸、放行——存在性/一致性归 B4 异体审，
    // 本闸只拦「写了声明但值非法」的形态，fail-open 是设计选择（误拦成本 > 漏拦成本，见特性文档设计取舍）
  ])("接受：%s", (body) => {
    const result = runHook(body);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it.each([
    "Modification-Class: bugfix", // #1782 实证形态
    "Modification-Class: test-only",
    "Modification-Class: docs-only",
    "Modification-Class: refactor",
    "Modification-Class: review-fix",
    "Modification-Class: doc-fix",
    "Modification-Class: 机制变更（新增 reset 渠道路由）",
    "Modification-Class: new-feature",
  ])("拒绝词表外值：%s", (body) => {
    const result = runHook(body);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("不在词表内");
  });

  it("无声明行放行（存在性检查归 B4 异体审）", () => {
    const result = runHook("Driver: conversation=abc\n\n普通 body 无声明");
    expect(result.status).toBe(0);
  });
});

// —— 词表提取器（镜像一致性真实双向提取，F20261106gtagl r1 发现5 重写）——
// hook 侧：从 case 分支实提取（pipe-separated 词表行）
function extractHookVocabulary(hook: string): Set<string> {
  const m = hook.match(/^\s+([a-z][a-z-]*(?:\|[a-z][a-z-]*)+)\)\s*$/m);
  if (!m) throw new Error("hook 内未找到词表 case 分支");
  return new Set(m[1].split("|"));
}
// SKILL 侧：从声明表实提取（「Modification-Class 声明」锚点后的表格行反引号值）
function extractSkillVocabulary(skill: string): Set<string> {
  const anchor = skill.indexOf("Modification-Class 声明");
  if (anchor === -1) throw new Error("SKILL 未找到声明表锚点");
  const tail = skill.slice(anchor);
  const rows = tail.match(/^\s*\|[^\n]+\|\s*`([a-z][a-z-]*)`\s*\|/gm);
  if (!rows || rows.length === 0) throw new Error("SKILL 声明表无行");
  return new Set(rows.map((r) => r.match(/`([a-z][a-z-]*)`/)![1]));
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

describe("词表镜像一致性（hook case 分支 ↔ SKILL 声明表，真实双向提取）", () => {
  it("两侧词表集合完全相等", () => {
    const hook = readFileSync(".githooks/commit-msg", "utf-8");
    const skill = readFileSync(
      ".pi/skills/worktree-isolation/SKILL.md",
      "utf-8",
    );
    expect(setsEqual(extractHookVocabulary(hook), extractSkillVocabulary(skill))).toBe(true);
  });

  it("负对照：hook 单侧加值 → 集合不再相等（防漂移承诺可兑付）", () => {
    const hook = readFileSync(".githooks/commit-msg", "utf-8");
    const skill = readFileSync(
      ".pi/skills/worktree-isolation/SKILL.md",
      "utf-8",
    );
    const drifted = hook.replace(
      /^\s+([a-z][a-z-]*(?:\|[a-z][a-z-]*)+)\)\s*$/m,
      (m) => m.replace(")", "|unilateral-value)"),
    );
    expect(drifted).not.toEqual(hook); // 替换确实生效
    expect(setsEqual(extractHookVocabulary(drifted), extractSkillVocabulary(skill))).toBe(false);
  });

  it("负对照：SKILL 单侧删值 → 集合不再相等", () => {
    const hook = readFileSync(".githooks/commit-msg", "utf-8");
    const skill = readFileSync(
      ".pi/skills/worktree-isolation/SKILL.md",
      "utf-8",
    );
    const drifted = skill.replace("`docs-config`", "`docs-misc`");
    expect(drifted).not.toEqual(skill);
    expect(setsEqual(extractHookVocabulary(hook), extractSkillVocabulary(drifted))).toBe(false);
  });
});
