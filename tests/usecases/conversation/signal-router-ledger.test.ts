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
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
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

describe("F20260903damp 阻尼机制（S2.1：R5 判据——失效模式落哑火侧）", () => {
  let db: import("better-sqlite3").Database;
  let repo: SqliteDispatchAttemptRepo;
  let executeChain: ReturnType<typeof vi.fn>;
  let router: SignalRouter;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    repo = new SqliteDispatchAttemptRepo(db);
    executeChain = vi.fn().mockRejectedValue(new Error("boom")); // 失败路径——阻尼的正战场
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
      queryOtter: { getById: vi.fn().mockResolvedValue({ id: "otter-1", type: "big", status: "active" }) } as unknown as QueryOtter,
      dispatchChainEngine: { executeChain } as unknown as DispatchChainEngine,
      invokeFn: vi.fn().mockResolvedValue({ messageId: "m-out" }),
      logger: createTestLogger(),
      dispatchAttemptRepo: repo,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("R5a 阻尼#1：失败后重扫零点火——failed 终态行把信号挡在 pending 之外（热循环免疫）", async () => {
    db.prepare(`INSERT OR IGNORE INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', 't', 'active', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z')`).run();
    db.prepare(`INSERT OR IGNORE INTO turns (id, conversation_id, turn_number, created_at) VALUES ('turn-1', 'conv-1', 1, '2026-09-02T00:00:00Z')`).run();
    db.prepare(`INSERT OR IGNORE INTO otters (id, name, type, status, created_at) VALUES ('otter-1', '大獭', 'big', 'active', '2026-09-02T00:00:00Z')`).run();
    db.prepare(`INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, created_at, completed_at) VALUES ('msg-damp', 'conv-1', 'user', 'user', 'completed', 1, 'turn-1', ?, '2026-09-02T09:00:00Z', '2026-09-02T09:00:01Z')`).run(JSON.stringify(["otter-1"]));

    // 首轮点火：路由器预写账（点火即记账）+ 链失败 → 路由器兜底 failed
    await router.routeAllPending();
    await new Promise(r => setTimeout(r, 60)); // 跨 1+ 个去抖周期
    const firstCalls = executeChain.mock.calls.length;
    expect(firstCalls).toBe(1);

    // 模拟链未记账的最坏情况：删掉 chain 行，只留路由器预写的行（source=router 的 in_progress → 兜底 failed）
    // 实际上 #749 后路由器兜底已落 failed——直接断言台账有 failed 行
    const failedRow = db.prepare(`SELECT status FROM dispatch_attempts WHERE message_id = 'msg-damp' AND target_otter_id = 'otter-1'`).get() as { status: string };
    expect(failedRow.status).toBe("failed");

    // 两个重扫周期后：不再点火（pending 判据排除 failed 行——失效模式落哑火侧）
    await router.routeAllPending();
    await router.routeAllPending();
    await new Promise(r => setTimeout(r, 120));
    expect(executeChain.mock.calls.length).toBe(firstCalls); // 无新增点火
    expect(repo.countPendingSignals("conv-1")).toBe(0);
  });

  it("R5b 阻尼#1：shouldThrottle 最小点火间隔——60s 内二次点火被拒", () => {
    db.prepare(`INSERT OR IGNORE INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', 't', 'active', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z')`).run();
    db.prepare(`INSERT OR IGNORE INTO turns (id, conversation_id, turn_number, created_at) VALUES ('turn-1', 'conv-1', 1, '2026-09-02T00:00:00Z')`).run();
    db.prepare(`INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, created_at, completed_at) VALUES ('msg-t', 'conv-1', 'user', 'user', 'completed', 1, 'turn-1', '["otter-1"]', '2026-09-02T09:00:00Z', '2026-09-02T09:00:01Z')`).run();
    db.prepare(`INSERT OR IGNORE INTO otters (id, name, type, status, created_at) VALUES ('otter-1', '大獭', 'big', 'active', '2026-09-02T00:00:00Z')`).run();
    // 无记录 = 首次，不阻尼
    expect(repo.shouldThrottle("msg-t", "otter-1", 60)).toBe(false);
    // 记账后 60s 内 = 阻尼
    repo.recordStart({ id: "a1", conversationId: "conv-1", messageId: "msg-t", targetOtterId: "otter-1", status: "in_progress", source: "router", attemptStartedAt: new Date().toISOString(), note: null });
    expect(repo.shouldThrottle("msg-t", "otter-1", 60)).toBe(true);
    // 间隔外 = 放行
    const past = new Date(Date.now() - 61_000).toISOString();
    db.prepare(`UPDATE dispatch_attempts SET attempt_started_at = ? WHERE id = 'a1'`).run(past);
    expect(repo.shouldThrottle("msg-t", "otter-1", 60)).toBe(false);
    // 脏时间戳 = 不阻尼（宁多勿错）
    db.prepare(`UPDATE dispatch_attempts SET attempt_started_at = 'garbage' WHERE id = 'a1'`).run();
    expect(repo.shouldThrottle("msg-t", "otter-1", 60)).toBe(false);
  });

  it("R5c 阻尼#2：失败不重复落用户可见消息（写放大上界由消息层聚合）——同信号重试只产一条 failed 消息", async () => {
    // 验证点：#749 后 failed 消息由 orchestrator 落，路由器兜底只写台账。
    // 本用例锁定：同一 (message,target) 反复点火失败（模拟），台账 failed 行只有一条（覆盖式）
    db.prepare(`INSERT OR IGNORE INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', 't', 'active', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z')`).run();
    db.prepare(`INSERT OR IGNORE INTO turns (id, conversation_id, turn_number, created_at) VALUES ('turn-1', 'conv-1', 1, '2026-09-02T00:00:00Z')`).run();
    db.prepare(`INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, created_at, completed_at) VALUES ('msg-dup', 'conv-1', 'user', 'user', 'completed', 1, 'turn-1', '["otter-1"]', '2026-09-02T09:00:00Z', '2026-09-02T09:00:01Z')`).run();
    db.prepare(`INSERT OR IGNORE INTO otters (id, name, type, status, created_at) VALUES ('otter-1', '大獭', 'big', 'active', '2026-09-02T00:00:00Z')`).run();
    repo.recordStart({ id: "a1", conversationId: "conv-1", messageId: "msg-dup", targetOtterId: "otter-1", status: "in_progress", source: "router", attemptStartedAt: "2026-09-02T09:00:02Z", note: null });
    repo.recordFinish("msg-dup", "otter-1", "failed", "boom 1");
    // 二次「重试」（覆盖式 INSERT OR REPLACE）
    repo.recordStart({ id: "a2", conversationId: "conv-1", messageId: "msg-dup", targetOtterId: "otter-1", status: "in_progress", source: "retry", attemptStartedAt: "2026-09-02T09:05:00Z", note: "retry; prev=failed: boom 1" });
    repo.recordFinish("msg-dup", "otter-1", "failed", "boom 2");
    const rows = db.prepare(`SELECT id FROM dispatch_attempts WHERE message_id = 'msg-dup'`).all();
    expect(rows).toHaveLength(1); // UNIQUE 槽位覆盖，不膨胀
    // recordStart 时已压缩前情（retry note 含 prev=failed），recordFinish 以本轮原因覆盖 note
    // ——本轮失败原因可查（排查线索），历史轮次经覆盖时已被压缩进上一轮 note 链
    const row = db.prepare(`SELECT note FROM dispatch_attempts WHERE message_id = 'msg-dup'`).get() as { note: string };
    expect(row.note).toBe("boom 2");
  });
});

