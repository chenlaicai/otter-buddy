import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

function checkTitle(title: string) {
  return spawnSync(process.execPath, ["scripts/check-pr-title.cjs", title], {
    cwd: process.cwd(), encoding: "utf-8",
  });
}

describe("PR title 行为级验收（F20261027fidrx）", () => {
  it.each([
    "[F20261027abcde][docs][Feature Update] 固定五字母",
    "[F20261027fiver][docs][Feature Update] 字母表不缩小",
    "[R20261027lorem][docs] 研究编号同规则",
  ])("接受：%s", (title) => {
    const result = checkTitle(title);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it.each([
    "[F2026102759c4][docs][Feature Update] 数字直连",
    "[F20261027abcd][docs][Feature Update] 四位后缀",
    "[F20261027abcdef][docs][Feature Update] 六位后缀",
    "[F20261027-abcde][docs][Feature Update] 中划线后缀",
    "[F20261027x59c4][docs][Feature Update] 含数字后缀",
  ])("拒绝非固定五字母：%s", (title) => {
    const result = checkTitle(title);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("固定 5 位小写字母");
  });

  it.each(["agent", "runtime", "core", "system", "general", "misc", "other"])(
    "模块黑名单 %s 文案与行为一致：拒绝", (module) => {
      const result = checkTitle(`[F20261027abcde][${module}][Feature Update] 黑名单反例`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("禁用清单");
    },
  );

  it("开放集非黑名单模块仍接受", () => {
    expect(checkTitle("[F20261027abcde][database][Feature Update] 新领域开放词").status).toBe(0);
  });
});
