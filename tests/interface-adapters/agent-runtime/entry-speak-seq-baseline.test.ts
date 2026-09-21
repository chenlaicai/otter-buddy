/**
 * F20260921urdo 修复前失败基线（在主仓 origin/main 代码上运行的副本）：
 * 旧 agent-invoker.ts:618 的 entry.speak 载荷不含 sequenceNum——本用例在主仓跑必红，
 * 在 worktree（修复后）跑必绿。作为 bugfix PR 的失败用例证据。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";

describe("修复前基线：entry.speak 载荷含 sequenceNum", () => {
  it("agent-invoker 的 entry.speak 发射行包含 sequenceNum", () => {
    const src = fs.readFileSync(
      new URL("../../../src/interface-adapters/agent-runtime/agent-invoker.ts", import.meta.url),
      "utf-8",
    );
    const m = src.match(/emitEvent\(\{ event: "entry\.speak"[^;]+;/);
    expect(m).toBeTruthy();
    expect(m![0]).toContain("sequenceNum");
  });
});
