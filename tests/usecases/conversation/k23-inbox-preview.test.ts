/**
 * K2 收件箱预告（F20260903k23）：buildMessageWithContext 的 pending 计数注入。
 *
 * 数据源 = listPendingSignals（台账 pendingClause 同一真相源）：
 * - busyQueue 排队中的信号不写账 → 仍是 pending → 天然计入预告（无需查路由器内存态）
 * - 本轮触发信号已 recordStart 写 in_progress → NOT EXISTS 天然排除（不算"待消化"）
 * - HALT 在列时特别注明（停机请求优先处理）
 * - 措辞纪律（#695 裁决）：只说「待消化」，不说「正在忙」/队列位置
 * - 台账未注入/查询失败 → 无预告（纯增强，零侵入）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import { SqliteDispatchAttemptRepo } from "@frameworks/db/conversation/sqlite-dispatch-attempt-repo";
import { QueryMessage } from "@usecases/conversation/query-message";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { QueryOtter } from "@usecases/otter/query-otter";
import type { Conversation, Turn } from "@entities/conversation/conversation";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";

describe("K2 收件箱预告（真实台账 × 真实投影）", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;
  let attemptRepo: SqliteDispatchAttemptRepo;
  let engine: DispatchChainEngine;
  let engineNoLedger: DispatchChainEngine;
  let turnSeq = 0;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
    attemptRepo = new SqliteDispatchAttemptRepo(db);
    const queryMessage = new QueryMessage(repo);
    // QueryOtter 用轻量替代（getById 从 otters 表读真实行）
    const otterRepo = {
      getOtterById: (id: string) => {
        const row = db.prepare("SELECT * FROM otters WHERE id = ?").get(id) as Record<string, unknown> | undefined;
        if (!row) return null;
        return { id: row.id, name: row.name, type: row.type, status: row.status, role: null, parentOtterId: null, createdAt: "", dissolvedAt: null };
      },
    };
    const qo = { getById: (id: string) => otterRepo.getOtterById(id) } as unknown as QueryOtter;
    const logger = createTestLogger();
    const deps = {
      conversationRepo: repo, queryMessage, queryOtter: qo, logger,
      dispatchAttemptRepo: attemptRepo,
    };
    engine = new DispatchChainEngine(deps);
    engineNoLedger = new DispatchChainEngine({ ...deps, dispatchAttemptRepo: undefined });
    turnSeq = 0;

    const conv: Conversation = { id: "conv-1", title: "t", status: "active", summary: null, pinned: false, workspaceDir: null, createdAt: "", updatedAt: "", completedAt: null, archivedAt: null };
    db.prepare(`INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', 't', 'active', datetime('now'), datetime('now'))`).run();
    void conv;
    db.prepare(`INSERT INTO otters (id, name, type, status, created_at) VALUES ('otter-a', '小獭A', 'small', 'active', datetime('now'))`).run();
  });

  afterEach(() => { db.close(); });

  /** 建一条 completed 信号消息（走真实写路径） */
  async function signal(tsp: string[], level: string | null = null): Promise<string> {
    turnSeq += 1;
    const turn: Turn = { id: `turn-${turnSeq}`, conversationId: "conv-1", turnNumber: turnSeq, status: "open", createdAt: "", closedAt: null };
    await repo.createTurn(turn);
    const id = `msg-${turnSeq}`;
    await repo.createStreamingMessage({
      id, conversationId: "conv-1", turnId: turn.id, senderType: "user", senderId: "user",
      status: "streaming", talkingStonePassedTo: null, segments: [], sequenceNum: turnSeq,
      contextTokens: null, contextTokensMax: null, source: "web", metadata: null, senderName: "",
      createdAt: new Date().toISOString(), completedAt: null, signalLevel: null, signalMeta: null,
    });
    await repo.startSpeaking(id, "任务", tsp, level, null);
    await repo.completeMessage({ messageId: id, talkingStonePassedTo: tsp, completedAt: new Date().toISOString() });
    return id;
  }

  it("本獭有 N 条 pending（含排队不写账的）→ 注入预告行；本轮信号不计入", async () => {
    await signal(["otter-a"]); // msg-1：pending（无账）
    const currentMsg = await signal(["otter-a"]); // msg-2：本轮任务
    attemptRepo.recordStart({ id: "a1", conversationId: "conv-1", messageId: currentMsg, targetOtterId: "otter-a", status: "in_progress", source: "router", attemptStartedAt: new Date().toISOString(), note: null });

    const result = await engine.buildMessageWithContext("conv-1", "otter-a", "当前任务", "user", "名册");
    expect(result).toContain("收件箱预告：你名下还有 1 条信号待消化");
    expect(result).not.toContain("2 条"); // 本轮 msg-2 已记账，不算待消化
  });

  it("HALT 在列时特别注明优先处理", async () => {
    await signal(["otter-a"], "HALT");
    const result = await engine.buildMessageWithContext("conv-1", "otter-a", "当前任务", "user", "名册");
    expect(result).toContain("1 条信号待消化");
    expect(result).toContain("HALT 停机请求，优先处理");
  });

  it("无 pending → 无预告行（不注入空预告）", async () => {
    const currentMsg = await signal(["otter-a"]);
    attemptRepo.recordStart({ id: "a1", conversationId: "conv-1", messageId: currentMsg, targetOtterId: "otter-a", status: "in_progress", source: "router", attemptStartedAt: new Date().toISOString(), note: null });

    const result = await engine.buildMessageWithContext("conv-1", "otter-a", "当前任务", "user", "名册");
    expect(result).not.toContain("收件箱预告");
  });

  it("pending 超 50 条时预告数字仍准确（#757 审视焦点 1：count 无 limit，不封顶）", async () => {
    // 灌 55 条 pending（> 旧实现 listPendingSignals(limit=50) 的全局上界）
    for (let i = 0; i < 55; i++) {
      await signal(["otter-a"]);
    }
    const result = await engine.buildMessageWithContext("conv-1", "otter-a", "当前任务", "user", "名册");
    expect(result).toContain("55 条信号待消化");
  });

  it("台账未注入 → 无预告（降级零侵入）", async () => {
    await signal(["otter-a"]);
    const result = await engineNoLedger.buildMessageWithContext("conv-1", "otter-a", "当前任务", "user", "名册");
    expect(result).not.toContain("收件箱预告");
  });

  it("措辞纪律：预告不含「正在忙」/队列位置", async () => {
    await signal(["otter-a"]);
    await signal(["otter-a"]);
    const result = await engine.buildMessageWithContext("conv-1", "otter-a", "当前任务", "user", "名册");
    expect(result).toContain("2 条信号待消化");
    expect(result).not.toContain("正在忙");
    expect(result).not.toContain("第 1 位");
  });
});
