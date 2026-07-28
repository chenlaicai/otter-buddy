/**
 * FTS 应用层写入测试（F20260728htar）。
 * 废触发器后 repository 7 个写方法逐一接管 FTS upsert（写剥离投影），
 * searchMessages 返回 fts.body 投影而非 messages.body 原文。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import type { Message } from "@entities/conversation/message";

const CARD_BODY = '前言\n\n```html-card title="方案对比"\n<table><tr><td>HTML 噪声</td></tr></table>\n```\n\n后记';

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function seedConversation(db: Database.Database): void {
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 't', '2026-07-28T00:00:00Z', '2026-07-28T00:00:00Z')`).run();
  db.prepare(`INSERT INTO turns (id, conversation_id, turn_number, created_at) VALUES ('turn-1', 'conv-1', 1, '2026-07-28T00:00:00Z')`).run();
}

function messageFixture(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    turnId: "turn-1",
    senderType: "otter",
    senderId: "otter-1",
    talkingStonePassedTo: ["user-1"],
    status: "completed",
    body: CARD_BODY,
    sequenceNum: 1,
    contextTokens: null,
    contextTokensMax: null,
    createdAt: "2026-07-28T00:01:00Z",
    completedAt: "2026-07-28T00:01:00Z",
    ...overrides,
  };
}

/** 直读 messages_fts 全部行（绕过 repository） */
function ftsRows(db: Database.Database): { message_id: string; body: string }[] {
  return db.prepare("SELECT message_id, body FROM messages_fts ORDER BY rowid").all() as { message_id: string; body: string }[];
}

