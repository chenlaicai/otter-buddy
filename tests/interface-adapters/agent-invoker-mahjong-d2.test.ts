/**
 * F20261015mjsg D2 牌局中对话侧防护测试：
 *  - 入座獭 + 无安全词 → 拦截：不进 SDK、speak entry 自动应答 + entry.speak 广播
 *  - 入座獭 + 消息命中「停下」→ 放行走 LLM（L2 急停不被牌局吞掉）
 *  - 未挂接谓词 / 谓词 false → 正常路径（SDK 被调用）
 */
import { describe, it, expect } from "vitest";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { SdkInvokePort } from "@usecases/ports/sdk-invoke-port";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { OtterSession } from "@entities/otter/otter-session";
import { createTestLogger } from "../helpers/logger";
import { mockSendEntry } from "../helpers/mock-send-entry";
import { MessageBroadcaster } from "../../src/usecases/im/message-broadcaster";
import type { SSEEvent } from "@contract/sse/events";

function mockQueryMessage(): QueryMessage {
  return { getMessageById: async () => null, getMessages: async () => [] } as unknown as QueryMessage;
}

function makeSession(overrides: Partial<OtterSession> = {}): OtterSession {
  return {
    id: "sess-1", otterId: "otter-1", status: "active",
    previousSessionId: null, startedAt: "2026-08-05T00:00:00Z",
    archivedAt: null, archiveReason: null, isNegativeCase: false,
    summary: null, modelAlias: null,
    ...overrides,
  };
}

function mockManageSession(): ManageSession {
  return {
    getActiveSession: async () => null,
    createSession: async (otterId: string) => makeSession({ id: "sess-backfill", otterId }),
    restartSession: async (otterId: string) => makeSession({ id: "sess-new", otterId }),
  } as unknown as ManageSession;
}

function mockQueryOtter(): QueryOtter {
  return {
    getById: async (id: string) => ({
      id, name: "Test Otter", type: "small", status: "active",
      role: null, parentOtterId: null,
      createdAt: "2026-07-16T00:00:00Z", dissolvedAt: null,
    }),
  } as unknown as QueryOtter;
}

function countingSdk(): { sdk: SdkInvokePort; calls: () => number } {
  let n = 0;
  const sdk = {
    invoke: async () => {
      n += 1;
      return { text: "LLM 正常应答" };
    },
    abort: () => {},
    getToolCallCount: () => 0,
    getInternalAbortReason: () => undefined,
  } as unknown as SdkInvokePort;
  return { sdk, calls: () => n };
}

function makeInvoker(
  sdk: SdkInvokePort,
  sendEntry: ReturnType<typeof mockSendEntry>,
  broadcaster?: MessageBroadcaster,
): AgentInvoker {
  return new AgentInvoker(
    sdk,
    mockQueryMessage(),
    mockManageSession(),
    mockQueryOtter(),
    createTestLogger(),
    broadcaster,
    undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
    sendEntry,
    { getInvokeEvents: async () => [] } as never,
  );
}

describe("D2 牌局中对话侧防护（入座獭自动应答「打牌中」）", () => {
  it("入座 + 无安全词 → 拦截：SDK 零调用、speak entry 落库、entry.speak 广播、返回 d2- 合成 id", async () => {
    const { sdk, calls } = countingSdk();
    const sendEntry = mockSendEntry();
    const broadcaster = new MessageBroadcaster(createTestLogger());
    const broadcasts: SSEEvent[] = [];
    broadcaster.subscribeEvents("conv-1", (e) => broadcasts.push(e));
    const invoker = makeInvoker(sdk, sendEntry, broadcaster);
    invoker.attachMahjongSeatQuery({ isSeated: (otterId) => otterId === "otter-1" });

    const result = await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "在吗，帮我查下记忆",
      senderId: "user-1",
    });

    expect(calls()).toBe(0); // 不进 LLM
    expect(result.invokeId.startsWith("d2-")).toBe(true);
    const speaks = sendEntry.store.entries.filter((e) => e.entryType === "speak");
    expect(speaks).toHaveLength(1);
    expect(speaks[0]!.body).toContain("打牌中");
    // 无 invoke 行：invokeId 缺省（真实层 ?? null 落库守 FK；mock 存原始入参故 undefined 同义）
    expect(speaks[0]!.invokeId ?? null).toBeNull();
    expect(speaks[0]!.metadata).toMatchObject({ source: "mahjong-d2" });
    const entrySpeak = broadcasts.find((b) => b.event === "entry.speak");
    expect(entrySpeak).toBeTruthy();
    expect(entrySpeak?.data.entryId).toBe(speaks[0]!.id);
  });

  it("入座 + 消息命中安全词「停下」→ 放行走 LLM（急停不被牌局吞掉）", async () => {
    const { sdk, calls } = countingSdk();
    const sendEntry = mockSendEntry();
    const invoker = makeInvoker(sdk, sendEntry);
    invoker.attachMahjongSeatQuery({ isSeated: () => true });

    await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "快停下，全场急停！",
      senderId: "user-1",
    }).catch(() => null);

    expect(calls()).toBeGreaterThanOrEqual(1); // 放行 → 正常进 LLM（mock 无 yield 会触发 no-yield 重试，次数不锁）
    expect(sendEntry.store.entries.filter((e) => e.entryType === "speak")).toHaveLength(0);
  });

  it("谓词 false → 正常路径（SDK 被调用，无拦截应答）", async () => {
    const { sdk, calls } = countingSdk();
    const sendEntry = mockSendEntry();
    const invoker = makeInvoker(sdk, sendEntry);
    invoker.attachMahjongSeatQuery({ isSeated: () => false });

    await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "在吗",
      senderId: "user-1",
    }).catch(() => null);

    expect(calls()).toBeGreaterThanOrEqual(1);
    expect(sendEntry.store.entries.filter((e) => e.entryType === "speak")).toHaveLength(0);
  });

  it("未挂接谓词（非三麻部署）→ 不拦截", async () => {
    const { sdk, calls } = countingSdk();
    const sendEntry = mockSendEntry();
    const invoker = makeInvoker(sdk, sendEntry);

    await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "在吗",
      senderId: "user-1",
    }).catch(() => null);

    expect(calls()).toBeGreaterThanOrEqual(1);
  });
});
