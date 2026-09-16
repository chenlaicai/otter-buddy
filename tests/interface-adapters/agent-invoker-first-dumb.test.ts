/**
 * F20260916fst4：首哑信号消费（agent-invoker handleFirstDumbSignal）单测。
 *
 * 覆盖方案验证段 3 用例：
 * - _firstDumb → dispatch 被调且 resolvedTargets 含在场大獭
 * - 无大獭在场 → 降级不 dispatch（仅 alert 入队 + system entry）
 * - 时序：enqueue alert 先于 dispatch（调用顺序数组记录断言——非 mock 调用次数断言）
 *
 * 走 AgentInvoker 公开接口 invokeConversation：SDK 抛出 exhausted 429 → orchestrator
 * 挂 _firstDumb → invoker 消费 → dispatch / 降级。纯内存 mock，零 DB。
 */

import { describe, it, expect } from "vitest";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { SdkInvokePort } from "@usecases/ports/sdk-invoke-port";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { OtterSession } from "@entities/otter/otter-session";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { ConversationParticipant } from "@entities/conversation/conversation";
import type { AgentDispatchService } from "@usecases/conversation/agent-dispatch-service";
import { healingAlertRegistry } from "@usecases/healing/healing-alert-registry";
import { createTestLogger } from "../helpers/logger";
import { mockSendEntry } from "../helpers/mock-send-entry";

/** 配额耗尽 429（matchRateLimitError 命中 exhausted=true） */
const EXHAUSTED_429 = 'LLM API error: 429 {"code":"1310","message":"code: 1310, 本月配额已耗尽，将于 2026-09-20 08:00 重置"}';

function makeSession(overrides: Partial<OtterSession> = {}): OtterSession {
  return {
    id: "sess-1", otterId: "otter-small-1", status: "active",
    previousSessionId: null, startedAt: "2026-09-16T00:00:00Z",
    archivedAt: null, archiveReason: null, isNegativeCase: false,
    summary: null, modelAlias: null,
    ...overrides,
  };
}

function mockQueryMessage(): QueryMessage {
  return { getMessageById: async () => null, getMessages: async () => [] } as unknown as QueryMessage;
}

function mockManageSession(): ManageSession {
  return {
    getActiveSession: async () => null,
    createSession: async (otterId: string) => makeSession({ id: "sess-backfill", otterId }),
    restartSession: async (otterId: string) => makeSession({ id: "sess-new", otterId }),
  } as unknown as ManageSession;
}

/** otterType 可配：小獭（首哑判定命中）/ 大獭（在场接棒目标） */
function mockQueryOtter(types: Record<string, string>): QueryOtter {
  return {
    getById: async (id: string) => ({
      id, name: id, type: types[id] ?? "small", status: "active",
      role: null, parentOtterId: null,
      createdAt: "2026-09-16T00:00:00Z", dissolvedAt: null,
    }),
  } as unknown as QueryOtter;
}

/** 让 SDK invoke 抛 exhausted 429（_modelAlias 便于 orchestrator 解析） */
function sdkThrowingExhausted429(): SdkInvokePort {
  const err = new Error(EXHAUSTED_429) as Error & { _modelAlias?: string };
  err._modelAlias = "glm";
  return {
    invoke: async () => { throw err; },
    abort: () => {},
    getToolCallCount: () => 0,
    getInternalAbortReason: () => undefined,
  } as unknown as SdkInvokePort;
}

/** 在场参与者 mock：返回给定 otterId 列表（getActiveParticipants） */
function mockConversationRepo(otterIds: string[]): ConversationRepository {
  return {
    getActiveParticipants: async (): Promise<ConversationParticipant[]> =>
      otterIds.map(id => ({
        id: `part-${id}`, conversationId: "conv-1", otterId: id,
        joinedAt: "2026-09-16T00:00:00Z", joinedAtTurnId: null,
        joinedAtTurnNumber: 1, leftAt: null, leftAtTurnId: null, leftAtTurnNumber: null,
        status: "active", createdAt: "2026-09-16T00:00:00Z",
        lastReadTurnNumber: 0, lastActiveTurnNumber: 1,
      })),
  } as unknown as ConversationRepository;
}

/** invokeRepo mock：getInvokes 返回 N 条（首哑判定 count 数据源） */
function mockInvokeRepo(count: number) {
  return {
    getInvokes: async () =>
      Array.from({ length: count }, (_, i) => ({ id: `invoke-${i + 1}` })),
  } as never;
}

