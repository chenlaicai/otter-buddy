/**
 * API 测试基础设施
 *
 * - createMockDeps: 创建类型安全的 mock 依赖
 * - createTestApp: 构建注入 mock 的 Hono 测试应用
 * - readSSEEvents: 读取 SSE 流内容
 * - fixtures: 常用测试数据工厂
 */
import { vi } from "vitest";
import { Hono } from "hono";
import { createRouter, type Controllers } from "../../src/interface-adapters/http/router";
import { ConversationController } from "../../src/interface-adapters/http/controllers/conversation-controller";
import { MessageController } from "../../src/interface-adapters/http/controllers/message-controller";
import { OtterController } from "../../src/interface-adapters/http/controllers/otter-controller";
import { MemoryController } from "../../src/interface-adapters/http/controllers/memory-controller";
import { KeyInfoController } from "../../src/interface-adapters/http/controllers/key-info-controller";
import { SettingsController, type SettingsConfig } from "../../src/interface-adapters/http/controllers/settings-controller";
import { ScheduledTaskController } from "../../src/interface-adapters/http/controllers/scheduled-task-controller";
import { DispatchChainEngine } from "../../src/usecases/conversation/dispatch-chain-engine";
import type { Logger } from "../../src/usecases/ports/logger";

/** 创建 noop Logger mock */
function mockLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => mockLogger(),
  };
}

/** 解析 Response JSON（避免 strict 模式下 unknown 报错） */
export async function json(res: Response): Promise<any> {
  return res.json();
}

/** 从 SSE 响应流中读取所有事件 */
export async function readSSEEvents(res: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  let buffer = "";
  let currentEvent = "";
  let currentData = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7);
      } else if (line.startsWith("data: ")) {
        currentData = line.slice(6);
      } else if (line === "" && currentEvent) {
        events.push({ event: currentEvent, data: JSON.parse(currentData) });
        currentEvent = "";
        currentData = "";
      }
    }
  }
  // Flush remaining buffer (may contain event: and/or data: lines without trailing \n\n)
  for (const line of buffer.split("\n")) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7);
    } else if (line.startsWith("data: ")) {
      currentData = line.slice(6);
    }
  }
  if (currentEvent && currentData) {
    events.push({ event: currentEvent, data: JSON.parse(currentData) });
  }

  return events;
}

// ─── Mock helpers ───

/** 创建指定方法名的 vi.fn mock 对象 */
function mockMethods(methods: string[]): Record<string, ReturnType<typeof vi.fn>> {
  const result: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const m of methods) {
    result[m] = vi.fn();
  }
  return result;
}

// ─── Entity fixture factories ───

export function makeConversation(overrides: Partial<{
  id: string;
  title: string;
  status: string;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
}> = {}) {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? "conv-1",
    title: overrides.title ?? "Test Conversation",
    status: overrides.status ?? "active",
    summary: overrides.summary ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    completedAt: overrides.completedAt ?? null,
    archivedAt: overrides.archivedAt ?? null,
  };
}

export function makeMessage(overrides: Partial<{
  id: string;
  conversationId: string;
  turnId: string;
  senderType: string;
  senderId: string;
  talkingStonePassedTo: string[] | null;
  status: string;
  body: string | null;
  sequenceNum: number;
  contextTokens: number | null;
  contextTokensMax: number | null;
  createdAt: string;
  completedAt: string | null;
}> = {}) {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? "msg-1",
    conversationId: overrides.conversationId ?? "conv-1",
    turnId: overrides.turnId ?? "turn-1",
    senderType: overrides.senderType ?? "user",
    senderId: overrides.senderId ?? "user-1",
    talkingStonePassedTo: overrides.talkingStonePassedTo ?? ["otter-1"],
    status: overrides.status ?? "completed",
    body: overrides.body ?? "Hello world",
    sequenceNum: overrides.sequenceNum ?? 1,
    contextTokens: overrides.contextTokens ?? null,
    contextTokensMax: overrides.contextTokensMax ?? null,
    createdAt: overrides.createdAt ?? now,
    completedAt: overrides.completedAt ?? now,
  };
}

