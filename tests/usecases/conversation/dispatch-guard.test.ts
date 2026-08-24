/**
 * dispatch-guard 测试：编排对话软守卫 + 派工票据守卫
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { ToolContext } from "@usecases/ports/agent-tools";
import { checkOrchestrationGuard, checkPendingDispatches, confirmDispatchesClear } from "@usecases/conversation/dispatch-guard";

describe("checkOrchestrationGuard", () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = {
      client: {} as any,
      otterId: "big-otter",
      conversationId: "conv-1",
      currentMessageId: "msg-1",
      pendingDispatches: new Map(),
      orchestrationWarningShown: false,
    };
  });

  it("write 工具在有未派工小獭时应返回提醒", () => {
    ctx.pendingDispatches!.set("otter-1", "小獭1");
    const result = checkOrchestrationGuard(ctx, "write");
    expect(result).toContain("编排守卫");
    expect(result).toContain("小獭1");
  });

  it("edit 工具在有未派工小獭时应返回提醒", () => {
    ctx.pendingDispatches!.set("otter-1", "小獭1");
    const result = checkOrchestrationGuard(ctx, "edit");
    expect(result).toContain("编排守卫");
  });

  it("bash 工具在有未派工小獭时应返回提醒", () => {
    ctx.pendingDispatches!.set("otter-1", "小獭1");
    const result = checkOrchestrationGuard(ctx, "bash");
    expect(result).toContain("编排守卫");
  });

  it("read 工具不应触发提醒", () => {
    ctx.pendingDispatches!.set("otter-1", "小獭1");
    const result = checkOrchestrationGuard(ctx, "read");
    expect(result).toBeNull();
  });

  it("speak 工具不应触发提醒", () => {
    ctx.pendingDispatches!.set("otter-1", "小獭1");
    const result = checkOrchestrationGuard(ctx, "speak");
    expect(result).toBeNull();
  });

  it("无未派工小獭时不应触发提醒", () => {
    const result = checkOrchestrationGuard(ctx, "write");
    expect(result).toBeNull();
  });

  it("二次放行：首次提醒后再次调用应返回 null", () => {
    ctx.pendingDispatches!.set("otter-1", "小獭1");
    const first = checkOrchestrationGuard(ctx, "write");
    expect(first).toContain("编排守卫");
    expect(ctx.orchestrationWarningShown).toBe(true);

    const second = checkOrchestrationGuard(ctx, "write");
    expect(second).toBeNull();
  });

  it("多个未派工小獭时应列出所有名字", () => {
    ctx.pendingDispatches!.set("otter-1", "小獭1");
    ctx.pendingDispatches!.set("otter-2", "小獭2");
    const result = checkOrchestrationGuard(ctx, "write");
    expect(result).toContain("小獭1");
    expect(result).toContain("小獭2");
    expect(result).toContain("2 只");
  });

  it("pendingDispatches 未注入时不应触发提醒", () => {
    ctx.pendingDispatches = undefined;
    const result = checkOrchestrationGuard(ctx, "write");
    expect(result).toBeNull();
  });
});

describe("checkPendingDispatches", () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = {
      client: {} as any,
      otterId: "big-otter",
      conversationId: "conv-1",
      currentMessageId: "msg-1",
      pendingDispatches: new Map(),
      dispatchWarningShown: false,
    };
  });

  it("所有小獭都已派工时不应提醒", () => {
    ctx.pendingDispatches!.set("otter-1", "小獭1");
    const result = checkPendingDispatches(ctx, ["otter-1"], ["小獭1"]);
    expect(result).toBeNull();
  });

  it("有未派工小獭时应提醒", () => {
    ctx.pendingDispatches!.set("otter-1", "小獭1");
    ctx.pendingDispatches!.set("otter-2", "小獭2");
    const result = checkPendingDispatches(ctx, ["otter-1"], ["小獭1"]);
    expect(result).toContain("小獭2");
  });

  it("二次放行：首次提醒后再次调用应返回 null", () => {
    ctx.pendingDispatches!.set("otter-1", "小獭1");
    ctx.pendingDispatches!.set("otter-2", "小獭2");

    const first = checkPendingDispatches(ctx, ["otter-1"], ["小獭1"]);
    expect(first).toContain("小獭2");
    expect(ctx.dispatchWarningShown).toBe(true);

    const second = checkPendingDispatches(ctx, ["otter-1"], ["小獭1"]);
    expect(second).toBeNull();
  });
});

describe("confirmDispatchesClear", () => {
  it("应清除已派工的票据", () => {
    const ctx: ToolContext = {
      client: {} as any,
      otterId: "big-otter",
      conversationId: "conv-1",
      currentMessageId: "msg-1",
      pendingDispatches: new Map([["otter-1", "小獭1"], ["otter-2", "小獭2"]]),
    };

    confirmDispatchesClear(ctx, ["otter-1"]);
    expect(ctx.pendingDispatches!.has("otter-1")).toBe(false);
    expect(ctx.pendingDispatches!.has("otter-2")).toBe(true);
  });

  it("pendingDispatches 未注入时不应报错", () => {
    const ctx: ToolContext = {
      client: {} as any,
      otterId: "big-otter",
      conversationId: "conv-1",
      currentMessageId: "msg-1",
    };

    expect(() => confirmDispatchesClear(ctx, ["otter-1"])).not.toThrow();
  });
});
