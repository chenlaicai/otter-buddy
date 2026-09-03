/**
 * F20260902sgp2 S2.2：R5 生命周期回放判据——目标「未出生 → 出生 → 死亡」全链。
 *
 * 事故形态复刻（F20260903damp 09-03）：
 *   09-02 22:07 消息 yield 给尚不存在的獭（此刻非 pending，链跳过且不写账）
 *   09-02 22:15 獭被创建 → 消息追溯地变为 pending（EXISTS 通过 ∧ 无台账行）
 *   09-02 22:25 獭被 dissolve → otters 行保留 status 翻转，pending 不解除（旧判据）
 *   09-03 08:13 S2 合入重启 → 补扫点火 → 热循环 614 条
 *
 * 本组用例验证修复后的全链行为（每一步的 pending 可见性 + 点火行为）：
 *   L1 未出生：非 pending，零点火（= 事故第一步，v2 判据天然安全）
 *   L2 出生：追溯 pending（v2 语义下这是**正确**行为——獭存在且 active，
 *      点名即行动义务），补扫会点火；点火即记账 → 循环一轮即止
 *   L3 死亡（dissolve）：pending 消失（判据 SQL 排除），零点火；
 *      已有 attempt 行的（L2 已消费）同样保持非 pending
 *   L4 未解析点名（目标从未存在过）→ 恒非 pending，等价 L1
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteDispatchAttemptRepo } from "@frameworks/db/conversation/sqlite-dispatch-attempt-repo";
import { SignalRouter } from "@usecases/conversation/signal-router";
import type { Message } from "@entities/conversation/message";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import { createTestLogger } from "../../helpers/logger";

describe("S2.2 R5 生命周期全链：未出生 → 出生 → 死亡（F20260902sgp2）", () => {
  let db: Database.Database;
  let repo: SqliteDispatchAttemptRepo;
  let executeChain: ReturnType<typeof vi.fn>;
  let router: SignalRouter;
  const TARGET = "otter-swift";

  function seedSignal(id: string): void {
    db.prepare(`INSERT OR IGNORE INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', 't', 'active', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z')`).run();
    db.prepare(`INSERT OR IGNORE INTO turns (id, conversation_id, turn_number, created_at) VALUES ('turn-1', 'conv-1', 1, '2026-09-02T00:00:00Z')`).run();
    db.prepare(`INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, created_at, completed_at)
      VALUES (?, 'conv-1', 'otter', 'e448bb04-big', 'completed', 1, 'turn-1', ?, '2026-09-02T22:07:00Z', '2026-09-02T22:07:01Z')`)
      .run(id, JSON.stringify([TARGET]));
  }

  function birthTarget(): void {
    // otter 行诞生（复刻 09-02 22:15 检视獭-Swift 创建）
    db.prepare(`INSERT OR IGNORE INTO otters (id, name, type, status, created_at) VALUES (?, '检视獭-Swift', 'small', 'active', '2026-09-02T22:15:00Z')`).run(TARGET);
  }

  function dissolveTarget(): void {
    db.prepare(`UPDATE otters SET status = 'dissolved', dissolved_at = '2026-09-02T22:25:00Z' WHERE id = ?`).run(TARGET);
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
          const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Record<string, unknown> | undefined;
          if (!row) return null;
          return {
            id: row.id, conversationId: row.conversation_id, turnId: row.turn_id,
            senderId: row.sender_id, senderType: row.sender_type, status: row.status,
            segments: [{ id: "seg", messageId: row.id as string, body: "x", sequenceNum: 0, createdAt: "" }],
            sequenceNum: 1, talkingStonePassedTo: JSON.parse((row.talking_stone_passed_to as string) ?? "[]"),
            contextTokens: null, contextTokensMax: null, source: "web", senderName: "",
            createdAt: row.created_at, completedAt: row.completed_at, signalLevel: null, signalMeta: null,
          } as unknown as Message;
        }),
        getLastMessageBySender: vi.fn().mockResolvedValue(null),
      } as unknown as QueryMessage,
      queryOtter: {
        getById: vi.fn().mockImplementation(async (id: string) => {
          const row = db.prepare("SELECT id, name, type, status FROM otters WHERE id = ?").get(id);
          return row ?? null;
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

  it("L1 未出生：点名不存在的獭 → 非 pending，路由零点火（事故第一步天然安全）", async () => {
    seedSignal("msg-l1");
    expect(repo.countPendingSignals("conv-1")).toBe(0);
    await router.routeAllPending();
    await new Promise(r => setTimeout(r, 80));
    expect(executeChain).not.toHaveBeenCalled();
  });

  it("L2 出生：追溯 pending 是 v2 正确语义（獭存在且 active）→ 补扫点火一轮即止", async () => {
    seedSignal("msg-l2");
    birthTarget();
    // 追溯 pending：点名时不存在、现在存在——v2 判这个是合法欠账（行动人已在岗）
    expect(repo.countPendingSignals("conv-1")).toBe(1);
    await router.routeAllPending();
    await new Promise(r => setTimeout(r, 160)); // 跨 2+ 去抖周期
    // 点火即记账 → 循环一轮即止（对照 09-03 事故：此处曾永燃）
    expect(executeChain.mock.calls).toHaveLength(1);
    expect(repo.countPendingSignals("conv-1")).toBe(0);
  });

  it("L3 死亡：dissolve 后 pending 消失、零点火；已消费的历史保持非 pending", async () => {
    seedSignal("msg-l3a"); // L2 场景：出生 → 点火消费
    birthTarget();
    await router.routeAllPending();
    await new Promise(r => setTimeout(r, 80));
    expect(executeChain.mock.calls).toHaveLength(1);

    seedSignal("msg-l3b"); // 另一条同目标信号（未消费）
    expect(repo.countPendingSignals("conv-1")).toBe(1);

    dissolveTarget(); // 死亡
    expect(repo.countPendingSignals("conv-1")).toBe(0); // 判据排除
    await router.routeAllPending();
    await new Promise(r => setTimeout(r, 80));
    expect(executeChain.mock.calls).toHaveLength(1); // 零新增点火（l3b 不点，l3a 不重燃）
  });

  it("L4 全链顺序回放：未出生 → 出生 → 点火消费 → 死亡，pending 计数轨迹 0→1→0→0", async () => {
    seedSignal("msg-l4");
    // L1
    expect(repo.countPendingSignals("conv-1")).toBe(0);
    // L2 出生
    birthTarget();
    expect(repo.countPendingSignals("conv-1")).toBe(1);
    // 消费（路由器点火，链记账由路由器预写承担）
    await router.routeAllPending();
    await new Promise(r => setTimeout(r, 80));
    expect(repo.countPendingSignals("conv-1")).toBe(0);
    // L3 死亡
    dissolveTarget();
    expect(repo.countPendingSignals("conv-1")).toBe(0);
    // 终态验证：唯一一次点火，无循环
    expect(executeChain.mock.calls).toHaveLength(1);
  });
});