export function makeOtter(overrides: Partial<{
  id: string;
  name: string;
  type: string;
  status: string;
  role: { name: string; responsibilities: string[] } | null;
  parentOtterId: string | null;
  createdAt: string;
  dissolvedAt: string | null;
}> = {}) {
  return {
    id: overrides.id ?? "otter-1",
    name: overrides.name ?? "Test Otter",
    type: overrides.type ?? "small",
    status: overrides.status ?? "active",
    role: overrides.role ?? null,
    parentOtterId: overrides.parentOtterId ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    dissolvedAt: overrides.dissolvedAt ?? null,
  };
}

export function makeSession(overrides: Partial<{
  id: string;
  otterId: string;
  status: string;
  previousSessionId: string | null;
  startedAt: string;
  archivedAt: string | null;
  archiveReason: string | null;
  isNegativeCase: boolean;
  summary: string | null;
  handoffSummary: unknown;
}> = {}) {
  return {
    id: overrides.id ?? "session-1",
    otterId: overrides.otterId ?? "otter-1",
    status: overrides.status ?? "active",
    previousSessionId: overrides.previousSessionId ?? null,
    startedAt: overrides.startedAt ?? new Date().toISOString(),
    archivedAt: overrides.archivedAt ?? null,
    archiveReason: overrides.archiveReason ?? null,
    isNegativeCase: overrides.isNegativeCase ?? false,
    summary: overrides.summary ?? null,
    handoffSummary: overrides.handoffSummary ?? null,
  };
}

