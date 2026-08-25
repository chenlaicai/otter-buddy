/**
 * F20260825hndf 优雅上下文交接测试
 *
 * 验证 pre-invoke → handleHandoff → restartSession 真实走通，
 * 覆盖生产同款参数构造（D1/D3/D7 验收核心）。
 *
 * 断言策略（D7）：使用 mock 内部状态断言（_writtenKeys/_store）替代
 * toHaveBeenCalledWith 参数断言，避免绑定实现细节。
 */
import { describe, it, expect, vi } from "vitest";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { SdkInvokePort } from "@usecases/ports/sdk-invoke-port";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Message } from "@entities/conversation/message";
import type { OtterSession } from "@entities/otter/otter-session";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { ScheduledTaskRepository } from "@usecases/scheduled-task/scheduled-task-repository";
import type { ManageContext } from "@usecases/otter/manage-context";
import type { LinkedResource } from "@entities/conversation/conversation";
import { createTestLogger } from "../helpers/logger";

const streamingMsg: Message = {
  id: "msg-1", conversationId: "conv-1", turnId: "turn-1",
  senderType: "otter", senderId: "otter-1",
  talkingStonePassedTo: null, status: "streaming",
  segments: [],
  sequenceNum: 1, contextTokens: null, contextTokensMax: null,
  source: "web", senderName: "Test Otter",
  createdAt: "2026-08-25T00:00:00Z", completedAt: null,
};

const completedMsg: Message = {
  id: "msg-1", conversationId: "conv-1", turnId: "turn-1",
  senderType: "otter", senderId: "otter-1",
  talkingStonePassedTo: ["user-1"], status: "completed",
  segments: [{ id: "seg-1", messageId: "msg-1", body: "Response", sequenceNum: 1, createdAt: "2026-08-25T00:00:00Z" }],
  sequenceNum: 1, contextTokens: 100000, contextTokensMax: 128000,
  source: "web", senderName: "Test Otter",
  createdAt: "2026-08-25T00:00:00Z", completedAt: "2026-08-25T00:00:01Z",
};

function mockSendMessage() {
  return {
    start: vi.fn().mockResolvedValue(streamingMsg),
    complete: vi.fn().mockResolvedValue({
      message: completedMsg,
      turnClose: { closed: true, aggregatedTargets: ["user-1"] },
    }),
    fail: vi.fn(),
    abort: vi.fn(),
    appendEvent: vi.fn(),
    sendSystem: vi.fn(),
    updateTokenUsage: vi.fn(),
    prepareForRetry: vi.fn().mockResolvedValue({ ...streamingMsg }),
  } as unknown as SendMessage;
}

