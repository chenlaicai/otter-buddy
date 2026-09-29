import { describe, it, expect } from "vitest";
import fs from "node:fs";

/**
 * #902 断点 1 的失败基线（worktree-isolation bugfix 硬规则：修复前失败证据）。
 *
 * 断言形态沿用 entry-speak-seq-baseline.test.ts 先例（F20260921urdo）：静态扫描发射行。
 * 在 origin/main（628078f5）上运行必红——发射行不含 attachments；
 * 修复后（本 worktree）必绿。
 */
describe("修复前基线：entry.speak 发射点含 attachments 管线", () => {
  it("agent-invoker 的 entry.speak 发射行含 attachments 透传", () => {
    const src = fs.readFileSync(
      new URL("../../../src/interface-adapters/agent-runtime/agent-invoker.ts", import.meta.url),
      "utf-8",
    );
    const m = src.match(/emitEvent\(\{ event: "entry\.speak"[^;]+;/);
    expect(m).toBeTruthy();
    expect(m![0]).toContain("attachments");
  });

  it("SSE 契约 entry.speak 载荷声明 attachments 字段", () => {
    const src = fs.readFileSync(
      new URL("../../../api-contract/sse/events.ts", import.meta.url),
      "utf-8",
    );
    const m = src.match(/"entry\.speak":\s*\{[^}]+\}/);
    expect(m).toBeTruthy();
    expect(m![0]).toContain("attachments");
  });
});
