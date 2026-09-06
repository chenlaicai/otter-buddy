// lint-tests:allow-ddl —— #810 note 保留策略：capNote 纯函数单测 + 真库集成（与 dispatch-attempt-repo.test.ts 同模式）
/**
 * #810：dispatch_attempts.note 无界膨胀治理——滑动窗口 + 段边界截断。
 * 纯函数 capNote 边界穷举 + 真库链路验证（recordStart prev= 嵌套 / recordFinish /
 * appendNote / 死亡证明 / dissolve 销账五条写路径全部有界）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteDispatchAttemptRepo, capNote, NOTE_HARD_CAP, NOTE_KEEP_SEGMENTS } from "@frameworks/db/conversation/sqlite-dispatch-attempt-repo";
import { seedDelivered, seedOtter } from "./helpers/dispatch-attempt-seed";

describe("capNote 纯函数（#810 滑动窗口 + 段边界截断）", () => {
  it("null 透传；短 note 原样返回无标记", () => {
    expect(capNote(null)).toBeNull();
    expect(capNote("")).toBe("");
    const short = "retry failed: tool timeout; prev=failed: db locked @retry";
    expect(capNote(short)).toBe(short);
  });

  it(`段数超窗口（>${NOTE_KEEP_SEGMENTS} 段）：丢最旧段、保留最近段、加截断标记`, () => {
    const segs = Array.from({ length: NOTE_KEEP_SEGMENTS + 5 }, (_, i) => `seg-${String(i).padStart(2, "0")}`);
    const out = capNote(segs.join("; "))!;
    expect(out.startsWith("…（更早 5 段已截断）")).toBe(true);
    expect(out).toContain(`seg-${String(NOTE_KEEP_SEGMENTS + 4).padStart(2, "0")}`); // 最新段保留
    expect(out).not.toContain("seg-04;"); // 最旧段丢弃（seg-00..04）
    expect(out).not.toContain("seg-03;");
  });

  it(`总长超上限（>${NOTE_HARD_CAP}）：继续丢最旧段直到不超限`, () => {
    const longSeg = "x".repeat(500);
    // 定宽段名（seg00…seg11），避免 "0:" 误中 "10:" 的子串断言陷阱
    const segs = Array.from({ length: 12 }, (_, i) => `seg${String(i).padStart(2, "0")}:${longSeg}`); // 12 × ~510 ≈ 6KB
    const out = capNote(segs.join("; "))!;
    expect(out.length).toBeLessThanOrEqual(NOTE_HARD_CAP);
    expect(out.startsWith("…（更早")).toBe(true);
    expect(out).toContain("seg11:"); // 最新段保留
    expect(out).not.toContain("seg00:"); // 最旧段丢弃
    expect(out).not.toContain("seg03:");
  });

  it("单段无分隔符的超长脏数据：尾部硬切、输出有界且带超长截断标记", () => {
    const huge = "y".repeat(NOTE_HARD_CAP * 3);
    const out = capNote(huge)!;
    expect(out.length).toBeLessThanOrEqual(NOTE_HARD_CAP);
    expect(out.startsWith("…（前段超长已截断）")).toBe(true);
    // 硬切保留的是尾部（最近内容），不是头部
    expect(out.endsWith(huge.slice(-100))).toBe(true);
  });

  it("恒有界性：任意输入长度 ≤ NOTE_HARD_CAP", () => {
    const inputs = [
      "z".repeat(NOTE_HARD_CAP * 10),
      Array.from({ length: 100 }, (_, i) => `r${i}:` + "q".repeat(300)).join("; "),
      Array.from({ length: 1000 }, (_, i) => `${i}`).join("; "),
      "段; ".repeat(NOTE_HARD_CAP),
    ];
    for (const input of inputs) {
      const out = capNote(input)!;
      expect(out.length).toBeLessThanOrEqual(NOTE_HARD_CAP);
    }
  });

  it("标记语义：丢 N 段时标记准确计数", () => {
    const segs = Array.from({ length: 50 }, (_, i) => `s${i}`);
    const out = capNote(segs.join("; "))!;
    expect(out.startsWith(`…（更早 ${50 - NOTE_KEEP_SEGMENTS} 段已截断）`)).toBe(true);
  });
});

describe("note 有界化真库集成（#810 五条写路径）", () => {
  let db: Database.Database;
  let repo: SqliteDispatchAttemptRepo;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    repo = new SqliteDispatchAttemptRepo(db);
    seedOtter(db, "otter-1");
    seedDelivered(db, "msg-cap", { targets: ["otter-1"] });
  });

  afterEach(() => {
    db.close();
  });

  const getNote = (): string | null =>
    (db.prepare("SELECT note FROM dispatch_attempts WHERE message_id = 'msg-cap' AND target_otter_id = 'otter-1'").get() as { note: string | null } | undefined)?.note ?? null;

  it("极端 retry 链（100 次 recordStart+recordFinish）：note 恒有界且最近内容保留", () => {
    for (let i = 0; i < 100; i++) {
      repo.recordStart({ id: `a${i}`, conversationId: "conv-1", messageId: "msg-cap", targetOtterId: "otter-1", status: "in_progress", source: "retry", attemptStartedAt: `2026-09-02T09:${String(i % 60).padStart(2, "0")}:00Z`, note: null });
      repo.recordFinish("msg-cap", "otter-1", "failed", `reason-${i}: ` + "x".repeat(200));
    }
    const note = getNote();
    expect(note).not.toBeNull();
    expect(note!.length).toBeLessThanOrEqual(NOTE_HARD_CAP);
    expect(note).toContain("已截断");
    expect(note).toContain("reason-99"); // 最近一次原因完整保留
  });

  it("短 reason 的 retry 链：prev= 压缩链段在窗口内完整保留（grep 排查习惯不变）", () => {
    for (let i = 0; i < 8; i++) {
      repo.recordStart({ id: `d${i}`, conversationId: "conv-1", messageId: "msg-cap", targetOtterId: "otter-1", status: "in_progress", source: "retry", attemptStartedAt: `2026-09-02T09:0${i}:00Z`, note: null });
      repo.recordFinish("msg-cap", "otter-1", "failed", `r${i}`);
    }
    const note = getNote()!;
    expect(note).not.toContain("已截断");
    expect(note).toContain("prev=");
  });

  it("recordFinish：既有 note 接近上限时拼接后仍不越限（总量截断而非片段截断）", () => {
    repo.recordStart({ id: "a1", conversationId: "conv-1", messageId: "msg-cap", targetOtterId: "otter-1", status: "in_progress", source: "chain", attemptStartedAt: "2026-09-02T09:00:00Z", note: null });
    repo.recordFinish("msg-cap", "otter-1", "failed", "f".repeat(NOTE_HARD_CAP - 100));
    repo.recordFinish("msg-cap", "otter-1", "failed", "g".repeat(NOTE_HARD_CAP - 100));
    const note = getNote()!;
    expect(note.length).toBeLessThanOrEqual(NOTE_HARD_CAP);
    expect(note).toContain("已截断");
    expect(note.endsWith("g".repeat(50))).toBe(true); // 新内容（尾部）保留
  });

  it("appendNote：逐次定长追加累积不越限", () => {
    repo.recordStart({ id: "a1", conversationId: "conv-1", messageId: "msg-cap", targetOtterId: "otter-1", status: "in_progress", source: "chain", attemptStartedAt: "2026-09-02T09:00:00Z", note: null });
    for (let i = 0; i < 50; i++) {
      repo.appendNote("msg-cap", "otter-1", `n${i}: ` + "m".repeat(150));
      expect(getNote()!.length).toBeLessThanOrEqual(NOTE_HARD_CAP);
    }
    expect(getNote()).toContain("n49"); // 最新追加保留
  });

  it("死亡证明（markStaleInProgressFailed）：接近上限的历史 note + 固定短注不越限", () => {
    repo.recordStart({ id: "a1", conversationId: "conv-1", messageId: "msg-cap", targetOtterId: "otter-1", status: "in_progress", source: "chain", attemptStartedAt: "2026-09-02T09:00:00Z", note: null });
    repo.appendNote("msg-cap", "otter-1", "k".repeat(NOTE_HARD_CAP - 50));
    repo.markStaleInProgressFailed();
    const row = db.prepare("SELECT status, note FROM dispatch_attempts WHERE message_id = 'msg-cap'").get() as { status: string; note: string };
    expect(row.status).toBe("failed");
    expect(row.note.length).toBeLessThanOrEqual(NOTE_HARD_CAP);
    expect(row.note).toContain("死亡证明"); // 销账语义不被截掉
  });

  it("dissolve 销账（failAllInProgressForOtter）：同上不越限且语义保留", () => {
    seedOtter(db, "otter-2");
    seedDelivered(db, "msg-cap2", { targets: ["otter-2"] });
    repo.recordStart({ id: "b1", conversationId: "conv-1", messageId: "msg-cap2", targetOtterId: "otter-2", status: "in_progress", source: "chain", attemptStartedAt: "2026-09-02T09:00:00Z", note: null });
    repo.appendNote("msg-cap2", "otter-2", "j".repeat(NOTE_HARD_CAP - 50));
    const changed = repo.failAllInProgressForOtter("otter-2");
    expect(changed).toBe(1);
    const row = db.prepare("SELECT status, note FROM dispatch_attempts WHERE message_id = 'msg-cap2'").get() as { status: string; note: string };
    expect(row.status).toBe("failed");
    expect(row.note.length).toBeLessThanOrEqual(NOTE_HARD_CAP);
    expect(row.note).toContain("派发无主");
  });

  it("回归锁：短链场景前情链完整、无截断标记（#795 语义不回退）", () => {
    repo.recordStart({ id: "c1", conversationId: "conv-1", messageId: "msg-cap", targetOtterId: "otter-1", status: "in_progress", source: "chain", attemptStartedAt: "2026-09-02T09:00:00Z", note: null });
    repo.recordFinish("msg-cap", "otter-1", "failed", "tool timeout");
    repo.recordStart({ id: "c2", conversationId: "conv-1", messageId: "msg-cap", targetOtterId: "otter-1", status: "in_progress", source: "retry", attemptStartedAt: "2026-09-02T09:05:00Z", note: null });
    const note = getNote()!;
    expect(note).not.toContain("已截断");
    expect(note).toContain("prev=failed: tool timeout @chain");
  });
});
