import { describe, expect, it } from "vitest";
import { AgentTurnOrchestrator } from "@usecases/conversation/agent-turn-orchestrator/orchestrator";
import type { AttemptDriver, TurnCallbacks, TurnInput } from "@usecases/conversation/agent-turn-orchestrator/types";
import { createTestLogger } from "../helpers/logger";

function setup() {
  const statuses: string[] = [];
  const systems: string[] = [];
  const ends: string[] = [];
  const invoke = { id: "invoke-1", status: "running", toolCallCount: 0, tokenUsageInput: null, tokenUsageOutput: null };
  const callbacks: TurnCallbacks = {
    getInvokeById: async () => invoke,
    updateInvokeStatus: async (_id, status) => { statuses.push(status); invoke.status = status; },
    updateInvokeTokenUsage: async () => {},
    createInvokeEndEntry: async (_invokeId, status) => { ends.push(status); return { entryId: "end-1", body: "end" }; },
    sendSystem: async (_conversationId, body) => { systems.push(body); return { id: "system-1", body, sequenceNum: 1, createdAt: new Date().toISOString() }; },
    emitInvokeEnd: () => {},
    emitEvent: () => {},
    recordHealingEvent: async () => {},
    getRecentGuardBounces: async () => 0,
    isSessionCircuitBreakCreated: async () => false,
    isCircuitBreakerEnabled: () => false,
    getOtterById: async () => ({ name: "otter-1" }),
    getInvokeCount: async () => 1,
    getPartnerLabel: async () => "搭档",
    logger: createTestLogger(),
  };
  const driver: AttemptDriver = {
    invoke: async () => ({ result: { text: "", queued: true }, toolCallCount: 0, hasOrphanText: false }),
    getToolCallCount: () => 0,
    getInternalAbortReason: () => undefined,
    isUserAborted: () => false,
    abort: () => {},
  };
  const input: TurnInput = {
    otterId: "otter-1", conversationId: "conv-1", invokeId: "invoke-1",
    userMessageContent: "wait", originalUserMessage: "wait", senderId: "user-1",
    retryCount: 0, manualRetry: false, attemptStartTime: Date.now(),
  };
  return { callbacks, driver, input, statuses, systems, ends, invoke };
}

describe("F20261027cnsv queued terminal routing", () => {
  it("queued 收敛等待行，不重试、不伪造 yield 完成事件", async () => {
    const h = setup();
    const orchestrator = new AgentTurnOrchestrator(createTestLogger());
    const result = await orchestrator.executeTurn(h.input, h.driver, h.callbacks);
    expect(result.invokeId).toBe("invoke-1");
    expect(h.invoke.status).toBe("completed");
    expect(h.statuses).toEqual(["completed"]);
    expect(h.systems).toHaveLength(1);
    expect(h.systems[0]).toContain("已排队");
    expect(h.ends).toEqual([]);
  });
});