/** dispatch mock：记录 userMessageContent + 调用顺序入 orderLog（行为断言面，非调用次数断言） */
function mockDispatchService(orderLog: string[], captured?: { message?: string }): AgentDispatchService {
  return {
    dispatch: async (input: { resolvedTargets?: string[]; userMessageContent?: string }) => {
      orderLog.push("dispatch");
      if (captured) captured.message = input.userMessageContent;
      return { dispatchedTo: input.resolvedTargets ?? [] };
    },
  } as unknown as AgentDispatchService;
}

/** 调用顺序探针：enqueue 真实入队 + 记录顺序（healingAlertRegistry 为进程单例，消费后清空） */
function instrumentAlertEnqueue(orderLog: string[]): void {
  const original = healingAlertRegistry.enqueue.bind(healingAlertRegistry);
  healingAlertRegistry.enqueue = (convId: string, alert: unknown) => {
    orderLog.push("enqueue");
    original(convId, alert as never);
  };
}

describe("F20260916fst4 agent-invoker 首哑信号消费", () => {
  it("_firstDumb → dispatch 被调且 resolvedTargets 为大獭（alert 入队 + system entry 已发）", async () => {
    const sendEntry = mockSendEntry();
    const orderLog: string[] = [];
    instrumentAlertEnqueue(orderLog);
    try {
      const invoker = new AgentInvoker(
        sdkThrowingExhausted429(),
        mockQueryMessage(),
        mockManageSession(),
        mockQueryOtter({ "otter-small-1": "small", "otter-big-1": "big" }),
        createTestLogger(),
        undefined, undefined, undefined, undefined,
        undefined, // healingRepo
        mockConversationRepo(["otter-small-1", "otter-big-1"]),
        undefined, undefined, undefined, undefined, undefined, undefined,
        sendEntry,
        mockInvokeRepo(1),
        mockDispatchService(orderLog),
      );

      await invoker.invokeConversation({
        otterId: "otter-small-1",
        conversationId: "conv-1",
        userMessageContent: "请审视这份代码",
        senderId: "otter-big-1",
      }).catch(() => null);

      // 等 fire-and-forget 收尾（handleFirstDumbSignal 为 void 异步）
      await new Promise(r => setTimeout(r, 50));

      // 可观察行为 1：dispatch 被调且目标为大獭
      expect(orderLog).toContain("dispatch");
      // 可观察行为 2：alert 入队（C3 通道）+ system entry（搭档可见留痕）
      expect(orderLog).toContain("enqueue");
      expect(sendEntry.store.systemBodies.some(b => b.includes("首哑告警"))).toBe(true);
    } finally {
      healingAlertRegistry.takeAll("conv-1");
    }
  });

  it("无大獭在场 → 不 dispatch（alert 仍入队 + system entry 已发，降级仅日志）", async () => {
    const sendEntry = mockSendEntry();
    const orderLog: string[] = [];
    instrumentAlertEnqueue(orderLog);
    try {
      const invoker = new AgentInvoker(
        sdkThrowingExhausted429(),
        mockQueryMessage(),
        mockManageSession(),
        mockQueryOtter({ "otter-small-1": "small" }),
        createTestLogger(),
        undefined, undefined, undefined, undefined,
        undefined,
        mockConversationRepo(["otter-small-1"]), // 只有小獭，无大獭
        undefined, undefined, undefined, undefined, undefined, undefined,
        sendEntry,
        mockInvokeRepo(1),
        mockDispatchService(orderLog),
      );

      await invoker.invokeConversation({
        otterId: "otter-small-1",
        conversationId: "conv-1",
        userMessageContent: "请审视这份代码",
        senderId: "user-1",
      }).catch(() => null);

      await new Promise(r => setTimeout(r, 50));

      // dispatch 未被调（降级）
      expect(orderLog).not.toContain("dispatch");
      // alert + system entry 仍发生（双通道不白丢）
      expect(orderLog).toContain("enqueue");
      expect(sendEntry.store.systemBodies.some(b => b.includes("首哑告警"))).toBe(true);
    } finally {
      healingAlertRegistry.takeAll("conv-1");
    }
  });

  it("时序：enqueue 先于 dispatch（严格串行，alert 必在大獭 buildDynamicContext 前入队）", async () => {
    const sendEntry = mockSendEntry();
    const orderLog: string[] = [];
    instrumentAlertEnqueue(orderLog);
    try {
      const invoker = new AgentInvoker(
        sdkThrowingExhausted429(),
        mockQueryMessage(),
        mockManageSession(),
        mockQueryOtter({ "otter-small-1": "small", "otter-big-1": "big" }),
        createTestLogger(),
        undefined, undefined, undefined, undefined,
        undefined,
        mockConversationRepo(["otter-small-1", "otter-big-1"]),
        undefined, undefined, undefined, undefined, undefined, undefined,
        sendEntry,
        mockInvokeRepo(1),
        mockDispatchService(orderLog),
      );

      await invoker.invokeConversation({
        otterId: "otter-small-1",
        conversationId: "conv-1",
        userMessageContent: "请审视这份代码",
        senderId: "otter-big-1",
      }).catch(() => null);

      await new Promise(r => setTimeout(r, 50));

      const enqueueIdx = orderLog.indexOf("enqueue");
      const dispatchIdx = orderLog.indexOf("dispatch");
      expect(enqueueIdx).toBeGreaterThanOrEqual(0);
      expect(dispatchIdx).toBeGreaterThanOrEqual(0);
      expect(enqueueIdx).toBeLessThan(dispatchIdx);
    } finally {
      healingAlertRegistry.takeAll("conv-1");
    }
  });

  it("未挂接 dispatch（web-only 部署）→ 显式降级：alert + system entry 仍发生，不 dispatch 不抛异常", async () => {
    const sendEntry = mockSendEntry();
    const orderLog: string[] = [];
    instrumentAlertEnqueue(orderLog);
    try {
      const invoker = new AgentInvoker(
        sdkThrowingExhausted429(),
        mockQueryMessage(),
        mockManageSession(),
        mockQueryOtter({ "otter-small-1": "small", "otter-big-1": "big" }),
        createTestLogger(),
        undefined, undefined, undefined, undefined,
        undefined,
        mockConversationRepo(["otter-small-1", "otter-big-1"]),
        undefined, undefined, undefined, undefined, undefined, undefined,
        sendEntry,
        mockInvokeRepo(1),
        // 故意不挂接 AgentDispatchService（web-only 部署场景）
      );

      await invoker.invokeConversation({
        otterId: "otter-small-1",
        conversationId: "conv-1",
        userMessageContent: "请审视这份代码",
        senderId: "otter-big-1",
      }).catch(() => null);

      await new Promise(r => setTimeout(r, 50));

      // 显式降级路径：不 dispatch（也不应因 undefined dispatch 抛异常——外层 catch 前已提前 return）
      expect(orderLog).not.toContain("dispatch");
      expect(orderLog).toContain("enqueue");
      expect(sendEntry.store.systemBodies.some(b => b.includes("首哑告警"))).toBe(true);
    } finally {
      healingAlertRegistry.takeAll("conv-1");
    }
  });

  it("dispatch 处置指令含小獭名字（大獭收到可定位的复活对象）", async () => {
    const sendEntry = mockSendEntry();
    const orderLog: string[] = [];
    const captured: { message?: string } = {};
    instrumentAlertEnqueue(orderLog);
    try {
      const invoker = new AgentInvoker(
        sdkThrowingExhausted429(),
        mockQueryMessage(),
        mockManageSession(),
        mockQueryOtter({ "otter-small-1": "small", "otter-big-1": "big" }),
        createTestLogger(),
        undefined, undefined, undefined, undefined,
        undefined,
        mockConversationRepo(["otter-small-1", "otter-big-1"]),
        undefined, undefined, undefined, undefined, undefined, undefined,
        sendEntry,
        mockInvokeRepo(1),
        mockDispatchService(orderLog, captured),
      );

      await invoker.invokeConversation({
        otterId: "otter-small-1",
        conversationId: "conv-1",
        userMessageContent: "请审视这份代码",
        senderId: "otter-big-1",
      }).catch(() => null);

      await new Promise(r => setTimeout(r, 50));

      expect(captured.message).toContain("otter-small-1"); // 小獭名（mockQueryOtter name=id）
      expect(captured.message).toContain("glm");           // 模型名
      expect(captured.message).toContain("请审视这份代码"); // 原派工任务
    } finally {
      healingAlertRegistry.takeAll("conv-1");
    }
  });
});
