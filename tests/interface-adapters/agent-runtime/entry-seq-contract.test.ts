import { describe, it, expect, vi, beforeEach } from "vitest";
/**
 * F20260921urdo 契约收口测试：entry.* SSE 载荷必含 sequenceNum（已读游标数据源）。
 *
 * 背景：entry.speak 载荷缺 sequenceNum 导致前端 speak 气泡无 seq →「底部即已读」
 * maxSeq 计算排除 speak → 游标推不过最新 speak → 红点僵死。本测试锁契约：
 * 驱动真实 AgentInvoker.handleStreamEvent（speak 工具 execution_end → entry.speak SSE），
 * 断言载荷必含 sequenceNum/createdAt。
 */

import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import { mockSendEntry } from "../../helpers/mock-send-entry";

type AnyInvoker = {
  // 测试直接驱动真实类的私有事件处理路径（发射 entry.speak 的生产代码）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

function makeInvoker(): AnyInvoker {
  // 走真实 AgentInvoker.prototype（handleStreamEvent 为私有方法，
  // 测试直接驱动——它就是发射 entry.speak 的生产代码路径）
  const invoker = Object.create(AgentInvoker.prototype) as AnyInvoker;
  invoker.logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  invoker.metrics = null;
  return invoker;
}

describe("F20260921urdo 契约收口：entry.speak SSE 载荷必含 sequenceNum", () => {
  it("speak 工具执行后发射的 entry.speak 事件携带 sequenceNum + createdAt", async () => {
    const sendEntry = mockSendEntry();
    const invoker = makeInvoker();
    invoker.sendEntry = sendEntry;
    // persistInvokeEvent 在 speak 分支后被调，注入 no-op
    invoker.persistInvokeEvent = () => {};
    invoker.emitInvokeTick = () => {};

    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const emitEvent = (e: { event: string; data: Record<string, unknown> }) => events.push(e);

    // 模拟真实链：speak 落库（tool-factory → createSpeakEntry → details 携 seq/createdAt）
    const { entry } = await sendEntry.createSpeakEntry({
      conversationId: "conv-1",
      invokeId: "invoke-1",
      otterId: "otter-1",
      body: "hello",
    });
    expect(entry.sequenceNum).toBeGreaterThan(0);

    const toolEvent = {
      type: "tool_execution_end",
      toolCallId: "tc-1",
      name: "speak",
      result: { details: { __speakIntermediate: true, body: "hello", entryId: entry.id, entryType: "speak", sequenceNum: entry.sequenceNum, createdAt: entry.createdAt } },
    } as never;

    invoker.handleStreamEvent(
      toolEvent,
      { invokeId: "invoke-1" },
      "otter-1",
      emitEvent as never,
      { otterName: "Tester", currentInvokeId: "invoke-1" },
      new Map(),
      { count: 0 },
      () => {},
      "conv-1",
    );

    const speakEvent = events.find((e) => e.event === "entry.speak");
    expect(speakEvent).toBeDefined();
    expect(speakEvent!.data.sequenceNum).toBe(entry.sequenceNum);
    expect(speakEvent!.data.createdAt).toBe(entry.createdAt);
    expect(speakEvent!.data.body).toBe("hello");
  });

  it("createSpeakEntry 返回的 entry 带 sequenceNum（原子序号单调递增）", async () => {
    const sendEntry = mockSendEntry();
    const { entry: e1 } = await sendEntry.createSpeakEntry({ conversationId: "c1", invokeId: "i1", otterId: "o1", body: "a" });
    const { entry: e2 } = await sendEntry.createSpeakEntry({ conversationId: "c1", invokeId: "i1", otterId: "o1", body: "b" });
    expect(e2.sequenceNum).toBeGreaterThan(e1.sequenceNum);
  });
});

describe("F20260921urdo 契约收口：entry.system 载荷字段统一 sequenceNum", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("createSystemEntry 返回的 entry 带 sequenceNum + createdAt（发射点数据源）", async () => {
    const sendEntry = mockSendEntry();
    const { entry } = await sendEntry.createSystemEntry({ conversationId: "c1", body: "sys" });
    // 发射点（circuit-break-support / agent-invoker / scheduler / tool-factory）
    // 从投影读 sequenceNum/createdAt 拼 SSE 载荷
    expect(entry.sequenceNum).toBeGreaterThan(0);
    expect(entry.createdAt).toBeTruthy();
  });
});
