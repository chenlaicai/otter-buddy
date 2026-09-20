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
import { collectInvokeStats } from "@usecases/health/invoke-stats-collector";
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
    // 插入不同日期的獭 speak entries（F20260913ctlv 批4c：messages 表已 drop）
    const seedEntry = (id: string, seq: number, senderId: string, senderName: string, createdAt: string) =>
      db.prepare(`
        INSERT INTO entries (id, conversation_id, sequence_num, entry_type, sender_type, sender_id, body, invoke_id, yield_targets, status, sender_name, created_at, completed_at)
        VALUES (?, 'conv-1', ?, 'speak', 'otter', ?, '气泡', NULL, NULL, 'completed', ?, ?, ?)
      `).run(id, seq, senderId, senderName, createdAt, createdAt);
    seedEntry("m1", 1, "otter-aaa", "大獭", "2026-08-28 10:00:00");
    seedEntry("m2", 2, "otter-aaa", "大獭", "2026-08-28 11:00:00");
    seedEntry("m3", 3, "otter-bbb", "小獭甲", "2026-08-28 12:00:00");
    seedEntry("m4", 4, "otter-aaa", "大獭", "2026-08-29 09:00:00");
    // user 消息不应被计入
    db.prepare(`
      INSERT INTO entries (id, conversation_id, sequence_num, entry_type, sender_type, sender_id, body, invoke_id, yield_targets, status, sender_name, created_at, completed_at)
      VALUES ('m5', 'conv-1', 5, 'user', 'user', 'user-1', '用户发言', NULL, NULL, 'completed', '搭档', '2026-08-28 09:00:00', '2026-08-28 09:00:00')
    `).run();
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

