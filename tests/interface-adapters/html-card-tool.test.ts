/**
 * HTML 卡片特性工具面测试（F20260728htar）：
 * - get_html_card_contract 注册与契约内容
 * - speak description 最小契约
 * - 大小獭白名单登记
 * - list_messages / get_turn_history 注入出口剥离投影（只剥卡片，回执保留）
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ToolContext } from "@usecases/ports/agent-tools";
import { HTML_CARD_CONTRACT } from "@interface-adapters/agent-runtime/tools/html-card-contract-tool";
import { getOtterToolNamesForType } from "@frameworks/agent/session-helpers";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";
import type { Message } from "@entities/conversation/message";
import { aggregateBody } from "@entities/conversation/message";

const CARD_BODY = '前言\n```html-card title="方案对比"\n<table/>\n```\n后记';
const REPLY_BODY = '选择了方案 B\n```html-card-reply card="m1:0"\n{"choice":"B"}\n```';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1", conversationId: "conv-1", turnId: "turn-1",
    senderType: "otter", senderId: "otter-1",
    talkingStonePassedTo: ["user-1"], status: "completed",
    segments: [{ id: "seg-1", messageId: "msg-1", body: CARD_BODY, sequenceNum: 0, createdAt: "2026-07-28T00:00:00Z" }],
    sequenceNum: 1,
    contextTokens: null, contextTokensMax: null,
    source: "web",
      createdAt: "2026-07-28T00:00:00Z", completedAt: "2026-07-28T00:01:00Z",
    ...overrides,
  };
}

function makeCtx(clientOverrides: Partial<OtterToolClient> = {}): ToolContext {
  const client = {
    conversation: {
      message: {
        list: async () => [makeMessage()],
        getTurnHistory: async () => [{
          turn: { id: "turn-1", conversationId: "conv-1", turnNumber: 1, status: "closed", createdAt: "2026-07-28T00:00:00Z", closedAt: "2026-07-28T00:02:00Z" },
          messages: [makeMessage()],
        }],
      },
    },
    ...clientOverrides,
  } as unknown as OtterToolClient;
  return { client, otterId: "otter-1", conversationId: "conv-1", currentMessageId: "msg-cur" };
}

describe("get_html_card_contract 工具", () => {
  it("createTools 注册 20 个工具，含 get_html_card_contract", () => {
    const tools = createTools(makeCtx());
    expect(tools.map(t => t.name)).toContain("get_html_card_contract");
  });

  it("契约文本覆盖关键章节：样式变量 / 交互 API / 禁用清单 / 回执与 id 规则", async () => {
    const tool = createTools(makeCtx()).find(t => t.name === "get_html_card_contract")!;
    const res = await tool.execute("c1", {});
    const text = res.content[0].text;
    expect(text).toContain("var(--otter-");
    expect(text).toContain("otterCard.submit");
    expect(text).toContain("meta refresh");
    expect(text).toContain("location.reload");
    expect(text).toContain("document.write");
    expect(text).toContain("{messageId}:{fenceIndex}");
    expect(text).toContain("get_message");
    expect(text).toContain("不可重复提交");
  });

  it("speak description 携带最小契约（判断标准 / 体积预算 / 回执识别 / 契约工具指引）", () => {
    const speak = createTools(makeCtx()).find(t => t.name === "speak")!;
    expect(speak.description).toContain("html-card");
    expect(speak.description).toContain("最多 2 张");
    expect(speak.description).toContain("get_html_card_contract");
    expect(speak.description).toContain("html-card-reply");
  });
});

describe("契约样式变量与前端注入 token 交叉断言", () => {
  /** 前端实际注入的 token 定义（srcdoc 内 CARD_TOKEN_CSS） */
  const htmlCardSrc = readFileSync(
    fileURLToPath(new URL("../../web/src/pages/conversation/HtmlCard.tsx", import.meta.url)),
    "utf8",
  );
  const tokenCss = /CARD_TOKEN_CSS = `([\s\S]*?)`/.exec(htmlCardSrc)?.[1];
  const definedTokens = new Set([...(tokenCss?.matchAll(/(--[\w-]+)\s*:/g) ?? [])].map(m => m[1]));

  it("HtmlCard.tsx 的 CARD_TOKEN_CSS 可定位且定义了 token", () => {
    expect(tokenCss).toBeTruthy();
    expect(definedTokens.size).toBeGreaterThan(0);
  });

  it("契约文案中每个 var(--x) 都在 CARD_TOKEN_CSS 中实际定义", () => {
    const referenced = [...HTML_CARD_CONTRACT.matchAll(/var\((--[\w-]+)\)/g)].map(m => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const token of referenced) {
      expect(definedTokens.has(token), `契约引用了未注入的 token ${token}`).toBe(true);
    }
  });
});

