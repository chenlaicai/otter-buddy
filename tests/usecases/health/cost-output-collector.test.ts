import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { createTestDb } from "../../helpers/db";
import { collectLlmCalls, collectOtterOutput } from "@usecases/health/cost-output-collector";
import type { AgentSessionMapping } from "@usecases/health/cost-output-collector";

const FIXTURES_DIR = resolve(__dirname, "../../fixtures/sessions");

describe("collectLlmCalls", () => {
  const mockMappings: AgentSessionMapping[] = [
    { piSessionId: "test-session-001", otterId: "otter-aaa", otterName: "大獭", otterType: "big" },
    { piSessionId: "test-session-002", otterId: "otter-bbb", otterName: "小獭甲", otterType: "small" },
  ];
  const agentSource = async () => mockMappings;

  it("解析 session JSONL 并按 date+otter+model 聚合", async () => {
    const records = await collectLlmCalls(FIXTURES_DIR, agentSource);
    // session-001 有 3 条 assistant 消息（2条 8/28 + 1条 8/29），session-002 有 1 条（8/28）
    // 聚合后应该是 3 条：(8/28, otter-aaa, mimo), (8/29, otter-aaa, mimo), (8/28, otter-bbb, mimo)
    expect(records.length).toBe(3);

    // 找 8/28 大獭的记录
    const bigOtter828 = records.find(r => r.date === "2026-08-28" && r.otterId === "otter-aaa")!;
    expect(bigOtter828).toBeDefined();
    expect(bigOtter828.model).toBe("mimo-v2.5-pro");
    expect(bigOtter828.callCount).toBe(2); // msg2 + msg3
    expect(bigOtter828.inputTokens).toBe(5000 + 3000); // msg2.input + msg3.input
    expect(bigOtter828.outputTokens).toBe(200 + 100);
    expect(bigOtter828.cacheReadTokens).toBe(1000 + 2000);
    expect(bigOtter828.costTotal).toBeCloseTo(0.0615 + 0.037);
    expect(bigOtter828.otterName).toBe("大獭");
  });

  it("正确计算 cache hit rate: cacheRead / (cacheRead + input)", async () => {
    const records = await collectLlmCalls(FIXTURES_DIR, agentSource);
    const bigOtter828 = records.find(r => r.date === "2026-08-28" && r.otterId === "otter-aaa")!;
    // cacheRead = 3000, input = 8000 → rate = 3000/11000 ≈ 0.2727
    const expectedRate = 3000 / (3000 + 8000);
    expect(bigOtter828.cacheHitRate).toBeCloseTo(expectedRate, 4);
  });

  it("不同日期分属不同聚合行", async () => {
    const records = await collectLlmCalls(FIXTURES_DIR, agentSource);
    const bigOtter829 = records.find(r => r.date === "2026-08-29" && r.otterId === "otter-aaa")!;
    expect(bigOtter829).toBeDefined();
    expect(bigOtter829.callCount).toBe(1); // msg4
    expect(bigOtter829.inputTokens).toBe(8000);
    expect(bigOtter829.cacheReadTokens).toBe(0); // 8/29 那条 cacheRead=0
    expect(bigOtter829.cacheHitRate).toBe(0); // 0/(0+8000)
  });

  it("未知 session 映射跳过", async () => {
    const emptySource = async () => [];
    const records = await collectLlmCalls(FIXTURES_DIR, emptySource);
    expect(records).toEqual([]);
  });

  it("since 过滤：只处理 >= since 日期的文件", async () => {
    const records = await collectLlmCalls(FIXTURES_DIR, agentSource, { since: "2026-08-29" });
    // 只有 8/28 和 8/29 的文件，since=2026-08-29 匹配文件名前缀 2026-08-28（8/28 < 8/29），所以只有 8/29 数据
    // 但文件名前缀是 "2026-08-28..." 和 "2026-08-28..."，since 按文件名前 10 位过滤
    // 2026-08-28 >= 2026-08-29 为 false，所以两个文件都被过滤掉
    // Wait, let me re-check: since "2026-08-29" means file prefix >= "2026-08-29"
    // Both files start with "2026-08-28" which is < "2026-08-29", so both filtered out
    expect(records).toEqual([]);
  });

  it("空目录返回空数组", async () => {
    const records = await collectLlmCalls("/nonexistent/path", agentSource);
    expect(records).toEqual([]);
  });
});

describe("collectOtterOutput", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    // 插入 otter 数据
    db.prepare("INSERT INTO otters (id, name, type) VALUES (?, ?, ?)").run("otter-aaa", "大獭", "big");
    db.prepare("INSERT INTO otters (id, name, type) VALUES (?, ?, ?)").run("otter-bbb", "小獭甲", "small");
    // 插入消息数据（用 conversation 的依赖数据）
    db.prepare("INSERT INTO conversations (id, title) VALUES (?, ?)").run("conv-1", "test");
    db.prepare("INSERT INTO turns (id, conversation_id, turn_number) VALUES (?, ?, ?)").run("turn-1", "conv-1", 1);
    // 插入不同日期的 otter 消息
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_type, sender_id, sequence_num, turn_id, sender_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("m1", "conv-1", "otter", "otter-aaa", 1, "turn-1", "大獭", "2026-08-28 10:00:00");
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_type, sender_id, sequence_num, turn_id, sender_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("m2", "conv-1", "otter", "otter-aaa", 2, "turn-1", "大獭", "2026-08-28 11:00:00");
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_type, sender_id, sequence_num, turn_id, sender_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("m3", "conv-1", "otter", "otter-bbb", 3, "turn-1", "小獭甲", "2026-08-28 12:00:00");
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_type, sender_id, sequence_num, turn_id, sender_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("m4", "conv-1", "otter", "otter-aaa", 4, "turn-1", "大獭", "2026-08-29 09:00:00");
    // user 消息不应被计入
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_type, sender_id, sequence_num, turn_id, sender_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("m5", "conv-1", "user", "user-1", 5, "turn-1", "搭档", "2026-08-28 09:00:00");
  });

  afterEach(() => {
    db.close();
  });

  it("按 otter + date 聚合发言计数", () => {
    const results = collectOtterOutput(db, { since: "2026-08-01" });
    expect(results.length).toBe(3); // (8/28, otter-aaa), (8/28, otter-bbb), (8/29, otter-aaa)

    const big828 = results.find(r => r.date === "2026-08-28" && r.otterId === "otter-aaa")!;
    expect(big828.messageCount).toBe(2);
    expect(big828.otterName).toBe("大獭");

    const small828 = results.find(r => r.date === "2026-08-28" && r.otterId === "otter-bbb")!;
    expect(small828.messageCount).toBe(1);

    const big829 = results.find(r => r.date === "2026-08-29" && r.otterId === "otter-aaa")!;
    expect(big829.messageCount).toBe(1);
  });

  it("不计入 user 消息", () => {
    const results = collectOtterOutput(db, { since: "2026-08-01" });
    // 没有 user 类型的记录
    const userRecord = results.find(r => r.otterId === "user-1");
    expect(userRecord).toBeUndefined();
  });

  it("since 过滤", () => {
    const results = collectOtterOutput(db, { since: "2026-08-29" });
    expect(results.length).toBe(1);
    expect(results[0]!.date).toBe("2026-08-29");
  });
});
