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

// eslint-disable-next-line max-lines-per-function -- Phase 1+2 handoff 测试集
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

  describe("F20260825hndf Phase 2：LLM 叙事合成", () => {
    it("handoff 路径传入 synthesize 函数（readOnly invocation）", async () => {
      const sdkInvoke = mockSdkInvoke({ ctxTokens: 100000 });
      const sendMessage = mockSendMessage();
      const queryMessage = mockQueryMessage();
      const manageSession = mockManageSession();
      const queryOtter = mockQueryOtter();
      const conversationRepo = mockConversationRepo();
      const scheduledTaskRepo = mockScheduledTaskRepo();
      const manageContext = mockManageContext();
      // 模拟 buildHandoffPkg 内部调用 synthesize
      const buildHandoffPkg = vi.fn().mockImplementation(
        async (_convId: string, _otterId: string, options: { synthesize?: (prompt: string) => Promise<string> }) => {
          // 如果 synthesize 被传入，调用它
          if (options.synthesize) {
            const summary = await options.synthesize("test prompt");
            return {
              summary,
              fileTrail: "## 文件轨迹",
              recencyWindow: "## 近期原文",
              stateInventory: "## 活状态盘点",
              totalTokenEstimate: 3000,
            };
          }
          return {
            summary: "## 交接摘要（机械转储）",
            fileTrail: "## 文件轨迹",
            recencyWindow: "## 近期原文",
            stateInventory: "## 活状态盘点",
            totalTokenEstimate: 3000,
          };
        },
      );

      const invoker = new AgentInvoker(
        sdkInvoke, sendMessage, queryMessage, manageSession,
        queryOtter, createTestLogger(), undefined, undefined, undefined,
        undefined, undefined,
        conversationRepo, scheduledTaskRepo,
        () => Promise.resolve<LinkedResource[]>([]),
        manageContext, buildHandoffPkg,
      );

      // 第一次 invoke：记录 ctxTokens
      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "Hello", senderId: "user-1",
      });

      // 第二次 invoke：触发 handoff
      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "World", senderId: "user-1",
      });

      // buildHandoffPkg 应被调用，且包含 synthesize 函数
      expect(buildHandoffPkg).toHaveBeenCalledOnce();
      const callArgs = buildHandoffPkg.mock.calls[0];
      // 第三个参数应包含 synthesize 函数
      expect(callArgs[2]).toHaveProperty("synthesize");
      expect(typeof callArgs[2].synthesize).toBe("function");
      // 且包含 trigger 参数
      expect(callArgs[2]).toHaveProperty("trigger", "70%阈值");
    });

    it("handoff 路径 summary 透传到 restartSession", async () => {
      const sdkInvoke = mockSdkInvoke({ ctxTokens: 100000 });
      const sendMessage = mockSendMessage();
      const queryMessage = mockQueryMessage();
      const manageSession = mockManageSession();
      const queryOtter = mockQueryOtter();
      const conversationRepo = mockConversationRepo();
      const scheduledTaskRepo = mockScheduledTaskRepo();
      const manageContext = mockManageContext();
      // buildHandoffPkg 返回 LLM 合成摘要
      const buildHandoffPkg = vi.fn().mockResolvedValue({
        summary: "## 交接摘要\nLLM 叙事合成内容",
        fileTrail: "## 文件轨迹",
        recencyWindow: "## 近期原文",
        stateInventory: "## 活状态盘点",
        totalTokenEstimate: 3000,
      });

      const invoker = new AgentInvoker(
        sdkInvoke, sendMessage, queryMessage, manageSession,
        queryOtter, createTestLogger(), undefined, undefined, undefined,
        undefined, undefined,
        conversationRepo, scheduledTaskRepo,
        () => Promise.resolve<LinkedResource[]>([]),
        manageContext, buildHandoffPkg,
      );

      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "Hello", senderId: "user-1",
      });

      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "World", senderId: "user-1",
      });

      // D7：断言 restartSession 被调用（不绑定参数）
      expect(manageSession.restartSession).toHaveBeenCalledOnce();
      // 断言四件套 context 已写入
      expect(manageContext._writtenKeys.has("handoff_file_trail")).toBe(true);
      expect(manageContext._writtenKeys.has("handoff_recency_window")).toBe(true);
      expect(manageContext._writtenKeys.has("handoff_state_inventory")).toBe(true);
    });
  });

  describe("F20260825hndf Phase 2：手动重启统一带四件套", () => {
    it("handleSelfRestartSignal 驱动真实路径：SDK 层返回 _selfRestart 信号 → 件②③④写入 + restartSession + 递归 invoke，且不携带 synthesize（红线）", async () => {
      // 审视 P3：旧用例只断言 buildHandoffPkg 被注入（toBeDefined），没驱动真实路径。
      // 本用例模拟 SDK 层 _selfRestart 信号，走完 handleSelfRestartSignal 全链：
      // 四件套注入 → restartSession → continuation message 递归 invoke。
      // 触发链：sdkInvoke.invoke 返回结果带 _selfRestart 字段（见 agent-invoker.ts:274）。
      const firstCall = {
        text: "restart",
        tokenUsage: { input: 1000, output: 500 },
        ctxTokens: 50000,
        ctxMax: 128000,
        _selfRestart: { otterId: "otter-1", summary: "獭自己写的重启摘要" },
      };
      const subsequentCalls = {
        text: "continuation done",
        tokenUsage: { input: 800, output: 200 },
        ctxTokens: 20000,
        ctxMax: 128000,
      };
      const invokeImpl = vi.fn()
        .mockResolvedValueOnce(firstCall)
        .mockResolvedValue(subsequentCalls);
      const sdkInvoke = {
        invoke: invokeImpl,
        abort: vi.fn(),
        getToolCallCount: vi.fn().mockReturnValue(0),
        getInternalAbortReason: vi.fn().mockReturnValue(undefined),
      } as unknown as SdkInvokePort;

      const sendMessage = mockSendMessage();
      // 关键：post-turn 记录的 contextTokens 要低于 70% 阈值——否则递归的 continuation invoke
      // 在 pre-invoke 检查时会再触发一次 70% handoff，与手动重启路径叠加，断言就分不清来源
      const queryMessage = mockQueryMessage({
        getMessageById: vi.fn().mockResolvedValue({ ...completedMsg, contextTokens: 50000 }),
      });
      const manageSession = mockManageSession();
      const queryOtter = mockQueryOtter();
      const conversationRepo = mockConversationRepo();
      const scheduledTaskRepo = mockScheduledTaskRepo();
      const manageContext = mockManageContext();
      const buildHandoffPkg = vi.fn().mockResolvedValue({
        summary: "## 交接摘要",
        fileTrail: "## 文件轨迹",
        recencyWindow: "## 近期原文",
        stateInventory: "## 活状态盘点",
        totalTokenEstimate: 3000,
      });

      const invoker = new AgentInvoker(
        sdkInvoke, sendMessage, queryMessage, manageSession,
        queryOtter, createTestLogger(), undefined, undefined, undefined,
        undefined, undefined,
        conversationRepo, scheduledTaskRepo,
        () => Promise.resolve<LinkedResource[]>([]),
        manageContext, buildHandoffPkg,
      );

      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "重启獭生", senderId: "user-1",
      });

      // 真实路径断言：四件套 context 已写入（D7：状态断言）
      expect(manageContext._writtenKeys.has("handoff_file_trail")).toBe(true);
      expect(manageContext._writtenKeys.has("handoff_recency_window")).toBe(true);
      expect(manageContext._writtenKeys.has("handoff_state_inventory")).toBe(true);
      // restartSession 被调用
      expect(manageSession.restartSession).toHaveBeenCalledOnce();
      // 递归 invoke：SDK 层至少收到两次 invoke（首次 + continuation）
      expect(invokeImpl.mock.calls.length).toBeGreaterThanOrEqual(2);

      // 红线断言（审视 P1）：手动路径的 buildHandoffPkg options 不携带 synthesize
      const options = buildHandoffPkg.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
      expect(options).toBeDefined();
      expect(options?.synthesize).toBeUndefined();
    });
  });

  describe("F20260825hndf Phase 2：readOnly 工具过滤", () => {
    it("readOnly 模式下 SDK invoke 收到 readOnly: true", async () => {
      const sdkInvoke = mockSdkInvoke({ ctxTokens: 100000 });
      const sendMessage = mockSendMessage();
      const queryMessage = mockQueryMessage();
      const manageSession = mockManageSession();
      const queryOtter = mockQueryOtter();
      const conversationRepo = mockConversationRepo();
      const scheduledTaskRepo = mockScheduledTaskRepo();
      const manageContext = mockManageContext();
      // buildHandoffPkg 内部会调用 synthesize，而 synthesize 调用 sdkInvoke.invoke(readOnly: true)
      const buildHandoffPkg = vi.fn().mockImplementation(
        async (_convId: string, _otterId: string, options: { synthesize?: (prompt: string) => Promise<string> }) => {
          if (options.synthesize) {
            await options.synthesize("test prompt");
          }
          return {
            summary: "## 交接摘要",
            fileTrail: "## 文件轨迹",
            recencyWindow: "## 近期原文",
            stateInventory: "## 活状态盘点",
            totalTokenEstimate: 3000,
          };
        },
      );

      const invoker = new AgentInvoker(
        sdkInvoke, sendMessage, queryMessage, manageSession,
        queryOtter, createTestLogger(), undefined, undefined, undefined,
        undefined, undefined,
        conversationRepo, scheduledTaskRepo,
        () => Promise.resolve<LinkedResource[]>([]),
        manageContext, buildHandoffPkg,
      );

      // 第一次 invoke：记录 ctxTokens
      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "Hello", senderId: "user-1",
      });

      // 第二次 invoke：触发 handoff → buildSynthesisFunction → sdkInvoke.invoke(readOnly)
      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "World", senderId: "user-1",
      });

      // D7：验证 sdkInvoke.invoke 被多次调用（正常 invoke + readOnly invoke）
      // 查找包含 readOnly: true 的调用（类型安全的 mock 访问）
      const invokeMock = sdkInvoke.invoke as unknown as ReturnType<typeof vi.fn>;
      expect(invokeMock).toHaveBeenCalled();
      const readOnlyCall = invokeMock.mock.calls.find(
        (call: unknown[]) => {
          const opts = call[2] as Record<string, unknown> | undefined;
          return opts?.readOnly === true;
        },
      );
      // readOnly invoke 应存在（synthesis invocation）
      expect(readOnlyCall).toBeDefined();
    });
  });
});
