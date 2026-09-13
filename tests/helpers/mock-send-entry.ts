/**
 * F20260913ctlv 彻底切换：SendEntry mock 助手。
 *
 * 旧 agent-invoker 测试族（circuit-break/guard-bounce/metrics/rate-limit/self-restart）
 * 的状态机 mock 面从 SendMessage（messages 行）切到 SendEntry（invokes + entries）。
 * 本助手提供内存版 invoke/entry 状态机，覆盖 orchestrator 全部回调面。
 */

import type { SendEntry } from "@usecases/conversation/send-entry";
import type { Entry } from "@entities/conversation/entry";
import type { Invoke } from "@entities/conversation/invoke";

export interface MockInvokeStore {
  invokes: Map<string, Invoke>;
  entries: Entry[];
  systemBodies: string[];
  invokeEndCalls: Array<{ invokeId: string; status: string; body?: string }>;
  statusUpdates: Array<{ invokeId: string; status: string }>;
  tspUpdates: Array<{ invokeId: string; targets: string[] }>;
  tokenUsageUpdates: Array<{ invokeId: string; input: number; output: number }>;
}

/** 创建 SendEntry mock：内存 invoke/entry 状态机 */
export function mockSendEntry(options?: {
  /** invoke 初始状态（默认 running） */
  initialStatus?: "running" | "completed" | "failed" | "aborted";
  /** getInvokeById 返回前动态改状态的钩子（模拟 yield 工具置 completed 等） */
  onGetInvoke?: (invoke: Invoke, store: MockInvokeStore) => void;
}): SendEntry & { store: MockInvokeStore } {
  const store: MockInvokeStore = {
    invokes: new Map(),
    entries: [],
    systemBodies: [],
    invokeEndCalls: [],
    statusUpdates: [],
    tspUpdates: [],
    tokenUsageUpdates: [],
  };
  let seq = 0;
  const nextSeq = () => ++seq;
  const now = () => new Date().toISOString();

  const makeInvoke = (conversationId: string, otterId: string): Invoke => ({
    id: `invoke-${store.invokes.size + 1}`,
    conversationId,
    otterId,
    status: options?.initialStatus ?? "running",
    triggerEntryId: null,
    talkingStonePassedTo: null,
    startedAt: now(),
    endedAt: null,
    toolCallCount: 0,
    tokenUsageInput: null,
    tokenUsageOutput: null,
    metadata: null,
  });

  const makeEntry = (conversationId: string, partial: Partial<Entry>): Entry => ({
    id: `entry-${nextSeq()}`,
    conversationId,
    sequenceNum: nextSeq(),
    entryType: "speak",
    senderType: null,
    senderId: null,
    body: null,
    invokeId: null,
    yieldTargets: null,
    turnId: "turn-1",
    status: "completed",
    source: null,
    metadata: null,
    senderName: "",
    contextTokens: null,
    contextTokensMax: null,
    createdAt: now(),
    completedAt: now(),
    ...partial,
  });

  const impl = {
    createInvoke: async (input: { conversationId: string; otterId: string }) => {
      const invoke = makeInvoke(input.conversationId, input.otterId);
      store.invokes.set(invoke.id, invoke);
      const invokeStartEntry = makeEntry(input.conversationId, { entryType: "invoke_start", invokeId: invoke.id, body: "start" });
      store.entries.push(invokeStartEntry);
      return { invoke, invokeStartEntry };
    },
    sendUserEntry: async (input: { conversationId: string; senderId: string; body: string }) => {
      const entry = makeEntry(input.conversationId, { entryType: "user", senderType: "user", senderId: input.senderId, body: input.body });
      store.entries.push(entry);
      return { entry, talkingStonePassedTo: ["otter-1"] };
    },
    createSpeakEntry: async (input: { conversationId: string; invokeId: string; otterId: string; body: string }) => {
      const entry = makeEntry(input.conversationId, { entryType: "speak", senderType: "otter", senderId: input.otterId, body: input.body, invokeId: input.invokeId });
      store.entries.push(entry);
      return { entry };
    },
    createYieldEntry: async (input: { conversationId: string; invokeId: string; otterId: string; yieldTargets: string[] }) => {
      const invoke = store.invokes.get(input.invokeId);
      if (invoke) {
        invoke.talkingStonePassedTo = input.yieldTargets;
        invoke.status = "completed";
        invoke.endedAt = now();
        store.tspUpdates.push({ invokeId: input.invokeId, targets: input.yieldTargets });
        store.statusUpdates.push({ invokeId: input.invokeId, status: "completed" });
      }
      const yieldEntry = makeEntry(input.conversationId, { entryType: "yield", invokeId: input.invokeId, yieldTargets: input.yieldTargets, body: "yield" });
      const invokeEndEntry = makeEntry(input.conversationId, { entryType: "invoke_end", invokeId: input.invokeId, body: "end" });
      store.entries.push(yieldEntry, invokeEndEntry);
      return { yieldEntry, invokeEndEntry, invoke: invoke! };
    },
    createInvokeEndEntry: async (input: { conversationId: string; invokeId: string; otterId: string; status: "failed" | "aborted" | "completed"; body?: string }) => {
      const invoke = store.invokes.get(input.invokeId);
      if (invoke) {
        invoke.status = input.status;
        invoke.endedAt = now();
      }
      const invokeEndEntry = makeEntry(input.conversationId, { entryType: "invoke_end", invokeId: input.invokeId, body: input.body ?? null });
      store.entries.push(invokeEndEntry);
      store.invokeEndCalls.push({ invokeId: input.invokeId, status: input.status, body: input.body });
      return { invokeEndEntry, invoke: invoke! };
    },
    createSystemEntry: async (input: { conversationId: string; body: string }) => {
      store.systemBodies.push(input.body);
      const entry = makeEntry(input.conversationId, { entryType: "system", senderType: "system", senderId: "system", body: input.body });
      store.entries.push(entry);
      return { entry };
    },
    appendInvokeEvent: async () => ({}),
    incrementInvokeToolCallCount: async (invokeId: string) => {
      const inv = store.invokes.get(invokeId);
      if (inv) inv.toolCallCount++;
    },
    updateInvokeTokenUsage: async (invokeId: string, input: number, output: number) => {
      store.tokenUsageUpdates.push({ invokeId, input, output });
    },
    getEntries: async () => store.entries,
    getInvokeById: async (invokeId: string) => {
      const invoke = store.invokes.get(invokeId) ?? null;
      if (invoke && options?.onGetInvoke) options.onGetInvoke(invoke, store);
      return invoke;
    },
    updateInvokeStatus: async (invokeId: string, status: "completed" | "failed" | "aborted") => {
      const invoke = store.invokes.get(invokeId);
      if (invoke) {
        invoke.status = status;
        invoke.endedAt = now();
      }
      store.statusUpdates.push({ invokeId, status });
    },
    updateInvokeTalkingStonePassedTo: async (invokeId: string, targets: string[]) => {
      const invoke = store.invokes.get(invokeId);
      if (invoke) invoke.talkingStonePassedTo = targets;
      store.tspUpdates.push({ invokeId, targets });
    },
    attachEntryAttachments: async () => {},
  };

  return Object.assign(impl as unknown as SendEntry, { store });
}
