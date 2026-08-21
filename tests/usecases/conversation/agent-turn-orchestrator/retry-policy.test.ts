import { describe, it, expect } from "vitest";
import { buildYieldRetryMsg } from "@usecases/conversation/agent-turn-orchestrator/retry-policy";

describe("buildYieldRetryMsg", () => {
  it("hasOrphanText=true 时返回旁白流失专项文案", () => {
    const msg = buildYieldRetryMsg(3, true);
    expect(msg).toContain("只有你自己能看到的草稿");
    expect(msg).toContain("speak(body)");
    expect(msg).toContain("yield 交棒");
  });

  it("hasOrphanText=false + toolCallCount=0 时返回思考型文案", () => {
    const msg = buildYieldRetryMsg(0, false);
    expect(msg).toContain("没有调用任何工具");
    expect(msg).toContain("speak");
    expect(msg).not.toContain("草稿");
  });

  it("hasOrphanText=false + toolCallCount>0 时返回遗漏 yield 文案", () => {
    const msg = buildYieldRetryMsg(5, false);
    expect(msg).toContain("yield");
    expect(msg).not.toContain("草稿");
    expect(msg).not.toContain("speak");
  });

  it("hasOrphanText 优先于 toolCallCount 判定", () => {
    // 即使 toolCallCount>0，有旁白流失时也应走专项文案
    const msg = buildYieldRetryMsg(5, true);
    expect(msg).toContain("草稿");
  });

  it("未传 hasOrphanText 时走原有逻辑（兼容旧调用）", () => {
    const msg = buildYieldRetryMsg(0);
    expect(msg).toContain("没有调用任何工具");
    expect(msg).not.toContain("草稿");
  });
});