describe("collectInvokeStats（F20260914usgm：单次问答均值）", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    db.prepare("INSERT INTO otters (id, name, type) VALUES (?, ?, ?)").run("otter-aaa", "大獭", "big");
    db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', '测试对话', datetime('now'), datetime('now'))").run();
  });

  afterEach(() => {
    db.close();
  });

  function insertInvoke(p: {
    id: string; otter?: string; status?: string; started: string; ended: string | null;
    tools?: number; in?: number | null; out?: number | null; metadata?: string;
  }) {
    db.prepare(`
      INSERT INTO invokes (id, conversation_id, otter_id, status, trigger_entry_id,
        talking_stone_passed_to, started_at, ended_at, tool_call_count,
        token_usage_input, token_usage_output, metadata)
      VALUES (?, 'conv-1', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
    `).run(
      p.id, p.otter ?? "otter-aaa", p.status ?? "completed", p.started, p.ended,
      p.tools ?? 0, p.in ?? null, p.out ?? null, p.metadata ?? null,
    );
  }

  it("token 差分：同 session 连续 invoke 取相邻差值，新 session 回退取全量", () => {
    insertInvoke({ id: "inv-1", started: "2026-09-14T08:00:00Z", ended: "2026-09-14T08:05:00Z", tools: 10, in: 100000, out: 20000, metadata: JSON.stringify({ model: "glm-5.3" }) });
    insertInvoke({ id: "inv-2", started: "2026-09-14T09:00:00Z", ended: "2026-09-14T09:06:00Z", tools: 8, in: 160000, out: 26000, metadata: JSON.stringify({ model: "glm-5.3" }) });
    // 新 session（累计值回退）：in < 前一条 → 取全量
    insertInvoke({ id: "inv-3", started: "2026-09-14T10:00:00Z", ended: "2026-09-14T10:04:00Z", tools: 5, in: 50000, out: 8000, metadata: JSON.stringify({ model: "k3" }) });

    const stats = collectInvokeStats(db, { since: "2026-09-14" });
    const glm = stats.find(s => s.model === "glm-5.3")!;
    expect(glm).toBeDefined();
    expect(glm.invokeCount).toBe(2);
    expect(glm.avgToolCalls).toBe(9); // (10+8)/2
    expect(glm.avgDurationSec).toBe(330); // (300+360)/2
    // 差分：inv-1=100000（首条全量），inv-2=160000-100000=60000 → 平均 (100000+60000)/2=80000
    expect(glm.avgInputTokens).toBe(80000);
    expect(glm.avgOutputTokens).toBe(13000); // (20000+6000)/2 — 差分：inv-1=20000 全量，inv-2=26000-20000=6000

    const k3 = stats.find(s => s.model === "k3")!;
    expect(k3.avgInputTokens).toBe(50000); // 新 session 全量

    const total = stats.find(s => s.model === "_total")!;
    expect(total.invokeCount).toBe(3);
  });

  it("无 metadata.model 归 unknown 桶；running/无终态行不进耗时均值", () => {
    insertInvoke({ id: "inv-1", started: "2026-09-14T08:00:00Z", ended: "2026-09-14T08:05:00Z", tools: 3, in: 1000, out: 100 });
    insertInvoke({ id: "inv-2", started: "2026-09-14T08:30:00Z", ended: null, tools: 2, in: null, out: null });

    const stats = collectInvokeStats(db, { since: "2026-09-14" });
    const unknown = stats.find(s => s.model === "unknown")!;
    expect(unknown).toBeDefined();
    expect(unknown.invokeCount).toBe(2);
    expect(unknown.avgToolCalls).toBe(2.5); // (3+2)/2
    // 只有 inv-1 有终态 → 耗时均值 = 300s
    expect(unknown.avgDurationSec).toBe(300);
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

describe("collectDispatchTaskCounts（F20260912avlb 新口径：每日派工数，按 dispatched_at 聚合）", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function insertDispatch(id: string, otterId: string, status: string, dispatchedAt: string | null, createdAt = "2026-08-28T09:00:00.000Z") {
    db.prepare(
      "INSERT INTO dispatch_records (id, conversation_id, otter_id, otter_name, task, status, created_at, dispatched_at, dissolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, "conv-1", otterId, "测试獭", "任务", status, createdAt, dispatchedAt, null);
  }

  it("按 dispatched_at 日期聚合派工数（含 dissolved 记录——被派过工是事实）", () => {
    insertDispatch("dr-1", "otter-aaa", "dispatched", "2026-08-28T10:00:00.000Z");
    insertDispatch("dr-2", "ot-bbb", "dispatched", "2026-08-28T14:00:00.000Z");
    insertDispatch("dr-3", "otter-aaa", "dissolved", "2026-08-29T09:00:00.000Z", "2026-08-29T08:00:00.000Z");

    const results = collectDispatchTaskCounts(db, { since: "2026-08-01" });
    expect(results.length).toBe(2);

    const aug28 = results.find(r => r.date === "2026-08-28")!;
    expect(aug28.dispatchCount).toBe(2);

    const aug29 = results.find(r => r.date === "2026-08-29")!;
    expect(aug29.dispatchCount).toBe(1);
  });

  it("created（未派工）与 NULL dispatched_at 不计入", () => {
    insertDispatch("dr-4", "otter-aaa", "created", null);
    // 边界：dispatched 状态但 dispatched_at 为 NULL（防御性验证：不炸不计数）
    insertDispatch("dr-5", "otter-aaa", "dispatched", null, "2026-08-29T07:00:00.000Z");

    const results = collectDispatchTaskCounts(db, { since: "2026-08-01" });
    expect(results).toEqual([]);
  });

  it("since 过滤", () => {
    insertDispatch("dr-6", "otter-aaa", "dispatched", "2026-08-28T10:00:00.000Z");
    insertDispatch("dr-7", "otter-aaa", "dispatched", "2026-08-29T10:00:00.000Z", "2026-08-29T09:30:00.000Z");

    const results = collectDispatchTaskCounts(db, { since: "2026-08-29" });
    expect(results.length).toBe(1);
    expect(results[0]!.date).toBe("2026-08-29");
  });

  it("空表返回空数组", () => {
    const results = collectDispatchTaskCounts(db, { since: "2026-08-01" });
    expect(results).toEqual([]);
  });
});
