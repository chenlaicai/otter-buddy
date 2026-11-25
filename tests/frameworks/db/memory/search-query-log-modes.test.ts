// lint-tests:allow-ddl —— 存量库迁移用例需建无 query_hash/query_length/log_mode 三列的旧形状
// search_query_logs 表（与 schema.test.ts 同类：被测对象就是旧 schema → 新 schema 的补列迁移本身，
// 生产 schema 建不出旧表形态）
/**
 * 检索埋点模式判别测试（隐私默认边界）：
 * - metadata-only（默认）：DB 无 query 原文/preview，queryHash/queryLength/log_mode 落库，
 *   上下文预览零读取；错误日志只带 queryHash
 * - off：零写入零读取
 * - redacted：query/preview 全脱敏；external 对话不记正文；有限保留期清理正确
 * - 按对话删除覆盖日志
 * - 存量库迁移：老表补三列后可插入
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteSearchQueryLogRepository } from "@frameworks/db/memory/sqlite-search-query-log-repository";
import { RecordSearchQuery, DEFAULT_SEARCH_LOG_CONFIG } from "@usecases/memory/record-search-query";
import { createTestLogger } from "../../../helpers/logger";

let db: DatabaseType.Database;
let repo: SqliteSearchQueryLogRepository;

/** 录制器：getEntries 是否被读过（metadata-only 不得读上下文） */
let entriesReadCount = 0;
const entryRepo = {
  getEntries: async () => {
    entriesReadCount++;
    return [{ id: "e1", senderId: "u1", senderType: "user", body: "正文含 sk-ant-api03-xxxxxxxxxxxxxxxxxxxx", sequenceNum: 1 }];
  },
  getEntryById: async () => null,
};

function makeRecorder(mode: "metadata-only" | "redacted" | "off", retentionDays = 30, kind: "normal" | "external" | null = "normal") {
  return new RecordSearchQuery(
    repo as never,
    entryRepo as never,
    createTestLogger(),
    async () => kind,
    { mode, redactedRetentionDays: retentionDays },
  );
}

beforeAll(() => {
  db = new Database(":memory:");
  initSchema(db, createTestLogger());
  repo = new SqliteSearchQueryLogRepository(db);
});

afterAll(() => {
  db.close();
});

