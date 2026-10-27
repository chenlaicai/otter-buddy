import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

function checkTitle(title: string) {
  return spawnSync(process.execPath, ["scripts/check-pr-title.cjs", title], {
    cwd: process.cwd(), encoding: "utf-8",
  });
}

describe("PR title 行为级验收（F20261027-fidr）", () => {
  it.each([
    "[F20261027-59c4][docs][Feature Update] 数字后缀带分隔",
    "[F20261027-x59c4][docs][Feature Update] 推荐形态",
    "[F20261027fidr][docs][Feature Update] 字母开头兼容",
  ])("接受：%s", (title) => {
    const result = checkTitle(title);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("拒绝日期数字直连", () => {
    const result = checkTitle("[F2026102759c4][docs][Feature Update] 数字直连");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("数字直连拒绝");
  });

  it.each(["agent", "runtime", "core", "system", "general", "misc", "other"])(
    "模块黑名单 %s 文案与行为一致：拒绝", (module) => {
      const result = checkTitle(`[F20261027-fidr][${module}][Feature Update] 黑名单反例`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("禁用清单");
    },
  );

  it("开放集非黑名单模块仍接受", () => {
    expect(checkTitle("[F20261027-fidr][database][Feature Update] 新领域开放词").status).toBe(0);
  });
});
