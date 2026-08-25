/**
 * F20260825hndf 优雅上下文交接测试
 *
 * 验证 pre-invoke → handleHandoff → restartSession 真实走通，
 * 覆盖生产同款参数构造（D1/D3 验收核心）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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

/** 模拟消息 */
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
  const text = result?.text ?? "Hello";
  return {
    invoke: vi.fn().mockResolvedValue({
      text,
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

function mockManageContext() {
  const store = new Map<string, string>();
  return {
    get: vi.fn().mockImplementation((_otterId: string, key?: string) => {
      if (key) return Promise.resolve({ [key]: store.get(key) });
      return Promise.resolve(Object.fromEntries(store));
    }),
    set: vi.fn().mockImplementation((_otterId: string, key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn().mockImplementation((_otterId: string, key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    _store: store,
  } as unknown as ManageContext & { _store: Map<string, string> };
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
      const sdkInvoke = mockSdkInvoke({ ctxTokens: 100000 }); // 100k > 128k * 0.7 = 89.6k
      const sendMessage = mockSendMessage();
      const queryMessage = mockQueryMessage();
      const manageSession = mockManageSession();
      const queryOtter = mockQueryOtter();
      const conversationRepo = mockConversationRepo();
      const scheduledTaskRepo = mockScheduledTaskRepo();
      const manageContext = mockManageContext();
      const buildHandoffPkg = mockBuildHandoffPackage();
      const logger = createTestLogger();

      const invoker = new AgentInvoker(
        sdkInvoke, sendMessage, queryMessage, manageSession,
        queryOtter, logger, undefined, undefined, undefined,
        undefined, undefined, // metrics, healingRepo
        conversationRepo, scheduledTaskRepo,
        (_cid: string) => Promise.resolve<LinkedResource[]>([]),
        manageContext, buildHandoffPkg,
      );

      // 第一次 invoke：post-turn 记录 ctxTokens
      await invoker.invokeConversation({
        otterId: "otter-1",
        conversationId: "conv-1",
        userMessageContent: "Hello",
        senderId: "user-1",
      });

      // 第二次 invoke：pre-invoke 检查应触发 handoff
      await invoker.invokeConversation({
        otterId: "otter-1",
        conversationId: "conv-1",
        userMessageContent: "World",
        senderId: "user-1",
      });

      // 验证 buildHandoffPkg 被调用（handoff 真实发生）
      expect(buildHandoffPkg).toHaveBeenCalledWith(
        "conv-1",
        "otter-1",
        expect.objectContaining({
          queryMessage,
          stateInventoryDeps: expect.objectContaining({
            queryMessage,
            conversationRepo,
          }),
        }),
      );

      // 验证 restartSession 被调用
      expect(manageSession.restartSession).toHaveBeenCalledWith(
        "otter-1",
        expect.stringContaining("交接摘要"),
      );

      // 验证 context 被写入（件②③④）
      expect(manageContext.set).toHaveBeenCalledWith("otter-1", "handoff_file_trail", expect.any(String));
      expect(manageContext.set).toHaveBeenCalledWith("otter-1", "handoff_recency_window", expect.any(String));
      expect(manageContext.set).toHaveBeenCalledWith("otter-1", "handoff_state_inventory", expect.any(String));
    });

    it("ctxTokens < 70% 时不触发 handoff", async () => {
      const sdkInvoke = mockSdkInvoke({ ctxTokens: 50000 }); // 50k < 89.6k
      const sendMessage = mockSendMessage();
      // Mock getMessageById to return message with low contextTokens
      const lowCtxMsg = { ...completedMsg, contextTokens: 50000 };
      const queryMessage = mockQueryMessage({ getMessageById: vi.fn().mockResolvedValue(lowCtxMsg) });
      const manageSession = mockManageSession();
      const queryOtter = mockQueryOtter();
      const buildHandoffPkg = mockBuildHandoffPackage();
      const logger = createTestLogger();

      const invoker = new AgentInvoker(
        sdkInvoke, sendMessage, queryMessage, manageSession,
        queryOtter, logger, undefined, undefined, undefined,
        undefined, undefined,
        undefined, undefined, undefined, undefined, buildHandoffPkg,
      );

      // 第一次 invoke
      await invoker.invokeConversation({
        otterId: "otter-1",
        conversationId: "conv-1",
        userMessageContent: "Hello",
        senderId: "user-1",
      });

      // 第二次 invoke
      await invoker.invokeConversation({
        otterId: "otter-1",
        conversationId: "conv-1",
        userMessageContent: "World",
        senderId: "user-1",
      });

      // buildHandoffPkg 不应被调用
      expect(buildHandoffPkg).not.toHaveBeenCalled();
      expect(manageSession.restartSession).not.toHaveBeenCalled();
    });

    it("buildHandoffPkg 未注入时跳过 handoff（不崩溃）", async () => {
      const sdkInvoke = mockSdkInvoke({ ctxTokens: 100000 });
      const sendMessage = mockSendMessage();
      const queryMessage = mockQueryMessage();
      const manageSession = mockManageSession();
      const queryOtter = mockQueryOtter();
      const logger = createTestLogger();

      // 不传 buildHandoffPkg
      const invoker = new AgentInvoker(
        sdkInvoke, sendMessage, queryMessage, manageSession,
        queryOtter, logger, undefined, undefined, undefined,
        undefined, undefined,
      );

      // 第一次 invoke
      await invoker.invokeConversation({
        otterId: "otter-1",
        conversationId: "conv-1",
        userMessageContent: "Hello",
        senderId: "user-1",
      });

      // 第二次 invoke 不应崩溃
      await invoker.invokeConversation({
        otterId: "otter-1",
        conversationId: "conv-1",
        userMessageContent: "World",
        senderId: "user-1",
      });

      // restartSession 不应被调用
      expect(manageSession.restartSession).not.toHaveBeenCalled();
    });
  });
});