function lastRow(): Record<string, string | number | null> {
  return db.prepare("SELECT * FROM search_query_logs ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as Record<string, string | number | null>;
}

describe("metadata-only（默认）", () => {
  it("默认配置即 metadata-only", () => {
    expect(DEFAULT_SEARCH_LOG_CONFIG.mode).toBe("metadata-only");
  });

  it("DB 无 query 原文与 preview，hash/长度/模式落库，上下文零读取", async () => {
    const readsBefore = entriesReadCount;
    await makeRecorder("metadata-only").record({
      query: "搭档上次问的方案", conversationId: "conv-m1", callerId: "otter-1",
      topEntryIds: ["t1"], total: 1,
    });
    const row = lastRow();
    expect(row.query).toBe("");
    expect(JSON.parse(row.context_messages as string)).toEqual([]);
    expect(row.log_mode).toBe("metadata-only");
    expect(row.query_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.query_length).toBe("搭档上次问的方案".length);
    expect(row.top_entry_ids).toBeTruthy();
    expect(row.total).toBe(1);
    // 不读取上下文预览
    expect(entriesReadCount).toBe(readsBefore);
  });

  it("queryHash 对同原文稳定、不同原文可区分", async () => {
    await makeRecorder("metadata-only").record({ query: "同一段查询", conversationId: "c-h", callerId: null, topEntryIds: [], total: 0 });
    const h1 = lastRow().query_hash;
    await makeRecorder("metadata-only").record({ query: "同一段查询", conversationId: "c-h", callerId: null, topEntryIds: [], total: 0 });
    const h2 = lastRow().query_hash;
    await makeRecorder("metadata-only").record({ query: "另一段查询", conversationId: "c-h", callerId: null, topEntryIds: [], total: 0 });
    const h3 = lastRow().query_hash;
    expect(h1).toBe(h2);
    expect(h3).not.toBe(h1);
  });
});

describe("off", () => {
  it("零写入零读取", async () => {
    const rowsBefore = (db.prepare("SELECT COUNT(*) AS n FROM search_query_logs").get() as { n: number }).n;
    const readsBefore = entriesReadCount;
    await makeRecorder("off").record({
      query: "不该被记录", conversationId: "conv-off", callerId: "otter-1",
      topEntryIds: ["x"], total: 1,
    });
    expect((db.prepare("SELECT COUNT(*) AS n FROM search_query_logs").get() as { n: number }).n).toBe(rowsBefore);
    expect(entriesReadCount).toBe(readsBefore);
  });
});

describe("redacted（显式评估）", () => {
  it("query 与 preview 均脱敏后落库", async () => {
    await makeRecorder("redacted").record({
      query: "查 sk-ant-api03-abcdefghijklmnopqrstuvwxyz 密钥", conversationId: "conv-r1", callerId: "otter-1",
      topEntryIds: [], total: 0,
    });
    const row = lastRow();
    expect(row.log_mode).toBe("redacted");
    expect(row.query as string).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
    expect(row.query as string).toContain("[REDACTED]");
    const ctx = JSON.parse(row.context_messages as string) as Array<{ preview: string }>;
    expect(ctx[0].preview).not.toContain("sk-ant-api03");
    expect(row.query_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("external 对话不记正文：query 落空、preview 不读", async () => {
    const readsBefore = entriesReadCount;
    await makeRecorder("redacted", 30, "external").record({
      query: "external 原文不该落库", conversationId: "conv-ext", callerId: "otter-1",
      topEntryIds: [], total: 0,
    });
    const row = lastRow();
    expect(row.query).toBe("");
    expect(JSON.parse(row.context_messages as string)).toEqual([]);
    expect(row.log_mode).toBe("redacted");
    expect(row.query_length).toBe("external 原文不该落库".length);
    expect(entriesReadCount).toBe(readsBefore);
  });

  it("有限保留期：插入时清理超期 redacted 行，metadata-only 行不受影响", async () => {
    // 布置：一条 40 天前的 redacted、一条 40 天前的 metadata-only、一条 5 天前的 redacted
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const ins = db.prepare(`INSERT INTO search_query_logs (id, query, query_hash, query_length, log_mode, conversation_id, caller_id, top_entry_ids, total, context_messages, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    ins.run("old-red", "q", "h1", 1, "redacted", "conv-ret", null, "[]", 0, "[]", old);
    ins.run("old-meta", "", "h2", 1, "metadata-only", "conv-ret", null, "[]", 0, "[]", old);
    ins.run("new-red", "q", "h3", 1, "redacted", "conv-ret", null, "[]", 0, "[]", recent);

    await makeRecorder("redacted", 30).record({
      query: "触发清理", conversationId: "conv-ret2", callerId: null, topEntryIds: [], total: 0,
    });

    const ids = (db.prepare("SELECT id FROM search_query_logs WHERE id IN ('old-red','old-meta','new-red')").all() as Array<{ id: string }>).map(r => r.id);
    expect(ids).toContain("new-red");     // 未超期 redacted 保留
    expect(ids).toContain("old-meta");    // metadata-only 无正文不受保留期约束
    expect(ids).not.toContain("old-red"); // 超期 redacted 被清理
  });
});

describe("按对话删除", () => {
  it("deleteByConversation 覆盖该对话全部模式行", async () => {
    await makeRecorder("metadata-only").record({ query: "q1", conversationId: "conv-del", callerId: null, topEntryIds: [], total: 0 });
    await makeRecorder("redacted").record({ query: "q2", conversationId: "conv-del", callerId: null, topEntryIds: [], total: 0 });
    await makeRecorder("metadata-only").record({ query: "q3", conversationId: "conv-keep", callerId: null, topEntryIds: [], total: 0 });
    const removed = await repo.deleteByConversation("conv-del");
    expect(removed).toBeGreaterThanOrEqual(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM search_query_logs WHERE conversation_id = ?").get("conv-del") as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM search_query_logs WHERE conversation_id = ?").get("conv-keep") as { n: number }).n).toBeGreaterThanOrEqual(1);
  });
});

describe("存量库迁移", () => {
  it("老表无三列 → initSchema 补列后可插入（默认 metadata-only）", () => {
    const old = new Database(":memory:");
    // 仿老库：只建旧结构表
    old.exec(`
      CREATE TABLE search_query_logs (
        id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        caller_id TEXT,
        detail_level TEXT,
        library TEXT,
        limit_count INTEGER,
        top_entry_ids TEXT NOT NULL,
        total INTEGER NOT NULL,
        context_messages TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    // 存量行
    old.prepare("INSERT INTO search_query_logs (id, query, conversation_id, top_entry_ids, total, context_messages, created_at) VALUES ('legacy-1', '历史原文', 'conv-old', '[]', 0, '[]', '2026-01-01T00:00:00Z')").run();

    initSchema(old, createTestLogger()); // 幂等迁移：补 query_hash/query_length/log_mode

    const row = old.prepare("SELECT * FROM search_query_logs WHERE id = 'legacy-1'").get() as Record<string, string | number>;
    expect(row.query_hash).toBe("");               // 存量行默认值，不伪造
    expect(row.query_length).toBe(0);
    expect(row.log_mode).toBe("metadata-only");

    const legacyRepo = new SqliteSearchQueryLogRepository(old);
    legacyRepo.insert({
      query: "", conversationId: "conv-old", callerId: null, topEntryIds: [], total: 0,
      queryHash: "b".repeat(64), queryLength: 4, logMode: "metadata-only", contextMessages: [],
    });
    const inserted = old.prepare("SELECT * FROM search_query_logs WHERE id != 'legacy-1'").get() as Record<string, string | number>;
    expect(inserted.log_mode).toBe("metadata-only");
    old.close();
  });
});

describe("错误日志只带 queryHash", () => {
  it("repo 抛错时 warn 不含 query 原文", async () => {
    const logs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const failingRepo = { insert: async () => { throw new Error("db down"); } };
    const recorder = new RecordSearchQuery(
      failingRepo as never,
      entryRepo as never,
      { warn: (msg: string, meta?: Record<string, unknown>) => { logs.push({ msg, meta }); }, info: () => {}, error: () => {}, debug: () => {} } as never,
      async () => "normal",
      { mode: "metadata-only", redactedRetentionDays: 30 },
    );
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
    await expect(recorder.record({
      query: `查询含密钥 ${secret}`, conversationId: "conv-err", callerId: null,
      topEntryIds: [], total: 0,
    })).resolves.toBeUndefined();
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain("查询含密钥");
    expect(logged).toContain("queryHash");
  });
});
