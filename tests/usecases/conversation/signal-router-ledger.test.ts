/**
 * F20260902sgp2 S2：路由器重挂的回放判据集成测试（真实仓储 × 真路由器，禁 mock 判据路径）。
 *
 * R1 崩溃窗口：真 pending（无 attempt 记录）→ routeAllPending 点火
 * R2 多獭稳态：墓碑/记账覆盖的历史 → 零误点（不会重演 rbsg 126-invoke）
 * R3 failed 翻篇：有终态记录的信号 → 不再点火（债务不永存）
 * R4 目标生命周期（F20260903damp，09-03 事故回放）：dissolved 目标不 pending 不点火；
 *    路由器点火即记账（链失败/抛错均落终态）→ 失败不重燃（热循环免疫）
 *
 * 判据 SQL 全部走 SqliteDispatchAttemptRepo 真实实现（rbsg 教训：mock 与真实投影
 * 的分歧两次酿祸）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initSchema } from "@frameworks/db/schema";
import { SqliteDispatchAttemptRepo } from "@frameworks/db/conversation/sqlite-dispatch-attempt-repo";
import { SignalRouter } from "@usecases/conversation/signal-router";
import type { Message } from "@entities/conversation/message";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import { createTestLogger } from "../../helpers/logger";
import Database from "better-sqlite3";

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: "sig-1", conversationId: "conv-1", turnId: "turn-1", senderId: "user",
    senderType: "user", status: "completed",
    segments: [{ id: "seg-1", messageId: "sig-1", body: "do it", sequenceNum: 0, createdAt: "" }],
    sequenceNum: 10,
    talkingStonePassedTo: ["otter-1"], contextTokens: null, contextTokensMax: null,
    source: "web", senderName: "", createdAt: "2026-09-02T09:00:00Z", completedAt: "2026-09-02T09:00:01Z",
    signalLevel: null, signalMeta: null,
    ...overrides,
  };
}

describe("SignalRouter × 真实台账（S2 回放判据）", () => {
  let db: Database.Database;
  let repo: SqliteDispatchAttemptRepo;
  let executeChain: ReturnType<typeof vi.fn>;
  let router: SignalRouter;

  function seedMsg(m: Partial<Message> & { id: string }): void {
    db.prepare(`INSERT OR IGNORE INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', 't', 'active', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z')`).run();
    db.prepare(`INSERT OR IGNORE INTO turns (id, conversation_id, turn_number, created_at) VALUES ('turn-1', 'conv-1', 1, '2026-09-02T00:00:00Z')`).run();
    db.prepare(`INSERT OR IGNORE INTO otters (id, name, type, created_at) VALUES ('otter-1', '大獭', 'big', '2026-09-02T00:00:00Z')`).run();
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, created_at, completed_at)
      VALUES (?, 'conv-1', ?, ?, 'completed', 1, 'turn-1', ?, ?, ?)
    `).run(m.id, m.senderType ?? "user", m.senderId ?? "user", JSON.stringify(m.talkingStonePassedTo ?? ["otter-1"]), m.createdAt ?? "2026-09-02T09:00:00Z", "2026-09-02T09:00:01Z");
  }

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    repo = new SqliteDispatchAttemptRepo(db);
    executeChain = vi.fn().mockResolvedValue({});
    router = new SignalRouter({
      conversationRepo: { getAllIds: vi.fn().mockResolvedValue(["conv-1"]) } as unknown as ConversationRepository,
      queryMessage: {
        getMessageById: vi.fn().mockImplementation((id: string) => {
          const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as { id: string; conversation_id: string; sender_type: string; sender_id: string; talking_stone_passed_to: string | null; signal_level: string | null; created_at: string } | undefined;
          if (!row) return null;
          return makeMsg({
            id: row.id, conversationId: row.conversation_id,
            senderType: row.sender_type as Message["senderType"], senderId: row.sender_id,
            talkingStonePassedTo: row.talking_stone_passed_to ? JSON.parse(row.talking_stone_passed_to) : [],
            signalLevel: row.signal_level, createdAt: row.created_at,
          });
        }),
        getLastMessageBySender: vi.fn().mockResolvedValue(null),
      } as unknown as QueryMessage,
      queryOtter: {
        // F20260903damp：读真实 otters 表（含 status）——R4 用例需要 dissolved 行
        getById: vi.fn().mockImplementation(async (id: string) => {
          const row = db.prepare("SELECT id, name, type, status, role_name, role_responsibilities, parent_otter_id, created_at, dissolved_at FROM otters WHERE id = ?").get(id) as Record<string, unknown> | undefined;
          if (!row) return null;
          return {
            id: row.id, name: row.name, type: row.type, status: row.status,
            role: null, parentOtterId: row.parent_otter_id, createdAt: row.created_at, dissolvedAt: row.dissolved_at,
          };
        }),
      } as unknown as QueryOtter,
      dispatchChainEngine: { executeChain } as unknown as DispatchChainEngine,
      invokeFn: vi.fn().mockResolvedValue({ messageId: "m-out" }),
      logger: createTestLogger(),
      dispatchAttemptRepo: repo,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("R1 崩溃窗口：真 pending（无记录）被 routeAllPending 点火", async () => {
    seedMsg({ id: "msg-r1" });
    expect(repo.countPendingSignals("conv-1")).toBe(1);
    await router.routeAllPending();
    await new Promise(r => setTimeout(r, 20));
    expect(executeChain.mock.calls).toHaveLength(1);
  });

  it("R2 多獭稳态：墓碑覆盖的历史零误点（rbsg 126-invoke 免疫验证）", async () => {
    // 历史积压：10 条消息点名 otter-1（多獭会话稳态滞后的缩影）
    for (let i = 0; i < 10; i++) {
      seedMsg({ id: `msg-old-${i}`, createdAt: `2026-09-01T0${i}:00:00Z` });
    }
    // S1 切换时的墓碑（带一次性守卫，真实行为）
    const n = repo.backfillLegacyAttempted();
    expect(n).toBe(10);
    expect(repo.countPendingSignals("conv-1")).toBe(0);
    await router.routeAllPending();
    await new Promise(r => setTimeout(r, 20));
    expect(executeChain).not.toHaveBeenCalled(); // 零点火——不重演 126-invoke
  });

  it("R3 failed 翻篇：有终态记录的信号不再点火", async () => {
    seedMsg({ id: "msg-r3" });
    repo.recordStart({ id: "a1", conversationId: "conv-1", messageId: "msg-r3", targetOtterId: "otter-1", status: "in_progress", source: "chain", attemptStartedAt: "2026-09-02T09:00:02Z", note: null });
    repo.recordFinish("msg-r3", "otter-1", "failed", "tool timeout");
    expect(repo.countPendingSignals("conv-1")).toBe(0);
    await router.routeAllPending();
    await new Promise(r => setTimeout(r, 20));
    expect(executeChain).not.toHaveBeenCalled();
  });

  it("派发后销账：同一信号二次路由不重复点火（幂等闭环）", async () => {
    seedMsg({ id: "msg-idem" });
    // 第一次路由点火（fire-and-forget 链内由真实链引擎写账——此处模拟链引擎行为：
    // executeChain 被调即产生派发 → 按插桩契约 recordStart）
    await router.routeAllPending();
    await new Promise(r => setTimeout(r, 20));
    repo.recordStart({ id: "a1", conversationId: "conv-1", messageId: "msg-idem", targetOtterId: "otter-1", status: "in_progress", source: "chain", attemptStartedAt: "2026-09-02T09:00:02Z", note: null });
    repo.recordFinish("msg-idem", "otter-1", "completed");
    // 第二次路由：台账已有记录 → 零点火
    await router.routeAllPending();
    await new Promise(r => setTimeout(r, 20));
    expect(executeChain.mock.calls).toHaveLength(1);
  });

  // ---- R4：目标生命周期 × 点火即记账（F20260903damp，09-03 事故回放）----

  it("R4a dissolved 目标：pending 判据排除 + 路由零点火（09-03 事故直接形态）", async () => {
    seedMsg({ id: "msg-r4a" });
    // 目标 dissolved：otters 行保留、status 翻转（复刻检视獭-Swift 6b1042ae 现场）
    db.prepare("UPDATE otters SET status = 'dissolved', dissolved_at = '2026-09-02T14:25:50Z' WHERE id = 'otter-1'").run();
    // 事故判据复刻：EXISTS(otters) 不看 status 时该信号曾被视为 pending
    expect(repo.countPendingSignals("conv-1")).toBe(0);
    await router.routeAllPending();
    await new Promise(r => setTimeout(r, 80)); // 含 50ms 去抖重扫窗口
    expect(executeChain).not.toHaveBeenCalled();
  });

  it("R4b 点火即记账（失败路径）：链抛错 → attempt 落 failed 终态 → 重扫不重燃（热循环免疫）", async () => {
    seedMsg({ id: "msg-r4b" });
    executeChain.mockRejectedValue(new Error("No session or config found for otter: otter-1"));
    await router.routeAllPending();
    // 越过 50ms 去抖重扫 ×2 个周期——旧 bug 下此处已循环点火多次
    await new Promise(r => setTimeout(r, 160));
    const attempts = repo.listAttemptsForConversation("conv-1");
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("failed");
    expect(attempts[0].messageId).toBe("msg-r4b");
    // 热循环判据：失败终态后再无点火（旧 bug：50ms 一次永燃，160ms ≥ 2 轮）
    expect(executeChain.mock.calls).toHaveLength(1);
    expect(repo.countPendingSignals("conv-1")).toBe(0);
  });

  it("R4c 点火即记账（链不记账的成功路径）：路由器预写 in_progress → pending 即刻清零", async () => {
    seedMsg({ id: "msg-r4c" });
    // 隔离路由器职责：链引擎 mock 成功但不写账（真实链会 INSERT OR REPLACE 覆盖同键）
    executeChain.mockResolvedValue({});
    await router.routeAllPending();
    await new Promise(r => setTimeout(r, 20));
    const attempts = repo.listAttemptsForConversation("conv-1");
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("in_progress");
    expect(repo.countPendingSignals("conv-1")).toBe(0);
    // 二次路由：账面有行 → 零点火（幂等）
    await router.routeAllPending();
    await new Promise(r => setTimeout(r, 20));
    expect(executeChain.mock.calls).toHaveLength(1);
  });

  it("R4d triggerMessageId 透传：点火时把信号消息 ID 交给链引擎（hop-1 记账 + hop-2+ 出处链）", async () => {
    seedMsg({ id: "msg-r4d" });
    await router.routeAllPending();
    await new Promise(r => setTimeout(r, 20));
    expect(executeChain.mock.calls[0][0].triggerMessageId).toBe("msg-r4d");
  });
});