function mockQueryMessage(overrides?: Partial<QueryMessage>) {
  return {
    getMessageById: vi.fn().mockResolvedValue(completedMsg),
    getMessages: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as QueryMessage;
}

function makeSession(overrides: Partial<OtterSession> = {}): OtterSession {
  return {
    id: "sess-1", otterId: "otter-1", status: "active",
    previousSessionId: null, startedAt: "2026-08-25T00:00:00Z",
    archivedAt: null, archiveReason: null, isNegativeCase: false,
    summary: null,
    ...overrides,
  };
}

function mockManageSession(session?: OtterSession) {
  return {
    getActiveSession: vi.fn().mockResolvedValue(session ?? makeSession()),
    restartSession: vi.fn().mockResolvedValue(makeSession({ id: "sess-2", previousSessionId: "sess-1" })),
    createSession: vi.fn(),
    getContext: vi.fn().mockResolvedValue({}),
    setContext: vi.fn(),
    deleteContext: vi.fn(),
  } as unknown as ManageSession;
}

function mockSdkInvoke(result?: { text?: string; ctxTokens?: number }) {
  return {
    invoke: vi.fn().mockResolvedValue({
      text: result?.text ?? "Hello",
      tokenUsage: { input: 1000, output: 500 },
      ctxTokens: result?.ctxTokens ?? 100000,
      ctxMax: 128000,
    }),
    abort: vi.fn(),
    getToolCallCount: vi.fn().mockReturnValue(0),
    getInternalAbortReason: vi.fn().mockReturnValue(undefined),
  } as unknown as SdkInvokePort;
}

function mockQueryOtter() {
  return {
    getById: vi.fn().mockResolvedValue({ id: "otter-1", name: "Test Otter", type: "big" }),
  } as unknown as QueryOtter;
}

function mockConversationRepo() {
  return {
    getLinkedResources: vi.fn().mockResolvedValue([]),
    listConversationsWithMeta: vi.fn().mockResolvedValue([]),
  } as unknown as ConversationRepository;
}

function mockScheduledTaskRepo() {
  return {
    getByConversationId: vi.fn().mockResolvedValue([]),
  } as unknown as ScheduledTaskRepository;
}

/**
 * D7：manageContext mock 自带状态追踪。
 * _writtenKeys 记录所有被 set 过的 key（持久，不被 delete 清除），
 * _store 是当前存活的 KV（会被 restoreHandoffContext 的 delete 消费）。
 */
function mockManageContext() {
  const store = new Map<string, string>();
  const writtenKeys = new Set<string>();
  return {
    get: vi.fn().mockImplementation((_otterId: string, key?: string) => {
      if (key) return Promise.resolve({ [key]: store.get(key) });
      return Promise.resolve(Object.fromEntries(store));
    }),
    set: vi.fn().mockImplementation((_otterId: string, key: string, value: string) => {
      store.set(key, value);
      writtenKeys.add(key);
      return Promise.resolve();
    }),
    delete: vi.fn().mockImplementation((_otterId: string, key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    _store: store,
    _writtenKeys: writtenKeys,
  } as unknown as ManageContext & { _store: Map<string, string>; _writtenKeys: Set<string> };
}

function mockBuildHandoffPackage() {
  return vi.fn().mockResolvedValue({
    summary: "## 交接摘要（机械转储）",
    fileTrail: "## 文件轨迹（工作区存量）",
    recencyWindow: "## 近期原文",
    stateInventory: "## 活状态盘点",
    totalTokenEstimate: 5000,
  });
}

describe("F20260825hndf 优雅上下文交接", () => {
  describe("pre-invoke 检查触发 handleHandoff", () => {
    it("ctxTokens >= 70% 时触发 handoff 并重启 session", async () => {
      const sdkInvoke = mockSdkInvoke({ ctxTokens: 100000 });
      const sendMessage = mockSendMessage();
      const queryMessage = mockQueryMessage();
      const manageSession = mockManageSession();
      const queryOtter = mockQueryOtter();
      const conversationRepo = mockConversationRepo();
      const scheduledTaskRepo = mockScheduledTaskRepo();
      const manageContext = mockManageContext();
      const buildHandoffPkg = mockBuildHandoffPackage();

      const invoker = new AgentInvoker(
        sdkInvoke, sendMessage, queryMessage, manageSession,
        queryOtter, createTestLogger(), undefined, undefined, undefined,
        undefined, undefined,
        conversationRepo, scheduledTaskRepo,
        () => Promise.resolve<LinkedResource[]>([]),
        manageContext, buildHandoffPkg,
      );

      // 第一次 invoke：post-turn 记录 ctxTokens=100000
      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "Hello", senderId: "user-1",
      });

      // 第二次 invoke：pre-invoke 检查 100000 >= 89600 → 触发 handoff
      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "World", senderId: "user-1",
      });

      // D7：断言状态（不绑定调用参数）
      // _writtenKeys 记录 handleHandoff 写入的 key（持久，不被 delete 清除）
      expect(manageContext._writtenKeys.has("handoff_file_trail")).toBe(true);
      expect(manageContext._writtenKeys.has("handoff_recency_window")).toBe(true);
      expect(manageContext._writtenKeys.has("handoff_state_inventory")).toBe(true);

      // _store 应为空——restoreHandoffContext 已消费（借用式生命周期）
      expect(manageContext._store.size).toBe(0);

      // restartSession 被调用（断言副作用存在）
      expect(manageSession.restartSession).toHaveBeenCalledOnce();
    });

    it("ctxTokens < 70% 时不触发 handoff", async () => {
      const sdkInvoke = mockSdkInvoke({ ctxTokens: 50000 });
      const sendMessage = mockSendMessage();
      const lowCtxMsg = { ...completedMsg, contextTokens: 50000 };
      const queryMessage = mockQueryMessage({ getMessageById: vi.fn().mockResolvedValue(lowCtxMsg) });
      const manageSession = mockManageSession();
      const queryOtter = mockQueryOtter();
      const buildHandoffPkg = mockBuildHandoffPackage();

      const invoker = new AgentInvoker(
        sdkInvoke, sendMessage, queryMessage, manageSession,
        queryOtter, createTestLogger(), undefined, undefined, undefined,
        undefined, undefined,
        undefined, undefined, undefined, undefined, buildHandoffPkg,
      );

      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "Hello", senderId: "user-1",
      });

      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "World", senderId: "user-1",
      });

      // 断言副作用不存在
      expect(buildHandoffPkg).not.toHaveBeenCalled();
      expect(manageSession.restartSession).not.toHaveBeenCalled();
    });

    it("buildHandoffPkg 未注入时跳过 handoff（不崩溃）", async () => {
      const sdkInvoke = mockSdkInvoke({ ctxTokens: 100000 });
      const sendMessage = mockSendMessage();
      const queryMessage = mockQueryMessage();
      const manageSession = mockManageSession();
      const queryOtter = mockQueryOtter();

      const invoker = new AgentInvoker(
        sdkInvoke, sendMessage, queryMessage, manageSession,
        queryOtter, createTestLogger(), undefined, undefined, undefined,
        undefined, undefined,
      );

      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "Hello", senderId: "user-1",
      });

      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "World", senderId: "user-1",
      });

      expect(manageSession.restartSession).not.toHaveBeenCalled();
    });
  });
});
