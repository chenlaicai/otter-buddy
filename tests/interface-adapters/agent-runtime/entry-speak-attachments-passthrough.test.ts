import { describe, it, expect } from "vitest";
import type { SdkInvokePort, AgentStreamEvent } from "@usecases/ports/sdk-invoke-port";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { OtterSession } from "@entities/otter/otter-session";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { Logger } from "@usecases/ports/logger";
import { mockSendEntry } from "../../helpers/mock-send-entry";
import { createTestLogger } from "../../helpers/logger";

/**
 * r1-A3：entry.speak attachments 透传的真实发射行用例（补静态断言的哑管线缺口）。
 *
 * mock SDK agent 的 speak 工具结束时 result.details 带 attachments →
 * invokeConversation 端到端 → 断言广播出的 entry.speak 事件 data 含该 attachments。
 * 反向用例：details 无 attachments → 事件 data 不含该字段（缺席语义不虚构数据）。
 *
 * harness 内联自 agent-invoker.test.ts（mockAgentInvoke/makeInvoker 最小面），
 * 不动他人测试文件。
 */
function mockQueryMessage(): QueryMessage {
  return { getMessageById: async () => null, getMessages: async () => [] } as unknown as QueryMessage;
}

function makeSession(): OtterSession {
  return {
    id: "sess-1", otterId: "otter-1", status: "active",
    previousSessionId: null, startedAt: "2026-08-05T00:00:00Z",
    archivedAt: null, archiveReason: null, isNegativeCase: false,
    summary: null, modelAlias: null,
  };
}

function mockManageSession(): ManageSession {
  return { getActiveSession: async () => null, createSession: async () => makeSession(), restartSession: async () => makeSession() } as unknown as ManageSession;
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

function mockAgentInvoke(options: { events?: AgentStreamEvent[] }): SdkInvokePort {
  return {
    invoke: async (_otterId: string, _message: string, opts?: { onEvent?: (e: AgentStreamEvent) => void }) => {
      for (const evt of options.events ?? []) {
        opts?.onEvent?.(evt);
      }
      return { text: "Response text" };
    },
    abort: () => {},
    getToolCallCount: () => 0,
    getInternalAbortReason: () => undefined,
  } as unknown as SdkInvokePort;
}

function makeInvoker(sdk: SdkInvokePort, sendEntry: ReturnType<typeof mockSendEntry>, broadcaster: MessageBroadcaster): AgentInvoker {
  return new AgentInvoker(
    sdk,
    mockQueryMessage(),
    mockManageSession(),
    mockQueryOtter(),
    createTestLogger(),
    broadcaster,          // 6 messageBroadcaster
    undefined,            // 7 workspaceGateway
    undefined,            // 8 settingsRepo
    undefined,            // 9 metrics
    undefined,            // 10 healingRepo
    undefined,            // 11 conversationRepo
    undefined,            // 12 scheduledTaskRepo
    undefined,            // 13 listArtifacts
    undefined,            // 14 manageContext
    undefined,            // 15 buildHandoffPkg
    undefined,            // 16 healthySessionThresholdMs
    undefined,            // 17 ctxWindowProvider
    sendEntry,            // 18 sendEntry
    { getInvokeEvents: async () => [] } as never, // 19 invokeRepo
  );
}

function captureSpeakEvents(): { broadcaster: MessageBroadcaster; events: Array<Record<string, unknown>> } {
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
  const broadcaster = new MessageBroadcaster(logger);
  const events: Array<Record<string, unknown>> = [];
  broadcaster.registerOutboundChannel("test-a3", {
    onEvent: (_cid, e) => { if (e.event === "entry.speak") events.push(e.data); },
  });
  return { broadcaster, events };
}

describe("entry.speak attachments 透传（#902 r1-A3）", () => {
  it("details 带 attachments → 事件 data 透传该数组", async () => {
    const { broadcaster, events } = captureSpeakEvents();
    const attachments = [{ id: "att-1", kind: "image", originalName: "cat.png", mimeType: "image/png", sizeBytes: 10 }];
    const invoker = makeInvoker(mockAgentInvoke({
      events: [
        { type: "tool_execution_end", name: "speak", result: { content: [{ type: "text", text: "ok" }], details: { entryId: "entry-1", body: "看图", attachments } } } as unknown as AgentStreamEvent,
      ],
    }), mockSendEntry(), broadcaster);

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi",
      senderId: "user-1",
    }).catch(() => null);
    await new Promise(r => setTimeout(r, 50));

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].attachments).toEqual(attachments);
  });

  it("details 无 attachments（现状）→ 事件 data 不含该字段", async () => {
    const { broadcaster, events } = captureSpeakEvents();
    const invoker = makeInvoker(mockAgentInvoke({
      events: [
        { type: "tool_execution_end", name: "speak", result: { content: [{ type: "text", text: "ok" }], details: { entryId: "entry-2", body: "纯文本" } } } as unknown as AgentStreamEvent,
      ],
    }), mockSendEntry(), broadcaster);

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi",
      senderId: "user-1",
    }).catch(() => null);
    await new Promise(r => setTimeout(r, 50));

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].attachments).toBeUndefined();
  });
});
