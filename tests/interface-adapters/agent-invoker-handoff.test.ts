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
import type { Logger } from "@usecases/ports/logger";
import { MIN_SENSIBLE_CTX_WINDOW } from "@usecases/ports/otter-context-window-provider";
import type { OtterContextWindowProvider } from "@usecases/ports/otter-context-window-provider";

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

function mockSdkInvoke(result?: { text?: string; directText?: string; ctxTokens?: number; lastStopReason?: string }) {
  // F20260901dtfx D1 同构修复：生产 invoke 结果的 text 是 buildInvokeResult 占位空串
  // （circuit-breaker-helpers.ts:118），LLM 直出在 directText（turnText 缓冲）。
  // mock 必须复现这个形状——旧 mock 返回 text:"Hello" 是无 directText 的不同构形状，
  // 掩盖了合成闭包只读 text 导致 100% 误判降级的 bug（PR #618 上线后 3/3 合成失败）。
  const direct = result?.directText ?? result?.text ?? "Hello";
  return {
    invoke: vi.fn().mockImplementation(async () => ({
      // 生产形状：text 恒空串，直出在 directText
      text: "",
      directText: direct,
      tokenUsage: { input: 1000, output: 500 },
      ctxTokens: result?.ctxTokens ?? 100000,
      ctxMax: 128000,
      lastStopReason: result?.lastStopReason,
    })),
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

/**
 * F20260901cxmw：捕获 structured data 的 logger（cxrev 审视发现 #2 补强）。
 * 共享 helpers 的 createCapturingLogger 只存 message 字符串；本测试需断言
 * [handoff] ctxMax resolved 事件中的 ctxMax/source 字段值，内联实现避免
 * 改动共享 helper 影响其他消费者。
 */
function createDataCapturingLogger() {
  const infoCalls: Array<{ msg: string; data?: Record<string, unknown> }> = [];
  const logger: Logger = {
    info: (msg: string, data?: Record<string, unknown>) => { infoCalls.push({ msg, data }); },
    warn: () => {}, error: () => {}, debug: () => {},
    child: () => logger,
  };
  return { logger, infoCalls };
}

/**
 * F20260901cxmw：ctxWindowProvider mock。
 * D1：形状与生产闭包同构（platforms.ts 组装的 getOtterContextWindow 签名），
 * 内部用真实 Map 存窗口，支持状态断言（D7：断言行为结果不绑定调用参数）。
 */
function mockCtxWindowProvider(windowsByOtter: Record<string, number | undefined>) {
  const windows = new Map(Object.entries(windowsByOtter));
  const calls: string[] = [];
  return {
    getOtterContextWindow: (otterId: string): number | undefined => {
      calls.push(otterId);
      return windows.get(otterId);
    },
    _windows: windows,
    _calls: calls,
  } as OtterContextWindowProvider & { _windows: Map<string, number | undefined>; _calls: string[] };
}

// eslint-disable-next-line max-lines-per-function -- Phase 1+2 handoff 测试集
describe("F20260825hndf 优雅上下文交接", () => {
  // F20260903cmpk：70% Pre-invoke 自动触发链路已退役（压缩算法由 session_before_compact 钩子接管，
  // Pi threshold 检查为唯一触发方）。以下用例从"阈值触发 handoff"反转为"阈值不再触发"——
  // 回归防线：若有人恢复 Pre-invoke 检查，本组用例变红。
  describe("F20260903cmpk：70% Pre-invoke 自动 handoff 退役（原 F20260901cxmw 阈值组反转）", () => {
    it("otter 配了模型窗口（200k）：阈值按实际窗口计算，不再被 128k 一刀切提前触发", async () => {
      const sdkInvoke = mockSdkInvoke({ ctxTokens: 100000 });
      const sendMessage = mockSendMessage();
      const queryMessage = mockQueryMessage();
      const manageSession = mockManageSession();
      const queryOtter = mockQueryOtter();
      const buildHandoffPkg = mockBuildHandoffPackage();
      // 修前：100000 >= 89600 (0.7×128k) → 误触发；修后：100000 < 140000 (0.7×200k) → 不触发
      const ctxWindowProvider = mockCtxWindowProvider({ "otter-1": 200000 });
      const { logger, infoCalls } = createDataCapturingLogger();

      const invoker = new AgentInvoker(
        sdkInvoke, sendMessage, queryMessage, manageSession,
        queryOtter, logger, undefined, undefined, undefined,
        undefined, undefined,
        mockConversationRepo(), undefined, undefined, undefined, buildHandoffPkg,
        undefined, ctxWindowProvider,
      );

      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "Hello", senderId: "user-1",
      });
      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "World", senderId: "user-1",
      });

      // 阈值线从 89600 抬到 140000 后，100k 不再触发（D7：断言副作用不存在）
      expect(buildHandoffPkg).not.toHaveBeenCalled();
      expect(manageSession.restartSession).not.toHaveBeenCalled();
      // cxrev 发现 #2 的可观测日志随 Pre-invoke 检查一并退役（F20260903cmpk）：
      // ctxMax 解析仅剩 getCtxMax 消费方（ retired），不再有 "[handoff] ctxMax resolved" 日志
      const resolved = infoCalls.filter((c) => c.msg === "[handoff] ctxMax resolved");
      expect(resolved).toHaveLength(0);
    });

    it("小窗口模型（64k）：50k 用量不再触发 handoff（阈值链路退役，压缩归 Pi 钩子）", async () => {
      const sdkInvoke = mockSdkInvoke({ ctxTokens: 50000 });
      const sendMessage = mockSendMessage();
      const queryMessage = mockQueryMessage();
      const manageSession = mockManageSession();
      const queryOtter = mockQueryOtter();
      const buildHandoffPkg = mockBuildHandoffPackage();
      // 修前：50000 < 89600 → 不触发（但可能已超出真实窗口，交接失明）；
      // 修后：50000 >= 44800 (0.7×64k) → 正确触发
      const ctxWindowProvider = mockCtxWindowProvider({ "otter-1": 64000 });

      const invoker = new AgentInvoker(
        sdkInvoke, sendMessage, queryMessage, manageSession,
        queryOtter, createTestLogger(), undefined, undefined, undefined,
        undefined, undefined,
        mockConversationRepo(), undefined, undefined, undefined, buildHandoffPkg,
        undefined, ctxWindowProvider,
      );

      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "Hello", senderId: "user-1",
      });
      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "World", senderId: "user-1",
      });

      // F20260903cmpk：退役后任何阈值都不再触发（断言反转）
      expect(buildHandoffPkg).not.toHaveBeenCalled();
      expect(manageSession.restartSession).not.toHaveBeenCalled();
    });

    it("回退链：provider 返回 undefined（窗口缺失/未配置）→ 回退 128k，阈值线不变", async () => {
      const sdkInvoke = mockSdkInvoke({ ctxTokens: 100000 });
      const sendMessage = mockSendMessage();
      const queryMessage = mockQueryMessage();
      const manageSession = mockManageSession();
      const queryOtter = mockQueryOtter();
      const buildHandoffPkg = mockBuildHandoffPackage();
      const ctxWindowProvider = mockCtxWindowProvider({ "otter-1": undefined });

      const invoker = new AgentInvoker(
        sdkInvoke, sendMessage, queryMessage, manageSession,
        queryOtter, createTestLogger(), undefined, undefined, undefined,
        undefined, undefined,
        mockConversationRepo(), undefined, undefined, undefined, buildHandoffPkg,
        undefined, ctxWindowProvider,
      );

      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "Hello", senderId: "user-1",
      });
      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "World", senderId: "user-1",
      });

      // F20260903cmpk：退役后不再触发
      expect(buildHandoffPkg).not.toHaveBeenCalled();
    });

    it("回退链：窗口 < 合理下限（SDK 缺省视为 0，阈值会恒真）→ 回退 128k；解析结果记日志（可观测）", async () => {
      const sdkInvoke = mockSdkInvoke({ ctxTokens: 50000 });
      const sendMessage = mockSendMessage();
      const queryMessage = mockQueryMessage();
      const manageSession = mockManageSession();
      const queryOtter = mockQueryOtter();
      const buildHandoffPkg = mockBuildHandoffPackage();
      const ctxWindowProvider = mockCtxWindowProvider({ "otter-1": 0 });
      // 捕获 structured data 的 logger：验证可观测日志（低噪声：每 otter 首次解析一条）
      const { logger, infoCalls } = createDataCapturingLogger();

      const invoker = new AgentInvoker(
        sdkInvoke, sendMessage, queryMessage, manageSession,
        queryOtter, logger, undefined, undefined, undefined,
        undefined, undefined,
        undefined, undefined, undefined, undefined, buildHandoffPkg,
        undefined, ctxWindowProvider,
      );

      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "Hello", senderId: "user-1",
      });
      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "World", senderId: "user-1",
      });

      // 0 不可用 → 128k 兜底：50000 < 89600 → 不触发（若直接用 0，任何正数都触发，阈值失明）
      expect(buildHandoffPkg).not.toHaveBeenCalled();
      // 可观测日志随 Pre-invoke 检查一并退役（F20260903cmpk）
      const resolved = infoCalls.filter((c) => c.msg === "[handoff] ctxMax resolved");
      expect(resolved).toHaveLength(0);
      // MIN_SENSIBLE_CTX_WINDOW 导出常量与实现同步
      expect(MIN_SENSIBLE_CTX_WINDOW).toBeGreaterThan(0);
    });

    it("provider 未注入（旧测试/降级环境）：保持 128k 兼容行为，不抛错", async () => {
      const sdkInvoke = mockSdkInvoke({ ctxTokens: 100000 });
      const sendMessage = mockSendMessage();
      const queryMessage = mockQueryMessage();
      const manageSession = mockManageSession();
      const queryOtter = mockQueryOtter();
      const buildHandoffPkg = mockBuildHandoffPackage();

      // 构造函数第 18 位不传（undefined）——真实未注入场景
      const invoker = new AgentInvoker(
        sdkInvoke, sendMessage, queryMessage, manageSession,
        queryOtter, createTestLogger(), undefined, undefined, undefined,
        undefined, undefined,
        mockConversationRepo(), undefined, undefined, undefined, buildHandoffPkg,
      );

      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "Hello", senderId: "user-1",
      });
      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "World", senderId: "user-1",
      });

      // F20260903cmpk：退役后不再触发
      expect(buildHandoffPkg).not.toHaveBeenCalled();
    });
  });

  // F20260903cmpk：pre-invoke 检查已退役，本组反转为回归防线（恢复 Pre-invoke 检查会变红）
  describe("pre-invoke 检查已退役（原 70% 触发组，反转）", () => {
    it("ctxTokens >= 70% 不再触发 handoff（自动链路退役）", async () => {
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

      // 第二次 invoke：原 70% 检查点（F20260903cmpk 已退役）——不应有任何 handoff 副作用
      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "World", senderId: "user-1",
      });

      // F20260903cmpk：反转断言——自动链路退役后无 handoff 副作用
      expect(manageContext._writtenKeys.has("handoff_file_trail")).toBe(false);
      expect(manageContext._writtenKeys.has("handoff_recency_window")).toBe(false);
      expect(manageContext._writtenKeys.has("handoff_state_inventory")).toBe(false);
      expect(manageSession.restartSession).not.toHaveBeenCalled();
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

      // F20260903cmpk：70% 自动触发退役，直调 handleHandoff 驱动合成路径
      await (invoker as unknown as { handleHandoff: (otterId: string, conversationId: string) => Promise<void> }).handleHandoff("otter-1", "conv-1");

      // buildHandoffPkg 应被调用，且包含 synthesize 函数
      expect(buildHandoffPkg).toHaveBeenCalledOnce();
      const callArgs = buildHandoffPkg.mock.calls[0];
      // 第三个参数应包含 synthesize 函数
      expect(callArgs[2]).toHaveProperty("synthesize");
      expect(typeof callArgs[2].synthesize).toBe("function");
      // 且包含 trigger 参数
      expect(callArgs[2]).toHaveProperty("trigger", "70%阈值");
    });

    it("F20260901dtfx 回归：合成闭包从 directText 提取文本（生产形状 text 恒空）", async () => {
      // PR #618 上线后 3/3 合成失败的根因：生产 invoke 结果 text 是占位空串，
      // 直出在 directText。旧 mock 返回 text:"Hello"（不同构）掩盖了 bug。
      // 本用例用生产形状 mock（text:"" + directText）驱动真实闭包。
      const sdkInvoke = mockSdkInvoke({ ctxTokens: 100000, directText: "## 交接摘要\n叙事合成内容" });
      const manageSession = mockManageSession();
      const manageContext = mockManageContext();
      let capturedSynthesize: ((prompt: string) => Promise<string>) | undefined;
      const buildHandoffPkg = vi.fn().mockImplementation(
        async (_convId: string, _otterId: string, options: { synthesize?: (prompt: string) => Promise<string> }) => {
          capturedSynthesize = options.synthesize;
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
        sdkInvoke, mockSendMessage(), mockQueryMessage(), manageSession,
        mockQueryOtter(), createTestLogger(), undefined, undefined, undefined,
        undefined, undefined,
        mockConversationRepo(), mockScheduledTaskRepo(),
        () => Promise.resolve<LinkedResource[]>([]),
        manageContext, buildHandoffPkg,
      );

      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "Hello", senderId: "user-1",
      });

      // F20260903cmpk：70% 自动触发退役，直调 handleHandoff 驱动合成路径
      await (invoker as unknown as { handleHandoff: (otterId: string, conversationId: string) => Promise<void> }).handleHandoff("otter-1", "conv-1");

      // 真实闭包应从 directText 提取成功，而非抛 empty result
      expect(capturedSynthesize).toBeDefined();
      const text = await capturedSynthesize!("test prompt");
      expect(text).toBe("## 交接摘要\n叙事合成内容");
    });

    it("F20260901dtfx 回归：directText 与 text 全空时闭包抛错（走防线②降级）", async () => {
      const sdkInvoke = mockSdkInvoke({ ctxTokens: 100000, directText: "" });
      const manageSession = mockManageSession();
      const manageContext = mockManageContext();
      let capturedSynthesize: ((prompt: string) => Promise<string>) | undefined;
      const buildHandoffPkg = vi.fn().mockImplementation(
        async (_convId: string, _otterId: string, options: { synthesize?: (prompt: string) => Promise<string> }) => {
          capturedSynthesize = options.synthesize;
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
        sdkInvoke, mockSendMessage(), mockQueryMessage(), manageSession,
        mockQueryOtter(), createTestLogger(), undefined, undefined, undefined,
        undefined, undefined,
        mockConversationRepo(), mockScheduledTaskRepo(),
        () => Promise.resolve<LinkedResource[]>([]),
        manageContext, buildHandoffPkg,
      );

      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "Hello", senderId: "user-1",
      });
      // F20260903cmpk：70% 自动触发退役，直调 handleHandoff 驱动合成路径
      await (invoker as unknown as { handleHandoff: (otterId: string, conversationId: string) => Promise<void> }).handleHandoff("otter-1", "conv-1");

      // 全空 → 闭包抛 empty result → 由 builder 的 catch 降级机械转储（防线②）
      expect(capturedSynthesize).toBeDefined();
      await expect(capturedSynthesize!("test prompt")).rejects.toThrow("LLM synthesis returned empty result");
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

      // F20260903cmpk：70% 自动触发退役，直调 handleHandoff 驱动合成路径
      await (invoker as unknown as { handleHandoff: (otterId: string, conversationId: string) => Promise<void> }).handleHandoff("otter-1", "conv-1");

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


      // F20260903cmpk：70% 自动触发退役，直调 handleHandoff 驱动（手动/熔断路径保留的同款逻辑）
      await (invoker as unknown as { handleHandoff: (otterId: string, conversationId: string) => Promise<void> }).handleHandoff("otter-1", "conv-1");
      console.log("DEBUG pkg calls:", (buildHandoffPkg as ReturnType<typeof vi.fn>).mock.calls.length);

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

    it("F20260903lngth：length-stop 截断摘要 fail-closed——闭包抛错不走成功路径（借鉴 Pi getSummarizationFailure）", async () => {
      // stopReason=length 时 SDK 不抛错、directText 非空、看似成功——
      // 截断摘要写进 session.summary 会误导下一代海獭。闭包必须拒绝。
      const sdkInvoke = mockSdkInvoke({ ctxTokens: 100000, directText: "## 交接摘要\n被截断的叙事…", lastStopReason: "length" });
      const manageSession = mockManageSession();
      const manageContext = mockManageContext();
      let capturedSynthesize: ((prompt: string) => Promise<string>) | undefined;
      const buildHandoffPkg = vi.fn().mockImplementation(
        async (
          _convId: string,
          _otterId: string,
          options: { synthesize?: (prompt: string) => Promise<string> },
        ) => {
          capturedSynthesize = options.synthesize;
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
        sdkInvoke, mockSendMessage(), mockQueryMessage(), manageSession,
        mockQueryOtter(), createTestLogger(), undefined, undefined, undefined,
        undefined, undefined,
        mockConversationRepo(), mockScheduledTaskRepo(),
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

      expect(capturedSynthesize).toBeDefined();
      // 截断摘要必须被拒绝（throw），即使 directText 非空
      await expect(capturedSynthesize!("test prompt")).rejects.toThrow(/truncated/);
    });

    it("F20260903lngth：stopReason 非 length（如 stop_end_input）不误杀，正常返回合成文本", async () => {
      const sdkInvoke = mockSdkInvoke({ ctxTokens: 100000, directText: "## 交接摘要\n完整叙事", lastStopReason: "stop_end_input" });
      const manageSession = mockManageSession();
      const manageContext = mockManageContext();
      let capturedSynthesize: ((prompt: string) => Promise<string>) | undefined;
      const buildHandoffPkg = vi.fn().mockImplementation(
        async (_convId: string, _otterId: string, options: { synthesize?: (prompt: string) => Promise<string> }) => {
          capturedSynthesize = options.synthesize;
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
        sdkInvoke, mockSendMessage(), mockQueryMessage(), manageSession,
        mockQueryOtter(), createTestLogger(), undefined, undefined, undefined,
        undefined, undefined,
        mockConversationRepo(), mockScheduledTaskRepo(),
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

      expect(capturedSynthesize).toBeDefined();
      const text = await capturedSynthesize!("test prompt");
      expect(text).toBe("## 交接摘要\n完整叙事");
    });
  });
});