export function makeMemoryEntry(overrides: Partial<{
  id: string;
  layer: string;
  contentType: string;
  sourceId: string;
  sourceTable: string;
  conversationId: string | null;
  granularity: string;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}> = {}) {
  return {
    id: overrides.id ?? "mem-1",
    layer: overrides.layer ?? "working",
    contentType: overrides.contentType ?? "message",
    sourceId: overrides.sourceId ?? "msg-1",
    sourceTable: overrides.sourceTable ?? "messages",
    conversationId: overrides.conversationId ?? "conv-1",
    granularity: overrides.granularity ?? "fine",
    content: overrides.content ?? "Memory content",
    metadata: overrides.metadata ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

export function makeParticipant(overrides: Partial<{
  id: string;
  conversationId: string;
  otterId: string;
  joinedAtTurnId: string | null;
  joinedAtTurnNumber: number;
  leftAtTurnId: string | null;
  leftAtTurnNumber: number | null;
  status: string;
  createdAt: string;
  leftAt: string | null;
}> = {}) {
  return {
    id: overrides.id ?? "part-1",
    conversationId: overrides.conversationId ?? "conv-1",
    otterId: overrides.otterId ?? "otter-1",
    joinedAtTurnId: overrides.joinedAtTurnId ?? null,
    joinedAtTurnNumber: overrides.joinedAtTurnNumber ?? 0,
    leftAtTurnId: overrides.leftAtTurnId ?? null,
    leftAtTurnNumber: overrides.leftAtTurnNumber ?? null,
    status: overrides.status ?? "active",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    leftAt: overrides.leftAt ?? null,
  };
}

export function makeKeyFact(overrides: Partial<{
  id: string;
  conversationId: string;
  content: string;
  category: string | null;
  userFlagged: boolean;
  createdBy: string;
  otterId: string | null;
  createdAt: string;
}> = {}) {
  return {
    id: overrides.id ?? "kf-1",
    conversationId: overrides.conversationId ?? "conv-1",
    content: overrides.content ?? "Important fact",
    category: overrides.category ?? null,
    userFlagged: overrides.userFlagged ?? false,
    createdBy: overrides.createdBy ?? "otter-1",
    otterId: overrides.otterId ?? "otter-1",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

export function makeLinkedResource(overrides: Partial<{
  id: string;
  conversationId: string;
  resourceType: string;
  url: string | null;
  title: string | null;
  content: string | null;
  category: string | null;
  userFlagged: boolean;
  metadata: Record<string, unknown> | null;
  linkedBy: string;
  otterId: string | null;
  autoLinked: boolean;
  createdAt: string;
  status: string;
  linkedAtTurnNumber: number;
  statusChangedAtTurnNumber: number;
  groupId: string | null;
  supersededBy: string | null;
}> = {}) {
  return {
    id: overrides.id ?? "lr-1",
    conversationId: overrides.conversationId ?? "conv-1",
    resourceType: overrides.resourceType ?? "url",
    url: overrides.url ?? "https://example.com",
    title: overrides.title ?? "Example",
    content: overrides.content ?? null,
    category: overrides.category ?? null,
    userFlagged: overrides.userFlagged ?? false,
    metadata: overrides.metadata ?? null,
    linkedBy: overrides.linkedBy ?? "otter-1",
    otterId: overrides.otterId ?? "otter-1",
    autoLinked: overrides.autoLinked ?? false,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    status: overrides.status ?? "active",
    linkedAtTurnNumber: overrides.linkedAtTurnNumber ?? 0,
    statusChangedAtTurnNumber: overrides.statusChangedAtTurnNumber ?? 0,
    groupId: overrides.groupId ?? null,
    supersededBy: overrides.supersededBy ?? null,
  };
}

export function makeScheduledTask(overrides: Partial<{
  id: string;
  conversationId: string;
  name: string;
  cron: string;
  timezone: string;
  body: string;
  talkingStonePassedTo: string[];
  senderId: string;
  status: 'active' | 'disabled' | 'error';
  consecutiveFailures: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}> = {}) {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? "task-1",
    conversationId: overrides.conversationId ?? "conv-1",
    name: overrides.name ?? "Daily Reminder",
    cron: overrides.cron ?? "0 9 * * *",
    timezone: overrides.timezone ?? "Asia/Shanghai",
    body: overrides.body ?? "Remember to check in",
    talkingStonePassedTo: overrides.talkingStonePassedTo ?? ["otter-1"],
    senderId: overrides.senderId ?? "otter-1",
    status: overrides.status ?? ("active" as const),
    consecutiveFailures: overrides.consecutiveFailures ?? 0,
    lastTriggeredAt: overrides.lastTriggeredAt ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

export function makeScheduledTaskExecution(overrides: Partial<{
  id: string;
  taskId: string;
  triggeredAt: string;
  completedAt: string | null;
  status: 'running' | 'completed' | 'failed';
  errorMessage: string | null;
  messageId: string | null;
  turnId: string | null;
}> = {}) {
  return {
    id: overrides.id ?? "exec-1",
    taskId: overrides.taskId ?? "task-1",
    triggeredAt: overrides.triggeredAt ?? new Date().toISOString(),
    completedAt: overrides.completedAt ?? null,
    status: overrides.status ?? ("running" as const),
    errorMessage: overrides.errorMessage ?? null,
    messageId: overrides.messageId ?? null,
    turnId: overrides.turnId ?? null,
  };
}

// ─── Test app builder ───

export interface TestDeps {
  manageConversation: any;
  manageParticipant: any;
  sendMessageUseCase: any;
  queryMessage: any;
  agentInvoker: any;
  manageReadState: any;
  createOtterUseCase: any;
  dissolveOtterUseCase: any;
  manageSession: any;
  queryOtter: any;
  searchMemory: any;
  manageMemory: any;
  manageKeyInfo: any;
  settingsConfig: SettingsConfig;
  settingsRepo: any;
  manageScheduledTask: any;
  schedulerService: any;
  cronParser: any;
}

export function createTestApp(deps: TestDeps): Hono {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };

  const conversationCtrl = new ConversationController(
    deps.manageConversation,
    deps.manageParticipant,
    { get: vi.fn().mockResolvedValue(null) } as any,
    logger,
  );

  const dispatchChainEngine = new DispatchChainEngine({
    sendMessage: deps.sendMessageUseCase,
    queryMessage: deps.queryMessage,
    queryOtter: deps.queryOtter,
    logger,
    maxChainDepth: 20,
  });

  // 创建 mock broadcaster，支持 subscribe + broadcastEvent 完整链路
  const broadcastEventCalls: Array<{ event: string; data: Record<string, unknown> }> = [];
  const eventSubscribers = new Map<string, Set<(event: { event: string; data: Record<string, unknown> }) => void>>();
  const mockBroadcaster = {
    broadcastEvent: (convId: string, event: { event: string; data: Record<string, unknown> }) => {
      broadcastEventCalls.push(event);
      const subs = eventSubscribers.get(convId);
      if (subs) { for (const cb of subs) cb(event); }
    },
    broadcast: async () => {},
    subscribe: (convId: string, _onMessage: any, onEvent?: (event: { event: string; data: Record<string, unknown> }) => void) => {
      if (onEvent) {
        if (!eventSubscribers.has(convId)) eventSubscribers.set(convId, new Set());
        eventSubscribers.get(convId)!.add(onEvent);
      }
      return () => { eventSubscribers.get(convId)?.delete(onEvent!); };
    },
  };

  const messageCtrl = new MessageController(
    deps.sendMessageUseCase,
    deps.queryMessage,
    deps.manageReadState,
    deps.agentInvoker,
    logger,
    deps.queryOtter,
    dispatchChainEngine,
    mockBroadcaster as any,
  );
  const otterCtrl = new OtterController(
    deps.createOtterUseCase,
    deps.dissolveOtterUseCase,
    deps.manageSession,
    deps.queryOtter,
    logger,
  );
  const memoryCtrl = new MemoryController(
    deps.searchMemory,
    deps.manageMemory,
    { available: true, embed: async () => new Float32Array(1024) },
    logger,
  );
  const keyInfoCtrl = new KeyInfoController(
    deps.manageKeyInfo,
    logger,
  );
  const settingsCtrl = new SettingsController(
    deps.settingsConfig,
    deps.settingsRepo,
    logger,
  );

  const controllers: Controllers = {
    conversation: conversationCtrl,
    otter: otterCtrl,
    message: messageCtrl,
    memory: memoryCtrl,
    keyInfo: keyInfoCtrl,
    settings: settingsCtrl,
    scheduledTask: new ScheduledTaskController(
      deps.manageScheduledTask,
      deps.schedulerService,
      deps.cronParser,
      logger,
    ),
    connection: {} as any, // TODO: 添加 mock
    health: {} as any, // TODO: 添加 mock
    inbound: {
      optionsEvents: (c: any) => c.body(null, 204),
      receiveEvents: async (c: any) => c.json({ ok: true }),
    } as any,
  };

  const app = createRouter(controllers, mockLogger());

  // 暴露 broadcaster 给测试（用于配置 mock invokeConversation 的事件推送）
  (app as any).__broadcastEventCalls = broadcastEventCalls;
  (app as any).__mockBroadcaster = mockBroadcaster;

  return app;
}

/** 创建类型安全的 mock deps，各测试按需覆盖 */
export function createMockDeps(): TestDeps {
  return {
    manageConversation: mockMethods(["create", "getById", "complete", "archive", "getIdsByOtterId", "getAllIds", "listWithMeta"]),
    manageParticipant: mockMethods(["getActiveParticipants", "join", "leave"]),
    sendMessageUseCase: {
      ...mockMethods(["send", "start", "appendEvent", "complete", "fail", "abort"]),
      repo: {
        getUnreadMessages: vi.fn().mockResolvedValue([]),
        getActiveTurn: vi.fn().mockResolvedValue(null),
        updateLastReadTurnNumber: vi.fn().mockResolvedValue(undefined),
        getActiveParticipants: vi.fn().mockResolvedValue([]),
      },
    },
    queryMessage: mockMethods(["getMessageById", "getMessages", "getMessageEvents", "searchMessages", "getTurnHistory", "expandMessage"]),
    agentInvoker: mockMethods(["invokeConversation", "abort"]),
    manageReadState: { markRead: vi.fn().mockResolvedValue({ lastReadSeq: 0, unreadCount: 0 }) },
    createOtterUseCase: mockMethods(["execute"]),
    dissolveOtterUseCase: mockMethods(["execute"]),
    manageSession: mockMethods(["createSession", "getActiveSession", "archiveSession", "getSessionHistory"]),
    queryOtter: mockMethods(["getById", "getBigOtter"]),
    searchMemory: mockMethods(["search", "searchSimilar"]),
    manageMemory: mockMethods(["getById", "getDetails", "flagMemory", "updateLayer"]),
    manageKeyInfo: mockMethods(["getLinkedResources", "linkResource", "flagResource", "deleteLinkedResource", "supersedeResource", "archiveResource", "updateResourceStatus", "getArtifactIndex", "getLinkedResourcesByGroup"]),
    settingsConfig: {
      provider: "openai",
      model: "gpt-4o",
      port: 3000,
      dbPath: "./otter-buddy.db",
      embeddingModelPath: "./embedding.bin",
      embeddingDim: 1024,
    },
    settingsRepo: mockMethods(["get", "update", "getAll"]),
    manageScheduledTask: mockMethods(["create", "getById", "getByConversationId", "update", "delete", "getExecutions"]),
    schedulerService: mockMethods(["trigger", "start", "stop"]),
    cronParser: { getNextTime: vi.fn() },
  };
}
