import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runHook(title: string) {
  const dir = mkdtempSync(join(tmpdir(), "fid-hook-"));
  try {
    const msg = join(dir, "message");
    writeFileSync(msg, `${title}\n\nbody\n`);
    return spawnSync("sh", [".githooks/commit-msg", msg], {
      cwd: process.cwd(), encoding: "utf-8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("commit-msg 严格新写验收（F20261027-fidr）", () => {
  it.each([
    "[F20261027-x59c4][docs][Feature Update] 新分隔形态",
    "[F20261027-59c4][docs][Feature Update] 数字后缀分隔形态",
    "[F20261027fidr][docs][Feature Update] 字母开头兼容形态",
  ])("接受可读 ID：%s", (title) => {
    const result = runHook(title);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("拒绝数字直连，即使旧规则允许", () => {
    const result = runHook("[F2026102759c4][docs][Feature Update] 数字直连反例");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("数字直连日期一律拒绝");
  });

  it("拒绝大写/超长 dash 后缀", () => {
    expect(runHook("[F20261027-ABCD][docs][Feature Update] 大写反例").status).toBe(1);
    expect(runHook("[F20261027-abcdefghijk][docs][Feature Update] 超长反例").status).toBe(1);
  });
});
