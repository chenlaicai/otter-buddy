import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { createTestDb } from "../../helpers/db";
import {
  collectLlmCalls,
  collectOtterOutput,
  collectToolCallCounts,
  collectPrCounts,
  collectFdocCounts,
  collectDispatchTaskCounts,
} from "@usecases/health/cost-output-collector";
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

  it("cacheRead/input 原始值保留（消费端从此推导 hit rate，#602）", async () => {
    const records = await collectLlmCalls(FIXTURES_DIR, agentSource);
    const bigOtter828 = records.find(r => r.date === "2026-08-28" && r.otterId === "otter-aaa")!;
    // cacheRead = 3000, input = 8000 → 消费端推导 rate = 3000/11000 ≈ 0.2727
    expect(bigOtter828.cacheReadTokens).toBe(3000);
    expect(bigOtter828.inputTokens).toBe(8000);
  });

  it("不同日期分属不同聚合行", async () => {
    const records = await collectLlmCalls(FIXTURES_DIR, agentSource);
    const bigOtter829 = records.find(r => r.date === "2026-08-29" && r.otterId === "otter-aaa")!;
    expect(bigOtter829).toBeDefined();
    expect(bigOtter829.callCount).toBe(1); // msg4
    expect(bigOtter829.inputTokens).toBe(8000);
    expect(bigOtter829.cacheReadTokens).toBe(0); // 8/29 那条 cacheRead=0（消费端推导 rate=0/(0+8000)=0）
  });

  it("Finding 2: 未知 session 映射通过行内 otterId 归属（不再静默丢弃）", async () => {
    const emptySource = async () => [];
    const records = await collectLlmCalls(FIXTURES_DIR, emptySource);
    // 无 agent_sessions 映射 → 从 user message 内容提取 otterId
    // session-001 的 user message 含 ID：otter-aaa，session-002 含 ID：otter-bbb
    expect(records.length).toBe(3);

    const bigOtter828 = records.find(r => r.date === "2026-08-28" && r.otterId === "otter-aaa");
    expect(bigOtter828).toBeDefined();
    expect(bigOtter828!.otterName).toBe("大獭");

    const smallOtter828 = records.find(r => r.date === "2026-08-28" && r.otterId === "otter-bbb");
    expect(smallOtter828).toBeDefined();
    expect(smallOtter828!.otterName).toBe("小獭甲");
  });

  it("Finding 3: since 按消息 timestamp 过滤，跨日 session 的后续日期数据保留", async () => {
    // session-001 有消息在 8/28 和 8/29，文件名前缀是 2026-08-28
    // since=2026-08-29 → 按消息 timestamp 过滤，8/29 的消息应保留
    const records = await collectLlmCalls(FIXTURES_DIR, agentSource, { since: "2026-08-29" });
    // 只有 8/29 的消息（session-001 的 msg4）
    expect(records.length).toBe(1);
    expect(records[0]!.date).toBe("2026-08-29");
    expect(records[0]!.otterId).toBe("otter-aaa");
    expect(records[0]!.inputTokens).toBe(8000);
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

  it("按 otter + date 聚合发言计数（含 tool call 计数）", () => {
    const toolCallCounts = new Map([
      ["2026-08-28", new Map([["otter-aaa", 2], ["otter-bbb", 1]])],
      ["2026-08-29", new Map([["otter-aaa", 1]])],
    ]);
    const results = collectOtterOutput(db, toolCallCounts, { since: "2026-08-01" });
    expect(results.length).toBe(3); // (8/28, otter-aaa), (8/28, otter-bbb), (8/29, otter-aaa)

    const big828 = results.find(r => r.date === "2026-08-28" && r.otterId === "otter-aaa")!;
    expect(big828.messageCount).toBe(2);
    expect(big828.toolCallCount).toBe(2);
    expect(big828.otterName).toBe("大獭");

    const small828 = results.find(r => r.date === "2026-08-28" && r.otterId === "otter-bbb")!;
    expect(small828.messageCount).toBe(1);
    expect(small828.toolCallCount).toBe(1);

    const big829 = results.find(r => r.date === "2026-08-29" && r.otterId === "otter-aaa")!;
    expect(big829.messageCount).toBe(1);
    expect(big829.toolCallCount).toBe(1);
  });

  it("不计入 user 消息", () => {
    const results = collectOtterOutput(db, new Map(), { since: "2026-08-01" });
    const userRecord = results.find(r => r.otterId === "user-1");
    expect(userRecord).toBeUndefined();
  });

  it("since 过滤", () => {
    const results = collectOtterOutput(db, new Map(), { since: "2026-08-29" });
    expect(results.length).toBe(1);
    expect(results[0]!.date).toBe("2026-08-29");
  });

  it("toolCallCounts 缺失 key 时 toolCallCount 默认 0", () => {
    const results = collectOtterOutput(db, new Map(), { since: "2026-08-01" });
    expect(results.every(r => r.toolCallCount === 0)).toBe(true);
  });
});