describe("getOtterToolNamesForType 白名单（大小獭均登记）", () => {
  it("big otter 白名单含 get_html_card_contract", () => {
    expect(getOtterToolNamesForType("big")).toContain("get_html_card_contract");
    expect(getOtterToolNamesForType(undefined)).toContain("get_html_card_contract");
  });

  it("small otter 白名单含 get_html_card_contract", () => {
    expect(getOtterToolNamesForType("small")).toContain("get_html_card_contract");
  });
});

describe("消息工具注入出口剥离投影（只剥 html-card，回执 JSON 保留）", () => {
  it("list_messages：卡片剥离为占位符，其他字段不变", async () => {
    const tool = createTools(makeCtx()).find(t => t.name === "list_messages")!;
    const res = await tool.execute("c1", {});
    const [msg] = JSON.parse(res.content[0].text) as Array<{ id: string; body: string; status: string }>;
    expect(msg.body).toBe("前言\n[html-card: 方案对比]\n后记");
    expect(msg.id).toBe("msg-1");
    expect(msg.status).toBe("completed");
  });

  it("list_messages：html-card-reply 不剥离（回执 JSON 直接可见）", async () => {
    const ctx = makeCtx();
    ctx.client.conversation.message.list = async () => [
      makeMessage({ senderType: "user", senderId: "user-1", segments: [{ id: "seg-1", messageId: "msg-1", body: REPLY_BODY, sequenceNum: 0, createdAt: "2026-07-28T00:00:00Z" }] }),
    ];
    const tool = createTools(ctx).find(t => t.name === "list_messages")!;
    const res = await tool.execute("c1", {});
    const [msg] = JSON.parse(res.content[0].text) as Array<{ body: string }>;
    expect(msg.body).toBe(REPLY_BODY);
  });

  it("list_messages：body 为 null 的 streaming 消息保持 null", async () => {
    const ctx = makeCtx();
    ctx.client.conversation.message.list = async () => [
      makeMessage({ segments: [], status: "streaming", talkingStonePassedTo: null, completedAt: null }),
    ];
    const tool = createTools(ctx).find(t => t.name === "list_messages")!;
    const res = await tool.execute("c1", {});
    const [msg] = JSON.parse(res.content[0].text) as Array<{ body: string | null }>;
    expect(msg.body).toBeNull();
  });

  it("get_turn_history：消息体剥离卡片、保留回执", async () => {
    const ctx = makeCtx();
    ctx.client.conversation.message.getTurnHistory = async () => [{
      turn: { id: "turn-1", conversationId: "conv-1", turnNumber: 1, status: "closed", createdAt: "2026-07-28T00:00:00Z", closedAt: "2026-07-28T00:02:00Z" },
      messages: [makeMessage(), makeMessage({ id: "msg-2", senderType: "user", senderId: "user-1", segments: [{ id: "seg-2", messageId: "msg-2", body: REPLY_BODY, sequenceNum: 0, createdAt: "2026-07-28T00:00:00Z" }], sequenceNum: 2 })],
    }];
    const tool = createTools(ctx).find(t => t.name === "get_turn_history")!;
    const res = await tool.execute("c1", { includeMessages: true });
    const [entry] = JSON.parse(res.content[0].text) as Array<{ messages: Array<{ body: string }> }>;
    expect(entry.messages[0].body).toBe("前言\n[html-card: 方案对比]\n后记");
    expect(entry.messages[1].body).toBe(REPLY_BODY);
  });
});
