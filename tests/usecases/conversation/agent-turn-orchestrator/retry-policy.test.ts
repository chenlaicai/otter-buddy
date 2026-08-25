import { describe, it, expect } from "vitest";
import { buildYieldRetryMsg, buildAutoRetryMsg } from "@usecases/conversation/agent-turn-orchestrator/retry-policy";

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

describe("buildAutoRetryMsg", () => {
  it("streaming_timeout 返回超时重试提醒", () => {
    const msg = buildAutoRetryMsg('streaming_timeout');
    expect(msg).toContain("超时");
    expect(msg).toContain("继续");
    expect(msg).not.toContain("yield");
  });

  it("first_byte_timeout 返回响应超时提醒", () => {
    const msg = buildAutoRetryMsg('first_byte_timeout');
    expect(msg).toContain("响应超时");
    expect(msg).toContain("重新生成");
  });

  it("circuit_break:* 返回工具异常提醒", () => {
    const msg = buildAutoRetryMsg('circuit_break:event_timeout');
    expect(msg).toContain("工具调用异常");
    expect(msg).toContain("检查");
  });

  it("未知 reason 返回通用异常提醒", () => {
    const msg = buildAutoRetryMsg('unknown_reason');
    expect(msg).toContain("异常");
    expect(msg).toContain("继续");
  });
});