describe("collectToolCallCounts", () => {
  const mockMappings: AgentSessionMapping[] = [
    { piSessionId: "test-session-001", otterId: "otter-aaa", otterName: "大獭", otterType: "big" },
    { piSessionId: "test-session-002", otterId: "otter-bbb", otterName: "小獭甲", otterType: "small" },
  ];
  const agentSource = async () => mockMappings;

  it("正确统计 per-date per-otter 的 tool call 数", async () => {
    const result = await collectToolCallCounts(FIXTURES_DIR, agentSource);
    // session-001: msg2 有 2 个 toolCall (8/28), msg4 有 1 个 toolCall (8/29)
    // session-002: msg6 有 1 个 toolCall (8/28)
    expect(result.get("2026-08-28")?.get("otter-aaa")).toBe(2);
    expect(result.get("2026-08-28")?.get("otter-bbb")).toBe(1);
    expect(result.get("2026-08-29")?.get("otter-aaa")).toBe(1);
  });

  it("空目录返回空 Map", async () => {
    const result = await collectToolCallCounts("/nonexistent/path", agentSource);
    expect(result.size).toBe(0);
  });
});

describe("collectPrCounts", () => {
  it("返回 per-date PR 数数组（仓库真实数据）", async () => {
    const repoPath = resolve(__dirname, "../../../");
    const results = await collectPrCounts(repoPath, 30);
    // 仓库有 merge commit，结果应为非空数组
    expect(Array.isArray(results)).toBe(true);
    if (results.length > 0) {
      expect(results[0]).toHaveProperty("date");
      expect(results[0]).toHaveProperty("prCount");
      expect(typeof results[0]!.date).toBe("string");
      expect(typeof results[0]!.prCount).toBe("number");
    }
  });

  it("空仓库路径返回空数组", async () => {
    const results = await collectPrCounts("/nonexistent/path", 30);
    expect(results).toEqual([]);
  });
});

describe("collectFdocCounts", () => {
  it("返回 per-date F 文档数数组（仓库真实数据）", async () => {
    const repoPath = resolve(__dirname, "../../../");
    const results = await collectFdocCounts(repoPath);
    // 仓库有 F 文档，结果应为非空数组
    expect(Array.isArray(results)).toBe(true);
    if (results.length > 0) {
      expect(results[0]).toHaveProperty("date");
      expect(results[0]).toHaveProperty("fdocCount");
      expect(typeof results[0]!.date).toBe("string");
      expect(typeof results[0]!.fdocCount).toBe("number");
    }
  });
});

