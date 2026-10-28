/**
 * F20261027hwl1 collector 行为测试：Shanghai 日界 + provider 进 cost records。
 * 使用 tests/fixtures/sessions 之外的临时 JSONL（覆盖 UTC 16:00 跨日界样本）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createTestDb } from "../../helpers/db";
import { collectLlmCalls, collectToolCallCounts } from "@usecases/health/cost-output-collector";

let db: Database.Database;
let sessionsDir: string;

beforeEach(() => {
  db = createTestDb();
  sessionsDir = mkdtempSync(join(tmpdir(), "wl-sessions-"));
  db.prepare(`INSERT INTO otters (id, name, type, created_at) VALUES ('o1', '测试獭', 'assistant', '2026-01-01T00:00:00Z')`).run();
});

afterEach(() => {
  db.close();
  rmSync(sessionsDir, { recursive: true, force: true });
});

describe("collectLlmCalls 日界与 provider", () => {
  it("UTC 16:00 后的 assistant 调用归 Shanghai 次日；model_change.provider 进记录", async () => {
    // 文件名日期只做粗筛（10-01 起扫）——行内 timestamp 是权威
    writeFileSync(join(sessionsDir, "2026-10-01T00-00-00-000Z_sess1.jsonl"), [
      JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-10-01T00:00:00.000Z", cwd: "/tmp" }),
      JSON.stringify({ type: "model_change", id: "mc1", parentId: null, timestamp: "2026-10-01T00:00:00.100Z", provider: "zhipu", modelId: "glm-5.3" }),
      // UTC 10-27T17:30Z → Shanghai 10-28
      JSON.stringify({ type: "message", id: "m1", timestamp: "2026-10-27T17:30:00.000Z", message: { role: "assistant", model: "glm-5.3", usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, totalTokens: 160, cost: { input: 0.001, output: 0.0025, cacheRead: 0.0001, cacheWrite: 0, total: 0.0036 } }, stopReason: "stop", content: [] } }),
      // UTC 10-27T07:00Z → Shanghai 10-27
      JSON.stringify({ type: "message", id: "m2", timestamp: "2026-10-27T07:00:00.000Z", message: { role: "assistant", model: "glm-5.3", usage: { input: 200, output: 80, cacheRead: 20, cacheWrite: 0, totalTokens: 300, cost: { input: 0.002, output: 0.004, cacheRead: 0.0002, cacheWrite: 0, total: 0.0062 } }, stopReason: "stop", content: [] } }),
    ].join("\n"), "utf-8");

    // agentSessionSource：返回空映射（identity 走 unknown 兜底——不影响日界/provider 断言）
    const records = await collectLlmCalls(sessionsDir, () => Promise.resolve([]), { since: "2026-10-01" });
    expect(records.length).toBe(2);
    const day28 = records.find(r => r.date === "2026-10-28");
    const day27 = records.find(r => r.date === "2026-10-27");
    expect(day28).toBeDefined();
    expect(day27).toBeDefined();
    expect(day28!.provider).toBe("zhipu");
    expect(day27!.inputTokens).toBe(200);
  });
});

describe("A4 回归：工具调用计数 Shanghai 日界（与 token 记录同轨）", () => {
  it("UTC 16:00 后的 toolCall 归 Shanghai 次日（不再 UTC 裸 slice）", async () => {
    writeFileSync(join(sessionsDir, "2026-10-01T00-00-00-000Z_sess2.jsonl"), [
      JSON.stringify({ type: "session", version: 3, id: "s2", timestamp: "2026-10-01T00:00:00.000Z", cwd: "/tmp" }),
      // UTC 10-27T17:30Z → Shanghai 10-28（旧 UTC slice 归 10-27——口径分裂现场）
      JSON.stringify({ type: "message", id: "tc1", timestamp: "2026-10-27T17:30:00.000Z", message: { role: "assistant", model: "glm-5.3", stopReason: "stop", content: [{ type: "toolCall", id: "tc", name: "speak", arguments: "{}" }] } }),
      // UTC 10-27T07:00Z → Shanghai 10-27
      JSON.stringify({ type: "message", id: "tc2", timestamp: "2026-10-27T07:00:00.000Z", message: { role: "assistant", model: "glm-5.3", stopReason: "stop", content: [{ type: "toolCall", id: "tc", name: "speak", arguments: "{}" }] } }),
    ].join("\n"), "utf-8");

    const counts = await collectToolCallCounts(sessionsDir, () => Promise.resolve([]), { since: "2026-10-01" });
    expect(counts.get("2026-10-28")).toBeDefined();
    expect(counts.get("2026-10-27")).toBeDefined();
  });
});
