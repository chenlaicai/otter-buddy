import { describe, it, expect, vi } from "vitest";
import { FeishuLongConnectionClient } from "@frameworks/feishu/long-connection-client";
import type { FeishuAccessTokenManager } from "@frameworks/feishu/access-token-manager";
import type { FeishuConfig } from "@frameworks/feishu/types";
import type { FeishuLongConnectionMessage } from "@usecases/im/feishu-long-connection-gateway";

/** F20260829fpst：飞书 post 富文本混排消息解析测试。
 *  锁定：post 放行；text 段拼正文（段落间空行）；img/media 段按序提 key 进 postItems；
 *  纯文本 post 不带 media 载荷（走原文本路径）；非法 content 不炸（空 text 无 media）；
 *  a/at 超链接段跳过；text/image/file 既有行为不回归。 */

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
      dispatch(event: string, data: unknown) { this.handlers[event]?.(data); }
    },
  };
});

async function makeClient() {
  const config = { appId: "a", appSecret: "s" } as FeishuConfig;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const tokenManager = {} as FeishuAccessTokenManager;
  const client = new FeishuLongConnectionClient(config, logger as never, tokenManager);
  await client.start();
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

describe("FeishuLongConnectionClient post 富文本混排（F20260829fpst）", () => {
  it("图文混排：text 段拼正文 + img 段按序进 postItems", async () => {
    const { client, dispatcher } = await makeClient();
    const received: FeishuLongConnectionMessage[] = [];
    client.onMessage((msg) => { received.push(msg); });

    dispatcher.dispatch("im.message.receive_v1", eventData("post", {
      content: {
        zh_cn: {
          title: "周报",
          content: [
            [{ tag: "text", text: "本周进展：" }],
            [{ tag: "text", text: "完成了 " }, { tag: "a", text: "方案文档", href: "https://x" }, { tag: "text", text: " 的初稿" }],
            [{ tag: "img", image_key: "img_v2_aaa111" }],
            [{ tag: "text", text: "上图是架构草图" }, { tag: "img", image_key: "img_v2_bbb222" }],
          ],
        },
      },
    }));
    await new Promise(r => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    const msg = received[0];
    // text 段拼接：段内连写、段落间空行；a 段文字并入
    expect(msg.text).toBe("本周进展：\n\n完成了 方案文档 的初稿\n\n上图是架构草图");
    expect(msg.messageType).toBe("post");
    expect(msg.media?.type).toBe("post");
    expect(msg.media?.postItems).toEqual([
      { kind: "image", key: "img_v2_aaa111" },
      { kind: "image", key: "img_v2_bbb222" },
    ]);
  });

  it("media 段（文件）：file_key + file_name 进 postItems（kind=file）", async () => {
    const { client, dispatcher } = await makeClient();
    const received: FeishuLongConnectionMessage[] = [];
    client.onMessage((msg) => { received.push(msg); });

    dispatcher.dispatch("im.message.receive_v1", eventData("post", {
      content: {
        zh_cn: {
          title: "",
          content: [
            [{ tag: "text", text: "附件在这" }],
            [{ tag: "media", file_key: "file_v3_qrs123", file_name: "需求清单.docx" }],
            [{ tag: "img", image_key: "img_v2_ccc333" }],
          ],
        },
      },
    }));
    await new Promise(r => setTimeout(r, 0));

    const msg = received[0];
    expect(msg.text).toBe("附件在这");
    expect(msg.media?.postItems).toEqual([
      { kind: "file", key: "file_v3_qrs123", fileName: "需求清单.docx" },
      { kind: "image", key: "img_v2_ccc333" },
    ]);
  });

  it("纯文本 post：不带 media 载荷（走原文本路径）", async () => {
    const { client, dispatcher } = await makeClient();
    const received: FeishuLongConnectionMessage[] = [];
    client.onMessage((msg) => { received.push(msg); });

    dispatcher.dispatch("im.message.receive_v1", eventData("post", {
      content: {
        zh_cn: {
          title: "说明",
          content: [
            [{ tag: "text", text: "只是文字" }],
            [{ tag: "text", text: "第二段" }],
          ],
        },
      },
    }));
    await new Promise(r => setTimeout(r, 0));

    const msg = received[0];
    expect(msg.text).toBe("只是文字\n\n第二段");
    expect(msg.media).toBeUndefined();
  });

  it("语言体定位：content.content 缺配置语言时取第一个可用语言体", async () => {
    const { client, dispatcher } = await makeClient();
    const received: FeishuLongConnectionMessage[] = [];
    client.onMessage((msg) => { received.push(msg); });

    // 新版事件只推 en_us（配置语言缺）：取第一个可用语言体
    dispatcher.dispatch("im.message.receive_v1", eventData("post", {
      content: {
        en_us: {
          title: "",
          content: [
            [{ tag: "text", text: "hello world" }],
            [{ tag: "img", image_key: "img_v2_en1" }],
          ],
        },
      },
    }));
    await new Promise(r => setTimeout(r, 0));

    const msg = received[0];
    expect(msg.text).toBe("hello world");
    expect(msg.media?.postItems).toEqual([{ kind: "image", key: "img_v2_en1" }]);
  });

  it("非法 content（非 post 结构）：不炸，空 text 无 media（占位由下游兜底）", async () => {
    const { client, dispatcher } = await makeClient();
    const received: FeishuLongConnectionMessage[] = [];
    client.onMessage((msg) => { received.push(msg); });

    // content.content 缺失（不是 post 结构）→ text 空 + media 无
    dispatcher.dispatch("im.message.receive_v1", eventData("post", { foo: "bar" }));
    // content 是合法 JSON 但无 text 字段
    dispatcher.dispatch("im.message.receive_v1", eventData("post", { content: { title: "x" } }));
    await new Promise(r => setTimeout(r, 0));

    expect(received).toHaveLength(2);
    expect(received[0].text).toBe("");
    expect(received[0].media).toBeUndefined();
    expect(received[1].text).toBe("");
    expect(received[1].media).toBeUndefined();
  });

  it("段内混排顺序：同一位置 text+img 交错时 media 项仍按段落顺序收集", async () => {
    const { client, dispatcher } = await makeClient();
    const received: FeishuLongConnectionMessage[] = [];
    client.onMessage((msg) => { received.push(msg); });

    dispatcher.dispatch("im.message.receive_v1", eventData("post", {
      content: {
        zh_cn: {
          title: "",
          content: [
            [{ tag: "img", image_key: "img_1" }, { tag: "text", text: "夹在两张图中间" }, { tag: "img", image_key: "img_2" }],
          ],
        },
      },
    }));
    await new Promise(r => setTimeout(r, 0));

    const msg = received[0];
    expect(msg.text).toBe("夹在两张图中间");
    expect(msg.media?.postItems).toEqual([
      { kind: "image", key: "img_1" },
      { kind: "image", key: "img_2" },
    ]);
  });

  it("text 消息不回归：content.text 原路径", async () => {
    const { client, dispatcher } = await makeClient();
    const received: FeishuLongConnectionMessage[] = [];
    client.onMessage((msg) => { received.push(msg); });

    dispatcher.dispatch("im.message.receive_v1", eventData("text", { text: "普通文本" }));
    await new Promise(r => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("普通文本");
    expect(received[0].media).toBeUndefined();
  });

  it("image/file 单媒体消息不回归：media 载荷形态不变", async () => {
    const { client, dispatcher } = await makeClient();
    const received: FeishuLongConnectionMessage[] = [];
    client.onMessage((msg) => { received.push(msg); });

    dispatcher.dispatch("im.message.receive_v1", eventData("image", { image_key: "img_v2_solo" }));
    dispatcher.dispatch("im.message.receive_v1", eventData("file", { file_key: "file_v2_solo", file_name: "a.pdf" }));
    await new Promise(r => setTimeout(r, 0));

    expect(received).toHaveLength(2);
    expect(received[0].media).toEqual({ type: "image", imageKey: "img_v2_solo" });
    expect(received[1].media).toEqual({ type: "file", fileKey: "file_v2_solo", fileName: "a.pdf" });
  });
});