describe("collectDispatchTaskCounts", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    // 插入 otter 数据
    db.prepare("INSERT INTO otters (id, name, type) VALUES (?, ?, ?)").run("otter-aaa", "大獭", "big");
    db.prepare("INSERT INTO otters (id, name, type) VALUES (?, ?, ?)").run("otter-bbb", "小獭甲", "small");
  });

  afterEach(() => {
    db.close();
  });

  it("统计已完成的 dispatch 任务（按 completedAt 日期聚合）", () => {
    // 插入 dispatch 记录
    db.prepare("INSERT INTO otter_context (otter_id, key, value, updated_at) VALUES (?, ?, ?, ?)").run(
      "otter-aaa",
      "dispatch:dispatch-001",
      JSON.stringify({
        id: "dispatch-001",
        conversationId: "conv-1",
        otterId: "otter-aaa",
        otterName: "大獭",
        task: "修复 bug",
        status: "completed",
        createdAt: "2026-08-28T10:00:00.000Z",
        completedAt: "2026-08-28T12:00:00.000Z",
      }),
      "2026-08-28T12:00:00.000Z"
    );
    db.prepare("INSERT INTO otter_context (otter_id, key, value, updated_at) VALUES (?, ?, ?, ?)").run(
      "otter-bbb",
      "dispatch:dispatch-002",
      JSON.stringify({
        id: "dispatch-002",
        conversationId: "conv-1",
        otterId: "otter-bbb",
        otterName: "小獭甲",
        task: "写文档",
        status: "failed",
        createdAt: "2026-08-28T14:00:00.000Z",
        completedAt: "2026-08-28T15:00:00.000Z",
      }),
      "2026-08-28T15:00:00.000Z"
    );
    db.prepare("INSERT INTO otter_context (otter_id, key, value, updated_at) VALUES (?, ?, ?, ?)").run(
      "otter-aaa",
      "dispatch:dispatch-003",
      JSON.stringify({
        id: "dispatch-003",
        conversationId: "conv-1",
        otterId: "otter-aaa",
        otterName: "大獭",
        task: "测试功能",
        status: "completed",
        createdAt: "2026-08-29T09:00:00.000Z",
        completedAt: "2026-08-29T11:00:00.000Z",
      }),
      "2026-08-29T11:00:00.000Z"
    );

    const results = collectDispatchTaskCounts(db, { since: "2026-08-01" });
    expect(results.length).toBe(2); // 8/28 和 8/29

    const aug28 = results.find(r => r.date === "2026-08-28")!;
    expect(aug28.dispatchCount).toBe(2); // completed + failed

    const aug29 = results.find(r => r.date === "2026-08-29")!;
    expect(aug29.dispatchCount).toBe(1);
  });

  it("不计入 pending/in_progress 的任务", () => {
    db.prepare("INSERT INTO otter_context (otter_id, key, value, updated_at) VALUES (?, ?, ?, ?)").run(
      "otter-aaa",
      "dispatch:dispatch-004",
      JSON.stringify({
        id: "dispatch-004",
        status: "pending",
        createdAt: "2026-08-28T10:00:00.000Z",
      }),
      "2026-08-28T10:00:00.000Z"
    );
    db.prepare("INSERT INTO otter_context (otter_id, key, value, updated_at) VALUES (?, ?, ?, ?)").run(
      "otter-aaa",
      "dispatch:dispatch-005",
      JSON.stringify({
        id: "dispatch-005",
        status: "in_progress",
        createdAt: "2026-08-28T11:00:00.000Z",
      }),
      "2026-08-28T11:00:00.000Z"
    );

    const results = collectDispatchTaskCounts(db, { since: "2026-08-01" });
    expect(results.length).toBe(0);
  });

  it("since 过滤", () => {
    db.prepare("INSERT INTO otter_context (otter_id, key, value, updated_at) VALUES (?, ?, ?, ?)").run(
      "otter-aaa",
      "dispatch:dispatch-006",
      JSON.stringify({
        id: "dispatch-006",
        status: "completed",
        createdAt: "2026-08-28T10:00:00.000Z",
        completedAt: "2026-08-28T12:00:00.000Z",
      }),
      "2026-08-28T12:00:00.000Z"
    );
    db.prepare("INSERT INTO otter_context (otter_id, key, value, updated_at) VALUES (?, ?, ?, ?)").run(
      "otter-aaa",
      "dispatch:dispatch-007",
      JSON.stringify({
        id: "dispatch-007",
        status: "completed",
        createdAt: "2026-08-29T10:00:00.000Z",
        completedAt: "2026-08-29T12:00:00.000Z",
      }),
      "2026-08-29T12:00:00.000Z"
    );

    const results = collectDispatchTaskCounts(db, { since: "2026-08-29" });
    expect(results.length).toBe(1);
    expect(results[0]!.date).toBe("2026-08-29");
  });

  it("无 dispatch 记录返回空数组", () => {
    const results = collectDispatchTaskCounts(db, { since: "2026-08-01" });
    expect(results).toEqual([]);
  });
});