// ---- F20260903ihlt：用户停机 × 限流熔断（09-03 12:45 Self-Healing 事故回放）----
// 事故形态：429 风暴中一只接一只獭被逐个点火撞墙；用户点「中断」后 50ms 去抖重扫
// 继续弹出下一只 pending 獭（中断 a 弹出 b）。判据：中断 = 会话级停机冻结一切点火；
// rate_limit healing 事件窗口内整会话拒点火——两者信号都保留（pending 不动），哑火侧失效。

describe("F20260903ihlt 用户停机 × 限流熔断", () => {
  let db: import("better-sqlite3").Database;
  let repo: SqliteDispatchAttemptRepo;
  let executeChain: ReturnType<typeof vi.fn>;
  let router: SignalRouter;
  let healingEvents: Array<Record<string, unknown>>;

  function seedConvAndSignal(): void {
    db.prepare(`INSERT OR IGNORE INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', 't', 'active', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z')`).run();
    db.prepare(`INSERT OR IGNORE INTO turns (id, conversation_id, turn_number, created_at) VALUES ('turn-1', 'conv-1', 1, '2026-09-02T00:00:00Z')`).run();
    db.prepare(`INSERT OR IGNORE INTO otters (id, name, type, status, created_at) VALUES ('otter-1', '大獭', 'big', 'active', '2026-09-02T00:00:00Z')`).run();
    db.prepare(`INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, created_at, completed_at) VALUES ('msg-h', 'conv-1', 'user', 'user', 'completed', 1, 'turn-1', '["otter-1"]', '2026-09-02T09:00:00Z', '2026-09-02T09:00:01Z')`).run();
  }

  function makeRouter(withHealing: boolean): SignalRouter {
    return new SignalRouter({
      conversationRepo: { getAllIds: vi.fn().mockResolvedValue(["conv-1"]) } as unknown as ConversationRepository,
      queryMessage: {
        getMessageById: vi.fn().mockImplementation((id: string) => {
          const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Record<string, unknown> | undefined;
          if (!row) return null;
          return makeMsg({
            id: row.id as string,
            conversationId: row.conversation_id as string,
            senderType: row.sender_type as Message["senderType"],
            senderId: row.sender_id as string,
            talkingStonePassedTo: row.talking_stone_passed_to ? JSON.parse(row.talking_stone_passed_to as string) : [],
            signalLevel: (row.signal_level as string | null) ?? null,
            createdAt: row.created_at as string,
          });
        }),
        getLastMessageBySender: vi.fn().mockResolvedValue(null),
      } as unknown as QueryMessage,
      queryOtter: { getById: vi.fn().mockResolvedValue({ id: "otter-1", type: "big", status: "active" }) } as unknown as QueryOtter,
      dispatchChainEngine: { executeChain } as unknown as DispatchChainEngine,
      invokeFn: vi.fn().mockResolvedValue({ messageId: "m-out" }),
      logger: createTestLogger(),
      dispatchAttemptRepo: repo,
      ...(withHealing && {
        healingRepo: {
          findByConversation: vi.fn().mockImplementation(async () => healingEvents),
        } as unknown as HealingEventRepository,
      }),
    });
  }

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    repo = new SqliteDispatchAttemptRepo(db);
    executeChain = vi.fn().mockResolvedValue({});
    healingEvents = [];
    router = makeRouter(true);
  });

  afterEach(() => {
    db.close();
  });

  it("H1 用户停机：markUserHalt 冻结点火（skipped_halted + 零 invoke + pending 保留），clearUserHalt 恢复", async () => {
    seedConvAndSignal();
    router.markUserHalt("conv-1");
    const results = await router.routePendingSignals("conv-1");
    expect(results.map(r => r.action)).toEqual(["skipped_halted"]);
    await new Promise(r => setTimeout(r, 80)); // 跨去抖周期
    expect(executeChain).not.toHaveBeenCalled();
    expect(repo.countPendingSignals("conv-1")).toBe(1); // 信号保留，不丢

    // 用户恢复（发新消息）→ 解除 → 正常点火
    router.clearUserHalt("conv-1");
    const resumed = await router.routePendingSignals("conv-1");
    expect(resumed.map(r => r.action)).toEqual(["invoked"]);
    await new Promise(r => setTimeout(r, 20));
    expect(executeChain.mock.calls).toHaveLength(1);
  });

  it("H2 中断不再弹下一只：多目标 pending 全部 skipped_halted（09-03 现场「中断 a 弹出 b」回放）", async () => {
    seedConvAndSignal();
    db.prepare(`INSERT OR IGNORE INTO otters (id, name, type, status, created_at) VALUES ('otter-2', '小獭b', 'small', 'active', '2026-09-02T00:00:00Z')`).run();
    db.prepare(`INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, created_at, completed_at) VALUES ('msg-h2', 'conv-1', 'user', 'user', 'completed', 2, 'turn-1', '["otter-2"]', '2026-09-02T09:01:00Z', '2026-09-02T09:01:01Z')`).run();
    router.markUserHalt("conv-1");
    const results = await router.routePendingSignals("conv-1");
    expect(results.every(r => r.action === "skipped_halted")).toBe(true);
    expect(results).toHaveLength(2);
    await new Promise(r => setTimeout(r, 80));
    expect(executeChain).not.toHaveBeenCalled(); // a 中断后，b 不再弹出
  });

  it("RL1 限流熔断：会话内 rate_limit 事件窗口内整会话拒点火，信号保留", async () => {
    seedConvAndSignal();
    healingEvents = [{ errorType: "rate_limit", createdAt: new Date().toISOString(), context: { exhausted: false } }];
    const results = await router.routePendingSignals("conv-1");
    expect(results.map(r => r.action)).toEqual(["skipped_rate_limited"]);
    await new Promise(r => setTimeout(r, 80));
    expect(executeChain).not.toHaveBeenCalled();
    expect(repo.countPendingSignals("conv-1")).toBe(1); // pending 保留，窗口后可恢复
  });

  it("RL2 窗口分级：transient 10min / exhausted 60min——30 分钟前的事件按 exhausted 分级判定", async () => {
    seedConvAndSignal();
    const createdAt = new Date(Date.now() - 30 * 60_000).toISOString();
    // exhausted=true：30min < 60min 窗口 → 仍熔断
    healingEvents = [{ errorType: "rate_limit", createdAt, context: { exhausted: true } }];
    const blocked = await router.routePendingSignals("conv-1");
    expect(blocked.map(r => r.action)).toEqual(["skipped_rate_limited"]);
    // exhausted=false：30min > 10min 窗口 → 放行
    healingEvents = [{ errorType: "rate_limit", createdAt, context: { exhausted: false } }];
    const allowed = await router.routePendingSignals("conv-1");
    expect(allowed.map(r => r.action)).toEqual(["invoked"]);
    await new Promise(r => setTimeout(r, 20));
    expect(executeChain.mock.calls).toHaveLength(1);
  });

  it("RL3 非 rate_limit 事件不触发熔断；healingRepo 未注入时降级为不熔断（现状等价）", async () => {
    seedConvAndSignal();
    healingEvents = [{ errorType: "tool_failure", createdAt: new Date().toISOString(), context: null }];
    const results = await router.routePendingSignals("conv-1");
    expect(results.map(r => r.action)).toEqual(["invoked"]);
    await new Promise(r => setTimeout(r, 20));
    expect(executeChain.mock.calls).toHaveLength(1);

    const noHealingRouter = makeRouter(false);
    healingEvents = [{ errorType: "rate_limit", createdAt: new Date().toISOString(), context: { exhausted: true } }];
    // 新信号（前半段的信号已记账翻篇）——无 healingRepo 时即使限流事件在场也照常点火
    db.prepare(`INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, created_at, completed_at) VALUES ('msg-h3', 'conv-1', 'user', 'user', 'completed', 3, 'turn-1', '["otter-1"]', '2026-09-02T09:02:00Z', '2026-09-02T09:02:01Z')`).run();
    const degraded = await noHealingRouter.routePendingSignals("conv-1");
    expect(degraded.map(r => r.action)).toEqual(["invoked"]); // 无台账数据源 = 无闸门（降级）
  });
});
