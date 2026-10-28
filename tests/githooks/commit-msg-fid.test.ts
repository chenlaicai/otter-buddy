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

describe("commit-msg 严格新写验收（F20261027fidrx）", () => {
  it.each([
    "[F20261027abcde][docs][Feature Update] 固定五字母",
    "[F20261027fiver][docs][Feature Update] 字母表不缩小",
  ])("接受：%s", (title) => {
    const result = runHook(title);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it.each([
    "[F2026102759c4][docs][Feature Update] 数字直连",
    "[F20261027abcd][docs][Feature Update] 四位后缀",
    "[F20261027abcdef][docs][Feature Update] 六位后缀",
    "[F20261027-abcde][docs][Feature Update] 中划线后缀",
    "[F20261027x59c4][docs][Feature Update] 含数字后缀",
    "[F20261027ABCDE][docs][Feature Update] 大写后缀",
  ])("拒绝非固定五字母：%s", (title) => {
    const result = runHook(title);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("固定 5 位小写字母");
  });
});