describe("SqliteConversationRepository - FTS 应用层写入（F20260728htar）", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;

  beforeEach(() => {
    db = createTestDb();
    seedConversation(db);
    repo = new SqliteConversationRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it("sqlite_master 中不存在 messages_fts_* 触发器", () => {
    const triggers = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'messages_fts_%'",
    ).all();
    expect(triggers).toEqual([]);
  });

  it("createCompletedMessage：FTS 写剥离投影且仅单行（无双写），messages.body 原文不动", async () => {
    await repo.createCompletedMessage(messageFixture());

    const rows = ftsRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("前言\n\n[html-card: 方案对比]\n\n后记");
    /** 原文不动（原则：消息体是唯一事实源） */
    const msg = await repo.getMessageById("msg-1");
    expect(msg!.body).toBe(CARD_BODY);
  });

  it("createStreamingMessage：body=null 时 FTS 写空串", async () => {
    await repo.createStreamingMessage(messageFixture({
      id: "msg-s", body: null, talkingStonePassedTo: null, status: "streaming", completedAt: null,
    }));

    expect(ftsRows(db)).toEqual([{ message_id: "msg-s", body: "" }]);
  });

  it("startSpeaking：FTS 更新为发言 body 的剥离投影", async () => {
    await repo.createStreamingMessage(messageFixture({
      id: "msg-s", body: null, talkingStonePassedTo: null, status: "streaming", completedAt: null,
    }));
    await repo.startSpeaking("msg-s", CARD_BODY, ["user-1"]);

    const rows = ftsRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("前言\n\n[html-card: 方案对比]\n\n后记");
  });

  it("completeMessage：FTS 更新为最终 body 的剥离投影（仍单行）", async () => {
    await repo.createStreamingMessage(messageFixture({
      id: "msg-s", body: null, talkingStonePassedTo: null, status: "streaming", completedAt: null,
    }));
    await repo.startSpeaking("msg-s", "中间 body", ["user-1"]);
    await repo.completeMessage({
      messageId: "msg-s", body: CARD_BODY, talkingStonePassedTo: ["user-1"], completedAt: "2026-07-28T00:02:00Z",
    });

    const rows = ftsRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("前言\n\n[html-card: 方案对比]\n\n后记");
  });

  it("failMessage 带 body：FTS 更新为合成错误文本；不带 body：FTS 保持原值", async () => {
    await repo.createStreamingMessage(messageFixture({
      id: "msg-s", body: null, talkingStonePassedTo: null, status: "streaming", completedAt: null,
    }));
    await repo.startSpeaking("msg-s", CARD_BODY, ["user-1"]);

    /** 不带 body：FTS 不变（body 未写入，等价旧触发器不点火） */
    await repo.failMessage("msg-s", "2026-07-28T00:03:00Z");
    expect(ftsRows(db)[0].body).toBe("前言\n\n[html-card: 方案对比]\n\n后记");

    /** 带 body（运行期主路径：合成文本整体替换）：FTS 跟随更新 */
    await repo.createStreamingMessage(messageFixture({
      id: "msg-f", sequenceNum: 2, body: null, talkingStonePassedTo: null, status: "streaming", completedAt: null,
    }));
    await repo.startSpeaking("msg-f", CARD_BODY, ["user-1"]);
    await repo.failMessage("msg-f", "2026-07-28T00:04:00Z", "[错误] 模型限流");
    const row = ftsRows(db).find(r => r.message_id === "msg-f");
    expect(row!.body).toBe("[错误] 模型限流");
  });

  it("failInFlightMessages：逐行合成新 body 后 FTS 与剥离文本一致", async () => {
    await repo.createStreamingMessage(messageFixture({
      id: "msg-streaming", body: null, talkingStonePassedTo: null, status: "streaming", completedAt: null,
    }));
    await repo.createStreamingMessage(messageFixture({
      id: "msg-speaking", sequenceNum: 2, body: null, talkingStonePassedTo: null, status: "streaming", completedAt: null,
    }));
    await repo.startSpeaking("msg-speaking", CARD_BODY, ["user-1"]);

    const count = await repo.failInFlightMessages("2026-07-28T00:05:00Z", "[服务重启，发言中断]");
    expect(count).toBe(2);

    const rows = ftsRows(db);
    const streaming = rows.find(r => r.message_id === "msg-streaming")!;
    const speaking = rows.find(r => r.message_id === "msg-speaking")!;
    expect(streaming.body).toBe("[服务重启，发言中断]");
    /** speaking 新 body = 中断标记 + 原文（含卡片围栏），剥离后占位 */
    expect(speaking.body).toBe("[服务重启，发言中断]\n\n前言\n\n[html-card: 方案对比]\n\n后记");
  });

  it("abortMessage：FTS 更新为中止 body 的剥离投影", async () => {
    await repo.createStreamingMessage(messageFixture({
      id: "msg-s", body: null, talkingStonePassedTo: null, status: "streaming", completedAt: null,
    }));
    await repo.abortMessage("msg-s", CARD_BODY, ["user-1"], "2026-07-28T00:06:00Z");

    const rows = ftsRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("前言\n\n[html-card: 方案对比]\n\n后记");
  });

  it("searchMessages：返回 fts.body 投影（占位可搜 title，结果不含 HTML 噪声）", async () => {
    await repo.createCompletedMessage(messageFixture());

    const byTitle = await repo.searchMessages("conv-1", "方案对比");
    expect(byTitle).toHaveLength(1);
    expect(byTitle[0].body).toBe("前言\n\n[html-card: 方案对比]\n\n后记");
    expect(byTitle[0].body).not.toContain("<table>");

    /** HTML 标签噪声不在索引中，搜不到 */
    const byNoise = await repo.searchMessages("conv-1", "HTML 噪声");
    expect(byNoise).toHaveLength(0);
  });

  it("searchMessages：回执 JSON 剥离为占位（索引出口 reply 也剥离），摘要仍可检索", async () => {
    await repo.createCompletedMessage(messageFixture({
      id: "msg-reply", senderType: "user", senderId: "user-1",
      body: '选择了方案 B\n\n```html-card-reply card="msg-1:0"\n{"choice":"B","budget_days":3}\n```',
    }));

    const rows = ftsRows(db);
    expect(rows[0].body).toBe("选择了方案 B\n\n[html-card-reply: msg-1:0]");

    /** trigram 分词需要 ≥3 字符的查询词 */
    const results = await repo.searchMessages("conv-1", "选择了方案");
    expect(results).toHaveLength(1);
    expect(results[0].body).toContain("[html-card-reply: msg-1:0]");
    expect(results[0].body).not.toContain("budget_days");
  });
});
