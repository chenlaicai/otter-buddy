import { describe, it, expect, vi } from "vitest";
import { FeishuMessageProcessor } from "@interface-adapters/feishu/message-processor";
import type { ManageConnection } from "@usecases/im/manage-connection";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { CommandDispatcher } from "@interface-adapters/feishu/command-dispatcher";
import type { FeishuGateway } from "@usecases/im/feishu-gateway";
import type { FeishuUserInfoGateway } from "@usecases/im/feishu-user-info-gateway";
import type { AgentDispatchService } from "@usecases/conversation/agent-dispatch-service";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { Logger } from "@usecases/ports/logger";

function makeMocks() {
  const send = vi.fn().mockResolvedValue({
    message: { id: "m-1", senderName: "" },
    mentionFeedback: null,
  });
  const getUserName = vi.fn();
  const broadcast = vi.fn().mockResolvedValue(undefined);

  const deps = {
    manageConnection: {
      ensureConnection: vi.fn().mockResolvedValue({ id: "conn-1" }),
      getCurrentConversation: vi.fn().mockResolvedValue({ id: "conv-1", title: "测试" }),
    } as unknown as ManageConnection,
    sendMessage: { send } as unknown as SendMessage,
    commandDispatcher: {} as unknown as CommandDispatcher,
    feishuGateway: { replyText: vi.fn() } as unknown as FeishuGateway,
    feishuUserInfo: { getUserName } as unknown as FeishuUserInfoGateway,
    agentDispatchService: { dispatch: vi.fn().mockResolvedValue({}) } as unknown as AgentDispatchService,
    messageBroadcaster: { broadcast } as unknown as MessageBroadcaster,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
  };
  return { deps, send, getUserName, broadcast };
}

describe("FeishuMessageProcessor senderName 快照（F20260826fuid）", () => {
  it("网关解析到姓名时，send 收到 senderDisplayName 快照", async () => {
    const m = makeMocks();
    m.getUserName.mockResolvedValue("张三");
    const processor = new FeishuMessageProcessor(m.deps);

    await processor.process({ chatId: "oc_1", text: "你好", senderId: "ou_zhangsan", messageId: "om_1" });

    expect(m.send.mock.calls.length).toBe(1);
    const input = m.send.mock.calls[0][0] as { senderDisplayName?: string | null };
    expect(input.senderDisplayName).toBe("张三");
  });

  it("网关返回 null 时 senderDisplayName 为 null，消息照常入库", async () => {
    const m = makeMocks();
    m.getUserName.mockResolvedValue(null);
    const processor = new FeishuMessageProcessor(m.deps);

    await processor.process({ chatId: "oc_1", text: "你好", senderId: "ou_x", messageId: "om_1" });

    const input = m.send.mock.calls[0][0] as { senderDisplayName?: string | null };
    expect(input.senderDisplayName).toBeNull();
    expect(m.send.mock.calls.length).toBe(1);
  });

  it("网关抛异常时不阻塞消息处理（senderDisplayName null 降级）", async () => {
    const m = makeMocks();
    m.getUserName.mockRejectedValue(new Error("network down"));
    const processor = new FeishuMessageProcessor(m.deps);

    await expect(processor.process({ chatId: "oc_1", text: "你好", senderId: "ou_x", messageId: "om_1" })).resolves.toBeUndefined();

    const input = m.send.mock.calls[0][0] as { senderDisplayName?: string | null };
    expect(input.senderDisplayName).toBeNull();
  });

  it("未注入网关时走原路径（不解析姓名）", async () => {
    const m = makeMocks();
    const { feishuUserInfo, ...rest } = m.deps;
    void feishuUserInfo;
    const processor = new FeishuMessageProcessor(rest);

    await processor.process({ chatId: "oc_1", text: "你好", senderId: "ou_x", messageId: "om_1" });

    expect(m.getUserName.mock.calls.length).toBe(0);
    const input = m.send.mock.calls[0][0] as { senderDisplayName?: string | null };
    expect(input.senderDisplayName).toBeNull();
  });

  it("命令消息（/开头）不触发姓名解析", async () => {
    const m = makeMocks();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const deps = {
      ...m.deps,
      commandDispatcher: { dispatch } as unknown as CommandDispatcher,
    };
    const processor = new FeishuMessageProcessor(deps);

    await processor.process({ chatId: "oc_1", text: "/list", senderId: "ou_x", messageId: "om_1" });

    expect(m.getUserName.mock.calls.length).toBe(0);
    expect(m.send.mock.calls.length).toBe(0);
    expect(dispatch.mock.calls.length).toBe(1);
  });
});
