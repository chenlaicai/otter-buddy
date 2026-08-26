/**
 * F20260826rcmm Phase 0：检索埋点集成测试。
 * 覆盖：insert 落表（JSON 字段序列化）、RecordSearchQuery 上下文快照构建
 * （最近 5 条、正序、预览截断）、fire-and-forget 失败不抛。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteSearchQueryLogRepository } from "@frameworks/db/memory/sqlite-search-query-log-repository";
import { RecordSearchQuery } from "@usecases/memory/record-search-query";
import { createTestLogger } from "../../../helpers/logger";

let db: DatabaseType.Database;
let repo: SqliteSearchQueryLogRepository;
let queryMessage: { getMessages: (convId: string, opts: { limit: number; before?: string }) => Promise<Array<{ id: string; senderId: string; senderType: string; segments: Array<{ body: string }> }>> };

const logger = createTestLogger();

beforeAll(() => {
  db = new Database(":memory:");
  initSchema(db);
  repo = new SqliteSearchQueryLogRepository(db);
});

afterAll(() => {
  db.close();
});

function makeRecorder(contextMessages: Array<{ id: string; body: string }>) {
  queryMessage = {
    getMessages: async (_convId, opts) => {
      // 模拟 repo 行为：DESC 取最近 N 条；before 存在时只取该消息之前的（kimi 发现 1：快照不含触发消息）
      const sorted = [...contextMessages]
        .filter((m) => !opts.before || m.id !== opts.before)
        .reverse()
        .slice(0, opts.limit);
      return sorted.map((m) => ({
        id: m.id, senderId: "otter-1", senderType: "assistant",
        segments: [{ body: m.body }],
      }));
    },
  };
  return new RecordSearchQuery(repo, queryMessage as never, logger);
}

describe("SqliteSearchQueryLogRepository.insert", () => {
  it("落表且 JSON 字段可读回", async () => {
    await repo.insert({
      query: "记忆系统 设计方案",
      conversationId: "conv-1",
      callerId: "otter-1",
      detailLevel: "summary",
      library: "conversation",
      limitCount: 10,
      topEntryIds: ["e1", "e2"],
      total: 2,
      contextMessages: [{ id: "m1", senderId: "u1", role: "user", preview: "上次那个方案" }],
    });

    const row = db.prepare("SELECT * FROM search_query_logs WHERE conversation_id = ?").get("conv-1") as Record<string, string | number | null>;
    expect(row).toBeTruthy();
    expect(row.query).toBe("记忆系统 设计方案");
    expect(row.caller_id).toBe("otter-1");
    expect(JSON.parse(row.top_entry_ids as string)).toEqual(["e1", "e2"]);
    const ctx = JSON.parse(row.context_messages as string) as Array<{ preview: string }>;
    expect(ctx[0].preview).toBe("上次那个方案");
    expect(row.created_at).toBeTruthy();
  });
});

describe("RecordSearchQuery.record", () => {
  it("上下文快照：最近 5 条正序 + 预览截断 160", async () => {
    const long = "x".repeat(200);
    const recorder = makeRecorder([
      { id: "m1", body: "第一条" },
      { id: "m2", body: "第二条" },
      { id: "m3", body: long },
      { id: "m4", body: "第四条" },
      { id: "m5", body: "第五条" },
      { id: "m6", body: "第六条" }, // 应被截掉（只取最近 5）
    ]);

    await recorder.record({
      query: "test", conversationId: "conv-ctx", callerId: null,
      topEntryIds: ["a", "b", "c", "d", "e", "f", "g"], total: 7,
    });

    const row = db.prepare("SELECT context_messages, top_entry_ids FROM search_query_logs WHERE conversation_id = ?").get("conv-ctx") as Record<string, string>;
    const ctx = JSON.parse(row.context_messages) as Array<{ id: string; preview: string }>;
    // 最近 5 条（m2-m6），正序还原
    expect(ctx.map((c) => c.id)).toEqual(["m2", "m3", "m4", "m5", "m6"]);
    // 预览截断
    expect(ctx.find((c) => c.id === "m3")!.preview.length).toBe(160);
    // topEntryIds 截前 5（recall@5 标注够用）
    expect(JSON.parse(row.top_entry_ids)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("上下文快照排除触发检索的当前消息（beforeMessageId，kimi 发现 1）", async () => {
    const recorder = makeRecorder([
      { id: "m1", body: "第一条" },
      { id: "m2", body: "第二条" },
      { id: "m-cur", body: "让我查一下记忆系统的方案" }, // 触发检索的当前消息，应被排除
    ]);

    await recorder.record({
      query: "记忆系统方案", conversationId: "conv-exc", callerId: "otter-1",
      beforeMessageId: "m-cur",
      topEntryIds: ["e1"], total: 1,
    });

    const row = db.prepare("SELECT context_messages FROM search_query_logs WHERE conversation_id = ?").get("conv-exc") as Record<string, string>;
    const ctx = JSON.parse(row.context_messages) as Array<{ id: string }>;
    // 快照 = 查询发起前的上下文：m1、m2，不含 m-cur
    expect(ctx.map((c) => c.id)).toEqual(["m1", "m2"]);
  });

  it("fire-and-forget：repo 抛错时不外抛", async () => {
    const failingRepo = { insert: async () => { throw new Error("db down"); } };
    const recorder = new RecordSearchQuery(
      failingRepo as never,
      queryMessage as never,
      logger,
    );
    await expect(recorder.record({
      query: "boom", conversationId: "conv-x", callerId: null,
      topEntryIds: [], total: 0,
    })).resolves.toBeUndefined();
  });

  it("空上下文（无消息对话）也正常落表", async () => {
    const recorder = makeRecorder([]);
    await recorder.record({
      query: "empty", conversationId: "conv-empty", callerId: "otter-9",
      topEntryIds: [], total: 0,
    });
    const row = db.prepare("SELECT context_messages FROM search_query_logs WHERE conversation_id = ?").get("conv-empty") as Record<string, string>;
    expect(JSON.parse(row.context_messages)).toEqual([]);
  });
});
