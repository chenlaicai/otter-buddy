import { describe, it, expect, vi } from "vitest";
import { FeishuMessageProcessor } from "@interface-adapters/feishu/message-processor";

/**
 * F20260920imax 增量五：bot 锚定路由——一个 im 侧 bot = 一个海獭助理对话。
 * 两个不同的人私聊同一 bot → 汇入同一对话；消息带 [姓名] 前缀；
 * connection 的 metadata.lastChatId 随入站刷新（出站定向锚）。
 */
function makeDeps() {
  const entered: Array<{ conversationId: string }> = [];
  const noted: Array<{ connectionId: string; chatId: string }> = [];
  const manageConnection = {
    ensureConnection: vi.fn(async (externalId: string) => {
      expect(externalId).toBe("feishu-bot:cli_a****k8"); // 锚 = bot，不是 chatId
      return { id: "conn-bot", externalId };
    }),
    getCurrentConversation: vi.fn(async () => null),
    noteChatId: vi.fn(async (connectionId: string, chatId: string) => {
      noted.push({ connectionId, chatId });
    }),
  };
  const assistantSession = {
    ensureAssistantConversation: vi.fn(async ({ connectionId }: { connectionId: string }) => {
      entered.push({ conversationId: connectionId });
      return { id: "conv-bot-line", title: "飞书助理" };
    }),
  };
  const sentEntries: Array<{ conversationId: string; body: string }> = [];
  return {
    deps: {
      manageConnection: manageConnection as never,
      assistantSession: assistantSession as never,
      sendEntry: { sendUserEntry: vi.fn(async (i: { conversationId: string; body: string }) => { sentEntries.push(i); return { entry: { id: "e1", sequenceNum: 1, createdAt: new Date().toISOString(), senderName: "" }, talkingStonePassedTo: ["otter-1"] }; }) } as never,
      entryRepo: { getEntries: vi.fn().mockResolvedValue([]) } as never,
      commandDispatcher: { dispatch: vi.fn() } as never,
      feishuGateway: {
        botKey: "feishu-bot:cli_a****k8",
        replyText: vi.fn(),
        replyMarkdown: vi.fn(),
      } as never,
      partnerResolver: undefined,
      agentDispatchService: { dispatch: vi.fn().mockResolvedValue({}) } as never,
      messageBroadcaster: { broadcastEvent: vi.fn() } as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      feishuUserInfo: { getUserName: vi.fn().mockResolvedValue("朵朵") } as never,
    } as never,
    manageConnection, assistantSession, sentEntries, noted, entered,
  };
}

function p2pMsg(chatId: string, senderId: string, text: string) {
  return {
    chatId, senderId, text, messageId: `m-${chatId}-${Math.random()}`,
    chatType: "p2p" as const,
  };
}

describe("F20260920imax 增量五：飞书 bot 锚定路由（一 bot 一对话）", () => {
  it("两个不同的人私聊同一 bot → 同一对话（首条开户，第二条复用）", async () => {
    const ctx = makeDeps();
    const processor = new FeishuMessageProcessor(ctx.deps);
    await processor.process(p2pMsg("chat-朵朵", "ou_duo", "你好") as never);
    await processor.process(p2pMsg("chat-妈妈", "ou_ma", "晚饭吃啥") as never);

    // 两人的消息都进同一对话
    expect(ctx.sentEntries.map(e => e.conversationId)).toEqual(["conv-bot-line", "conv-bot-line"]);
    // 消息带发送者姓名前缀（展示维度）
    expect(ctx.sentEntries[1].body).toContain("[朵朵]");
  });

  it("connection 锚 = bot 键；metadata.lastChatId 随入站刷新（出站定向锚）", async () => {
    const ctx = makeDeps();
    const processor = new FeishuMessageProcessor(ctx.deps);
    await processor.process(p2pMsg("chat-a", "ou_a", "hi") as never);
    await processor.process(p2pMsg("chat-b", "ou_b", "yo") as never);

    // 行为断言：开户检查每次都返回同一条线（bot 锚定→复用，非每消息新开）
    const ensured: string[] = [];
    for (const r of ctx.assistantSession.ensureAssistantConversation.mock.results) {
      const v = await r.value; // async mock 返回 Promise
      ensured.push(v.id);
    }
    expect(new Set(ensured).size).toBe(1);
    expect(ensured[0]).toBe("conv-bot-line");
    expect(ctx.noted.map(n => n.chatId)).toEqual(["chat-a", "chat-b"]); // 出站锚随最后消息刷新
  });
});
