import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { MessageController } from "@interface-adapters/http/controllers/message-controller";
import { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";

function createApp(controller: MessageController): Hono {
  const app = new Hono();
  app.post("/api/conversations/:id/messages", (c) => controller.sendMessage(c));
  return app;
}

function makeLogger() {
  const warns: Array<{ msg: string; data: unknown }> = [];
  return {
    warns,
    logger: {
      info: vi.fn(),
      warn: (msg: string, data: unknown) => { warns.push({ msg, data }); },
      error: vi.fn(), debug: vi.fn(), child: vi.fn(),
    },
  };
}

function makeSendMessageUseCase() {
  const systemBodies: string[] = [];
  const useCase = {
    send: async () => ({ id: "user-msg-1", talkingStonePassedTo: ["otter-x"] }),
    sendSystem: async (_convId: string, body: string) => {
      systemBodies.push(body);
      return { id: "sys-msg-1", body };
    },
    repo: {
      getUnreadMessages: async () => [],
      getActiveTurn: async () => null,
      updateLastReadTurnNumber: async () => {},
      getActiveParticipants: async () => [],
    },
  };
  return { useCase, systemBodies };
}

const queryOtterStub = { getById: async () => null } as unknown as QueryOtter;
const queryMessageStub = { getMessageById: async () => null } as unknown as QueryMessage;

function postMessage(app: Hono) {
  return app.request("/api/conversations/conv-1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ senderId: "user-1", talkingStonePassedTo: ["otter-x"], body: "hi" }),
  });
}

describe("dispatchTurnLoop 深度上限", () => {
  it("触顶时停止派发、warn 日志、sendSystem 并推 system.message", async () => {
    const { useCase, systemBodies } = makeSendMessageUseCase();
    const { logger, warns } = makeLogger();
    /** 发言石永远互传 → 死循环，必须由 maxChainDepth 截断 */
    let dispatchCount = 0;
    const agentInvoker = {
      invokeConversation: async ({ otterId }: { otterId: string }) => {
        dispatchCount++;
        return { messageId: `m-${otterId}`, aggregatedTargets: ["otter-x"] };
      },
    } as unknown as AgentInvoker;

    const dispatchChainEngine = new DispatchChainEngine({
      sendMessage: useCase as unknown as SendMessage,
      queryMessage: queryMessageStub,
      queryOtter: queryOtterStub,
      logger: logger as never,
      maxChainDepth: 2,
    });

    const ctrl = new MessageController(
      useCase as unknown as SendMessage,
      queryMessageStub,
      agentInvoker,
      logger as never,
      queryOtterStub,
      dispatchChainEngine,
    );
    const res = await postMessage(createApp(ctrl));
    const sseText = await res.text();

    /** depth=2：只派发 2 跳，第 3 跳被截断 */
    expect(dispatchCount).toBe(2);
    // DispatchChainEngine 和 MessageController 都会记录 warn 日志
    expect(warns.length).toBeGreaterThanOrEqual(1);
    const depthWarn = warns.find(w => w.msg === "发言链达到深度上限，交还用户");
    expect(depthWarn).toBeDefined();
    expect(depthWarn!.data).toMatchObject({ depth: 2, pendingTargets: ["otter-x"] });
    expect(systemBodies).toHaveLength(1);
    expect(systemBodies[0]).toContain("2 跳");
    expect(sseText).toContain("system.message");
    expect(sseText).toContain("stream.end");
  });

  it("发言石无目标时正常结束，不发系统消息", async () => {
    const { useCase, systemBodies } = makeSendMessageUseCase();
    const { logger, warns } = makeLogger();
    let dispatchCount = 0;
    const agentInvoker = {
      invokeConversation: async ({ otterId }: { otterId: string }) => {
        dispatchCount++;
        return { messageId: `m-${otterId}`, aggregatedTargets: [] };
      },
    } as unknown as AgentInvoker;

    const dispatchChainEngine = new DispatchChainEngine({
      sendMessage: useCase as unknown as SendMessage,
      queryMessage: queryMessageStub,
      queryOtter: queryOtterStub,
      logger: logger as never,
      maxChainDepth: 2,
    });

    const ctrl = new MessageController(
      useCase as unknown as SendMessage,
      queryMessageStub,
      agentInvoker,
      logger as never,
      queryOtterStub,
      dispatchChainEngine,
    );
    const res = await postMessage(createApp(ctrl));
    await res.text();

    expect(dispatchCount).toBe(1);
    expect(systemBodies).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });

  it("派发上下文包含在场成员名册与具名历史", async () => {
    const { useCase } = makeSendMessageUseCase();
    useCase.repo.getActiveParticipants = async () => [
      { otterId: "otter-x" },
    ] as never;
    useCase.repo.getUnreadMessages = async () => [
      { senderType: "otter", senderId: "otter-x", body: "万象更新" },
    ] as never;
    const { logger } = makeLogger();
    const queryOtter = { getById: async () => ({ name: "小獭" }) } as unknown as QueryOtter;

    const contexts: string[] = [];
    const agentInvoker = {
      invokeConversation: async ({ userMessageContent }: { userMessageContent: string }) => {
        contexts.push(userMessageContent);
        return { messageId: "m-1", aggregatedTargets: [] };
      },
    } as unknown as AgentInvoker;

    const dispatchChainEngine = new DispatchChainEngine({
      sendMessage: useCase as unknown as SendMessage,
      queryMessage: queryMessageStub,
      queryOtter,
      logger: logger as never,
      maxChainDepth: 2,
    });

    const ctrl = new MessageController(
      useCase as unknown as SendMessage,
      queryMessageStub,
      agentInvoker,
      logger as never,
      queryOtter,
      dispatchChainEngine,
    );
    const res = await postMessage(createApp(ctrl));
    await res.text();

    expect(contexts).toHaveLength(1);
    /** 名册：name ↔ otterId 映射在场 */
    expect(contexts[0]).toContain("## 在场成员");
    expect(contexts[0]).toContain("小獭 (otterId: otter-x)");
    expect(contexts[0]).toContain("'user'");
    /** 历史消息用名字标注，不用 UUID */
    expect(contexts[0]).toContain("[小獭] 万象更新");
    expect(contexts[0]).not.toContain("[otter-x]");
  });
});
