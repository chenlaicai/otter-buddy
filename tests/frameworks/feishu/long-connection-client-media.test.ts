import { describe, it, expect, vi } from "vitest";
import { FeishuLongConnectionClient } from "@frameworks/feishu/long-connection-client";
import type { FeishuAccessTokenManager } from "@frameworks/feishu/access-token-manager";
import type { FeishuConfig } from "@frameworks/feishu/types";

/** 多模态 Phase 2：长连接客户端消息解析扩展测试。
 *  锁定：image/file 消息放行 + media 载荷解析；其余类型仍忽略；
 *  text 消息（含 content.text 缺失的宽容性）不回归。 */

vi.mock("@larksuiteoapi/node-sdk", () => {
  return {
    WSClient: class {
      getConnectionStatus() { return { state: "test", lastConnectTime: "", reconnectAttempts: 0 }; }
      async start() { /* noop */ }
      close() { /* noop */ }
    },
    EventDispatcher: class {
      private handlers: Record<string, (data: unknown) => void> = {};
      register(map: Record<string, (data: unknown) => void>) { Object.assign(this.handlers, map); }
      // 测试钩子：直接触发已注册的 handler
      dispatch(event: string, data: unknown) { this.handlers[event]?.(data); }
    },
  };
});

async function makeClient() {
  const config = { appId: "a", appSecret: "s" } as FeishuConfig;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const tokenManager = {} as FeishuAccessTokenManager;
  const client = new FeishuLongConnectionClient(config, logger as never, tokenManager);
  await client.start(); // handler 注册在 start() 内（WSClient/EventDispatcher 均 mock，无副作用）
  // 拿到 EventDispatcher 实例（构造后的内部状态）——从私有字段读
  const dispatcher = (client as unknown as { eventDispatcher: { dispatch: (e: string, d: unknown) => void } }).eventDispatcher;
  return { client, dispatcher, logger };
}

function eventData(messageType: string, content: unknown) {
  return {
    event_id: "e-1",
    event_type: "im.message.receive_v1",
    sender: { sender_type: "user", sender_id: { open_id: "ou_x" } },
    message: {
      message_id: "om_1",
      chat_id: "oc_1",
      create_time: "123",
      chat_type: "p2p",
      message_type: messageType,
      content: JSON.stringify(content),
    },
  };
}

describe("FeishuLongConnectionClient 消息类型扩展（多模态 Phase 2）", () => {
  it("image 消息：放行 + media 载荷透传（imageKey）", async () => {
    const { client, dispatcher } = await makeClient();
    const received: unknown[] = [];
    client.onMessage((msg) => { received.push(msg); });

    dispatcher.dispatch("im.message.receive_v1", eventData("image", { image_key: "img_v2_abc123" }));
    await new Promise(r => setTimeout(r, 0)); // handler 经 Promise.resolve 异步包装

    expect(received).toHaveLength(1);
    const msg = received[0] as { media?: { type: string; imageKey?: string }; text: string };
    expect(msg.media?.type).toBe("image");
    expect(msg.media?.imageKey).toBe("img_v2_abc123");
    expect(msg.text).toBe("");
  });

  it("file 消息：放行 + media 载荷透传（fileKey + fileName）", async () => {
    const { client, dispatcher } = await makeClient();
    const received: unknown[] = [];
    client.onMessage((msg) => { received.push(msg); });

    dispatcher.dispatch("im.message.receive_v1", eventData("file", { file_key: "file_v2_xyz", file_name: "报告.md" }));
    await new Promise(r => setTimeout(r, 0));

    const msg = received[0] as { media?: { type: string; fileKey?: string; fileName?: string } };
    expect(msg.media?.type).toBe("file");
    expect(msg.media?.fileKey).toBe("file_v2_xyz");
    expect(msg.media?.fileName).toBe("报告.md");
  });

  it("不支持的类型（audio/sticker 等）：仍忽略", async () => {
    const { client, dispatcher } = await makeClient();
    const received: unknown[] = [];
    client.onMessage((msg) => { received.push(msg); });

    dispatcher.dispatch("im.message.receive_v1", eventData("audio", { audio_key: "a" }));
    dispatcher.dispatch("im.message.receive_v1", eventData("sticker", { sticker_key: "s" }));
    await new Promise(r => setTimeout(r, 0));

    expect(received).toHaveLength(0);
  });

  it("text 消息：原路径不回归（text 提取 + 无 media）", async () => {
    const { client, dispatcher } = await makeClient();
    const received: unknown[] = [];
    client.onMessage((msg) => { received.push(msg); });

    dispatcher.dispatch("im.message.receive_v1", eventData("text", { text: "你好" }));
    await new Promise(r => setTimeout(r, 0));

    const msg = received[0] as { text: string; media?: unknown };
    expect(msg.text).toBe("你好");
    expect(msg.media).toBeUndefined();
  });

  it("image content 非法（缺 image_key）：media 缺失但消息仍透传（降级在 processor）", async () => {
    const { client, dispatcher } = await makeClient();
    const received: unknown[] = [];
    client.onMessage((msg) => { received.push(msg); });

    dispatcher.dispatch("im.message.receive_v1", eventData("image", { wrong_field: "x" }));
    await new Promise(r => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    const msg = received[0] as { media?: unknown };
    expect(msg.media).toBeUndefined();
  });

  it("bot 消息（sender_type=app）：仍忽略（防自环）", async () => {
    const { client, dispatcher } = await makeClient();
    const received: unknown[] = [];
    client.onMessage((msg) => { received.push(msg); });

    const botEvent = {
      ...eventData("image", { image_key: "img_v2_abc" }),
      sender: { sender_type: "app" },
    };
    dispatcher.dispatch("im.message.receive_v1", botEvent);
    await new Promise(r => setTimeout(r, 0));

    expect(received).toHaveLength(0);
  });
});
