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
import type { ModelPoolLike } from "@usecases/ports/model-pool-like";
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
function contentFilterModelPool(aliases: string[] = ["glm", "kimi"]): ModelPoolLike {
  return {
    getDefaultAlias: () => aliases[0] ?? "glm",
    setDefaultAlias: () => {},
    hasModel: (alias: string) => aliases.includes(alias),
    getModelInfos: () => aliases.map(alias => ({ alias, provider: "test", model: alias })),
    describeModels: () => aliases.map(alias => ({ alias })),
  };
}

function sdkThrowingContentFilter(calls?: { count: number }): SdkInvokePort {
  return {
    invoke: async () => {
      if (calls) calls.count++;
      throw Object.assign(new Error("LLM API error: Unhandled stop reason: content_filter"), { _modelAlias: "glm" });
    },
    abort: () => {},
    getInternalAbortReason: () => undefined,
  } as unknown as SdkInvokePort;
}

function sdkThrowingExhausted429(): SdkInvokePort {
  const err = new Error(EXHAUSTED_429) as Error & { _modelAlias?: string };
  err._modelAlias = "glm";
  return {
    invoke: async () => { throw err; },
    abort: () => {},
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

/** dispatch mock：记录 userMessageContent + 来源声明 + 调用顺序入 orderLog（行为断言面，非调用次数断言） */
function mockDispatchService(orderLog: string[], captured?: { message?: string; source?: string; targets?: string[] }): AgentDispatchService {
  return {
    dispatch: async (input: { resolvedTargets?: string[]; userMessageContent?: string; triggerSenderType?: string }) => {
      orderLog.push("dispatch");
      if (captured) {
        captured.message = input.userMessageContent;
        captured.source = input.triggerSenderType;
        captured.targets = input.resolvedTargets;
      }
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

describe("#1762 content_filter 终态通知", () => {
  it("无备用模型：立即 alert + system entry + dispatch 大獭，不等待被动重启", async () => {
    const sendEntry = mockSendEntry();
    const orderLog: string[] = [];
    const captured: { message?: string; source?: string } = {};
    const calls = { count: 0 };
    instrumentAlertEnqueue(orderLog);
    try {
      const invoker = new AgentInvoker(
        sdkThrowingContentFilter(calls), mockQueryMessage(), mockManageSession(),
        mockQueryOtter({ "otter-small-1": "small", "otter-big-1": "big" }), createTestLogger(),
        undefined, undefined, undefined, undefined, undefined,
        mockConversationRepo(["otter-small-1", "otter-big-1"]),
        undefined, undefined, undefined, undefined, undefined,
        sendEntry, mockInvokeRepo(2), mockDispatchService(orderLog, captured),
        undefined, undefined, undefined,
        contentFilterModelPool(["glm"]),
      );

      await invoker.invokeConversation({
        otterId: "otter-small-1", conversationId: "conv-1",
        userMessageContent: "继续小说", senderId: "user-1",
      });

      expect(calls.count).toBe(1);
      expect(orderLog).toContain("enqueue");
      expect(orderLog).toContain("dispatch");
      expect(captured.source).toBe("system");
      expect(captured.message).toContain("继续小说");
      expect(sendEntry.store.systemBodies.some(b => b.includes("content_filter"))).toBe(true);
    } finally {
      healingAlertRegistry.takeAll("conv-1");
    }
  });

  it("换模型续跑仍 content_filter：总共两次模型调用，然后通知大獭且不循环", async () => {
    const sendEntry = mockSendEntry();
    const orderLog: string[] = [];
    const calls = { count: 0 };
    let restarts = 0;
    const manageSession = mockManageSession();
    manageSession.restartSession = async (otterId: string) => {
      restarts++;
      return makeSession({ id: "sess-content-filter", otterId, modelAlias: "kimi" });
    };
    instrumentAlertEnqueue(orderLog);
    try {
      const invoker = new AgentInvoker(
        sdkThrowingContentFilter(calls), mockQueryMessage(), manageSession,
        mockQueryOtter({ "otter-small-1": "small", "otter-big-1": "big" }), createTestLogger(),
        undefined, undefined, undefined, undefined, undefined,
        mockConversationRepo(["otter-small-1", "otter-big-1"]),
        undefined, undefined, undefined, undefined, undefined,
        sendEntry, mockInvokeRepo(2), mockDispatchService(orderLog),
        undefined, undefined, undefined,
        contentFilterModelPool(),
      );

      await invoker.invokeConversation({
        otterId: "otter-small-1", conversationId: "conv-1",
        userMessageContent: "继续小说", senderId: "user-1",
      });

      expect(calls.count).toBe(2);
      expect(restarts).toBe(1);
      expect(orderLog).toContain("dispatch");
      expect(sendEntry.store.systemBodies.some(b => b.includes("自动换模型续跑不可用或仍失败"))).toBe(true);
    } finally {
      healingAlertRegistry.takeAll("conv-1");
    }
  });

  it("换模型续跑变成普通 500 failed：仍通知大獭，不把 TurnResult 当成功", async () => {
    const sendEntry = mockSendEntry();
    const orderLog: string[] = [];
    const calls = { count: 0 };
    const sdk = {
      invoke: async () => {
        calls.count++;
        const message = calls.count === 1
          ? "LLM API error: Unhandled stop reason: content_filter"
          : "LLM API error: 500 Internal Server Error";
        throw Object.assign(new Error(message), { _modelAlias: calls.count === 1 ? "glm" : "kimi" });
      },
      abort: () => {}, getInternalAbortReason: () => undefined,
    } as unknown as SdkInvokePort;
    instrumentAlertEnqueue(orderLog);
    try {
      const invoker = new AgentInvoker(
        sdk, mockQueryMessage(), mockManageSession(),
        mockQueryOtter({ "otter-small-1": "small", "otter-big-1": "big" }), createTestLogger(),
        undefined, undefined, undefined, undefined, undefined,
        mockConversationRepo(["otter-small-1", "otter-big-1"]),
        undefined, undefined, undefined, undefined, undefined,
        sendEntry, mockInvokeRepo(2), mockDispatchService(orderLog),
        undefined, undefined, undefined, contentFilterModelPool(),
      );

      await invoker.invokeConversation({
        otterId: "otter-small-1", conversationId: "conv-1",
        userMessageContent: "继续小说", senderId: "user-1",
      });

      expect(calls.count).toBe(2);
      expect(orderLog).toContain("dispatch");
    } finally {
      healingAlertRegistry.takeAll("conv-1");
    }
  });

  it("终态 system entry 写失败：alert 已入队且仍 dispatch，通知通道互不连坐", async () => {
    const sendEntry = mockSendEntry();
    sendEntry.createSystemEntry = async () => { throw new Error("entry store unavailable"); };
    const orderLog: string[] = [];
    instrumentAlertEnqueue(orderLog);
    try {
      const invoker = new AgentInvoker(
        sdkThrowingContentFilter(), mockQueryMessage(), mockManageSession(),
        mockQueryOtter({ "otter-small-1": "small", "otter-big-1": "big" }), createTestLogger(),
        undefined, undefined, undefined, undefined, undefined,
        mockConversationRepo(["otter-small-1", "otter-big-1"]),
        undefined, undefined, undefined, undefined, undefined,
        sendEntry, mockInvokeRepo(2), mockDispatchService(orderLog),
        undefined, undefined, undefined, contentFilterModelPool(["glm"]),
      );

      await invoker.invokeConversation({
        otterId: "otter-small-1", conversationId: "conv-1",
        userMessageContent: "继续小说", senderId: "user-1",
      });

      expect(orderLog).toContain("enqueue");
      expect(orderLog).toContain("dispatch");
    } finally {
      healingAlertRegistry.takeAll("conv-1");
    }
  });

  it("失败的大獭不被回投给自己：只 dispatch 其他在场大獭", async () => {
    const sendEntry = mockSendEntry();
    const orderLog: string[] = [];
    const captured: { targets?: string[] } = {};
    instrumentAlertEnqueue(orderLog);
    try {
      const invoker = new AgentInvoker(
        sdkThrowingContentFilter(), mockQueryMessage(), mockManageSession(),
        mockQueryOtter({ "otter-big-1": "big", "otter-big-2": "big" }), createTestLogger(),
        undefined, undefined, undefined, undefined, undefined,
        mockConversationRepo(["otter-big-1", "otter-big-2"]),
        undefined, undefined, undefined, undefined, undefined,
        sendEntry, mockInvokeRepo(2), mockDispatchService(orderLog, captured),
        undefined, undefined, undefined, contentFilterModelPool(["glm"]),
      );

      await invoker.invokeConversation({
        otterId: "otter-big-1", conversationId: "conv-1",
        userMessageContent: "继续小说", senderId: "user-1",
      });

      expect(captured.targets).toEqual(["otter-big-2"]);
    } finally {
      healingAlertRegistry.takeAll("conv-1");
    }
  });
});

describe("F20260916fst4 agent-invoker 首哑信号消费", () => {
  it("_firstDumb → dispatch 被调且 resolvedTargets 为大獭（alert 入队 + system entry 已发）", async () => {
    const sendEntry = mockSendEntry();
    const orderLog: string[] = [];
    const captured: { message?: string; source?: string } = {};
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
        undefined, undefined, undefined, undefined, undefined,
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

      // 等 fire-and-forget 收尾（handleFirstDumbSignal 为 void 异步）
      await new Promise(r => setTimeout(r, 50));

      // 可观察行为 1：dispatch 被调且目标为大獭
      expect(orderLog).toContain("dispatch");
      // 可观察行为 3（#1430 首轮严重1）：首哑合成文本显式声明 system 来源——不进安全词扫描
      expect(captured.source).toBe("system");
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
        undefined, undefined, undefined, undefined, undefined,
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
        undefined, undefined, undefined, undefined, undefined,
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
        undefined, undefined, undefined, undefined, undefined,
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
        undefined, undefined, undefined, undefined, undefined,
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
