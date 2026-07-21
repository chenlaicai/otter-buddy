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
import type { ManageConversation } from "../../src/usecases/conversation/manage-conversation";
import type { ManageParticipant } from "../../src/usecases/conversation/manage-participant";
import type { SendMessage } from "../../src/usecases/conversation/send-message";
import type { QueryMessage } from "../../src/usecases/conversation/query-message";
import type { AgentInvoker } from "../../src/interface-adapters/agent-runtime/agent-invoker";
import type { CreateOtter } from "../../src/usecases/otter/create-otter";
import type { DissolveOtter } from "../../src/usecases/otter/dissolve-otter";
import type { ManageSession } from "../../src/usecases/otter/manage-session";
import type { QueryOtter } from "../../src/usecases/otter/query-otter";
import type { SearchMemory } from "../../src/usecases/memory/search-memory";
import type { ManageMemory } from "../../src/usecases/memory/manage-memory";
import type { ManageKeyInfo } from "../../src/usecases/conversation/manage-key-info";
import type { SettingsRepository } from "../../src/usecases/settings/settings-repository";

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
  // Flush remaining buffer
  if (buffer.startsWith("event: ")) {
    currentEvent = buffer.slice(7);
  }
  if (currentEvent && currentData) {
    events.push({ event: currentEvent, data: JSON.parse(currentData) });
  }

  return events;
}

// ─── Type-safe mock helpers ───

type Mocked<T> = { [K in keyof T]: T[K] extends (...args: any[]) => any ? ReturnType<typeof vi.fn> & T[K] : T[K] };

function mockMethods<T>(methods: (keyof T)[]): Mocked<T> {
  const result = {} as any;
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
  attachments: unknown[] | null;
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
    attachments: overrides.attachments ?? null,
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

// ─── Test app builder ───

export interface TestDeps {
  manageConversation: Mocked<ManageConversation>;
  manageParticipant: Mocked<ManageParticipant>;
  sendMessageUseCase: Mocked<SendMessage>;
  queryMessage: Mocked<QueryMessage>;
  agentInvoker: Mocked<AgentInvoker>;
  createOtterUseCase: Mocked<CreateOtter>;
  dissolveOtterUseCase: Mocked<DissolveOtter>;
  manageSession: Mocked<ManageSession>;
  queryOtter: Mocked<QueryOtter>;
  searchMemory: Mocked<SearchMemory>;
  manageMemory: Mocked<ManageMemory>;
  manageKeyInfo: Mocked<ManageKeyInfo>;
  settingsConfig: SettingsConfig;
  settingsRepo: Mocked<SettingsRepository>;
}

export function createTestApp(deps: TestDeps): Hono {
  const conversationCtrl = new ConversationController(
    deps.manageConversation,
    deps.manageParticipant,
  );
  const messageCtrl = new MessageController(
    deps.sendMessageUseCase,
    deps.queryMessage,
    deps.agentInvoker,
  );
  const otterCtrl = new OtterController(
    deps.createOtterUseCase,
    deps.dissolveOtterUseCase,
    deps.manageSession,
    deps.queryOtter,
  );
  const memoryCtrl = new MemoryController(
    deps.searchMemory,
    deps.manageMemory,
  );
  const keyInfoCtrl = new KeyInfoController(
    deps.manageKeyInfo,
  );
  const settingsCtrl = new SettingsController(
    deps.settingsConfig,
    deps.settingsRepo,
  );

  const controllers: Controllers = {
    conversation: conversationCtrl,
    otter: otterCtrl,
    message: messageCtrl,
    memory: memoryCtrl,
    keyInfo: keyInfoCtrl,
    settings: settingsCtrl,
  };

  return createRouter(controllers);
}

/** 创建类型安全的 mock deps，各测试按需覆盖 */
export function createMockDeps(): TestDeps {
  return {
    manageConversation: mockMethods<ManageConversation>(["create", "getById", "complete", "archive", "getIdsByOtterId"]),
    manageParticipant: mockMethods<ManageParticipant>(["getActiveParticipants", "join", "leave"]),
    sendMessageUseCase: mockMethods<SendMessage>(["send", "start", "appendEvent", "complete", "fail", "abort"]),
    queryMessage: mockMethods<QueryMessage>(["getMessageById", "getMessages", "getMessageEvents", "searchMessages", "getTurnHistory", "expandMessage"]),
    agentInvoker: mockMethods<AgentInvoker>(["invokeConversation", "abort", "getToolCallCount"]),
    createOtterUseCase: mockMethods<CreateOtter>(["execute"]),
    dissolveOtterUseCase: mockMethods<DissolveOtter>(["execute"]),
    manageSession: mockMethods<ManageSession>(["createSession", "getActiveSession", "archiveSession", "getSessionHistory"]),
    queryOtter: mockMethods<QueryOtter>(["getById", "getBigOtter"]),
    searchMemory: mockMethods<SearchMemory>(["search", "searchSimilar"]),
    manageMemory: mockMethods<ManageMemory>(["getById", "getDetails", "flagMemory", "updateLayer"]),
    manageKeyInfo: mockMethods<ManageKeyInfo>(["getLinkedResources", "linkResource", "flagResource", "deleteLinkedResource", "supersedeResource", "archiveResource", "updateResourceStatus", "getArtifactIndex", "getLinkedResourcesByGroup"]),
    settingsConfig: {
      provider: "openai",
      model: "gpt-4o",
      port: 3000,
      dbPath: "./otter-buddy.db",
      embeddingModelPath: "./embedding.bin",
      embeddingDim: 1024,
    },
    settingsRepo: mockMethods<SettingsRepository>(["get", "update", "getAll"]),
  };
}
