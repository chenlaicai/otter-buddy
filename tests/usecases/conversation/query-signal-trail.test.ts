/**
 * QuerySignalTrail 单元测试（真 sqlite，F20260902u5tr → sgp2 S1b 判据切台账）。
 * 四态判定全部对真 DB 断言（rbsg 教训：禁 mock 判据路径）。
 *
 * 判据真相源 = dispatch_attempts 台账（SqliteDispatchAttemptRepo），记账走生产路径
 * recordStart/recordFinish——与链引擎插桩同一写入口，不用手写 INSERT 造账。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { QuerySignalTrail } from "@usecases/conversation/query-signal-trail";
import { QueryMessage } from "@usecases/conversation/query-message";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { SqliteDispatchAttemptRepo } from "@frameworks/db/conversation/sqlite-dispatch-attempt-repo";
import type { DispatchAttemptRepo } from "@entities/conversation/dispatch-attempt";
import type { Conversation, Turn, ConversationParticipant } from "@entities/conversation/conversation";
import type { Otter } from "@entities/otter/otter";
import { createTestDb } from "../../helpers/db";

function otterFixture(id: string, name: string): Otter {
  return {
    id, name, type: "small", status: "active",
    role: null, parentOtterId: null,
    createdAt: "2026-01-01T00:00:00Z", dissolvedAt: null,
  };
}

describe("QuerySignalTrail（真 sqlite，台账判据）", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;
  let otterRepo: SqliteOtterRepository;
  let attemptRepo: SqliteDispatchAttemptRepo;
  let trail: QuerySignalTrail;
  let turnSeq = 0;

  beforeEach(async () => {
    turnSeq = 0; // 每用例独立编号（跨用例残留会让 turnNumber 与游标比较漂移）
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
    otterRepo = new SqliteOtterRepository(db);
    attemptRepo = new SqliteDispatchAttemptRepo(db);
    trail = new QuerySignalTrail({
      conversationRepo: repo,
      queryMessage: new QueryMessage(repo),
      dispatchAttemptRepo: attemptRepo,
    });

    const conv: Conversation = {
      id: "conv-1", title: "测试对话", status: "active", summary: null, pinned: false, workspaceDir: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      completedAt: null, archivedAt: null,
    };
    await repo.create(conv);
    await otterRepo.createOtter(otterFixture("otter-a", "小獭A"));
    await otterRepo.createOtter(otterFixture("otter-b", "小獭B"));
  });

  afterEach(() => {
    db.close();
  });

  async function joinParticipant(otterId: string, lastReadTurnNumber = 0): Promise<void> {
    const p: ConversationParticipant = {
      id: `p-${otterId}`, conversationId: "conv-1", otterId,
      joinedAtTurnId: null, joinedAtTurnNumber: 0,
      leftAtTurnId: null, leftAtTurnNumber: null,
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      leftAt: null,
      lastReadTurnNumber,
      lastActiveTurnNumber: 0,
    };
    await repo.createParticipant(p);
  }

  /** 建一个 completed 消息（含 tsp / signal_level），返回消息 id。
   *  走真实写路径：createStreamingMessage → startSpeaking（落 tsp/level）→ completeMessage（终态）。
   *  （S1b 起状态判定不再依赖 streaming/游标，helper 无需时间戳控制。） */
  async function signal(opts: {
    from?: "user" | "otter";
    fromId?: string;
    tsp: string[];
    level?: string | null;
    status?: "completed" | "streaming";
  }): Promise<string> {
    turnSeq += 1;
    const turn: Turn = {
      id: `turn-${turnSeq}`, conversationId: "conv-1", turnNumber: turnSeq, status: "open",
      createdAt: "2026-01-01T00:00:00Z", closedAt: null,
    };
    await repo.createTurn(turn);
    const id = `msg-${turnSeq}`;
    const senderId = opts.fromId ?? "user";
    const senderType = opts.from ?? "user";
    await repo.createStreamingMessage({
      id,
      conversationId: "conv-1",
      turnId: turn.id,
      senderType,
      senderId,
      status: "streaming",
      talkingStonePassedTo: null,
      segments: [],
      sequenceNum: turnSeq,
      contextTokens: null,
      contextTokensMax: null,
      source: "web",
      metadata: null,
      senderName: "",
      createdAt: "2026-01-01T00:00:00Z",
      completedAt: null,
      signalLevel: null,
      signalMeta: null,
    });
    if ((opts.status ?? "completed") === "completed") {
      // 生产时序：streaming（干活）→ startSpeaking（yield 设路由，落 tsp/level）→ completed
      await repo.startSpeaking(id, "hi", opts.tsp, opts.level ?? null, null);
      await repo.completeMessage({ messageId: id, talkingStonePassedTo: opts.tsp, completedAt: "2026-01-01T00:00:01Z" });
    }
    return id;
  }

  /** 记账走生产写入口（与链引擎插桩同款），不手写 INSERT 造账 */
  function ledgerStart(messageId: string, target: string): void {
    attemptRepo.recordStart({
      id: `att-${messageId}-${target}`, conversationId: "conv-1",
      messageId, targetOtterId: target,
      status: "in_progress", source: "chain",
      attemptStartedAt: "2026-01-01T00:00:02Z", note: null,
    });
  }

  /** 展开真 repo 为接口对象（供单方法覆盖的降级注入用） */
  function attemptRepoInterface(r: SqliteDispatchAttemptRepo): DispatchAttemptRepo {
    return r;
  }

  const stateOf = (items: Array<{ seq: number; state: string; note?: string | null }>, seq: number) =>
    items.find(i => i.seq === seq);

  it("PENDING：无 attempt 记录（游标滞后不再冒充 pending——徽标痊愈的判据面）", async () => {
    await joinParticipant("otter-a", 0);
    const msgId = await signal({ tsp: ["otter-a"] });
    // 游标远远滞后（v1 下这会显示 CONSUMED 或误导性状态；v2 只看台账）
    await repo.updateLastReadTurnNumber("conv-1", "otter-a", 99);

    const { items } = await trail.list("conv-1");
    expect(items).toHaveLength(1);
    expect(items[0].state).toBe("PENDING");
    expect(items[0].targetOtterId).toBe("otter-a");
    expect(items[0].level).toBe("NORMAL"); // 用户消息无列值 → 归一 NORMAL
    expect(items[0].fromType).toBe("user");
    expect(msgId).toBeTruthy();
  });

  it("CONSUMING：attempt in_progress（持久行判定，无 5min 墙钟窗）", async () => {
    await joinParticipant("otter-a", 0);
    const msgId = await signal({ tsp: ["otter-a"] });
    ledgerStart(msgId, "otter-a");

    const { items } = await trail.list("conv-1");
    expect(items).toHaveLength(1);
    expect(items[0].state).toBe("CONSUMING");
  });

  it("CONSUMED：attempt completed（记账走 recordFinish 生产路径）", async () => {
    await joinParticipant("otter-a", 0);
    const msgId = await signal({ tsp: ["otter-a"] });
    ledgerStart(msgId, "otter-a");
    attemptRepo.recordFinish(msgId, "otter-a", "completed");

    const { items } = await trail.list("conv-1");
    expect(items[0].state).toBe("CONSUMED");
  });

  it("FAILED：attempt failed/aborted + note 透出（失败首次可见，S1b 验收③）", async () => {
    await joinParticipant("otter-a", 0);
    const msgId = await signal({ tsp: ["otter-a"] });
    ledgerStart(msgId, "otter-a");
    attemptRepo.recordFinish(msgId, "otter-a", "failed", "tool timeout");

    const { items } = await trail.list("conv-1");
    expect(items[0].state).toBe("FAILED");
    expect(items[0].note).toContain("tool timeout");
  });

  it("aborted 同归 FAILED；CONSUMED/CONSUMING 不带 note", async () => {
    await joinParticipant("otter-a");
    await joinParticipant("otter-b");
    const m1 = await signal({ tsp: ["otter-a"] });
    const m2 = await signal({ tsp: ["otter-b"] });
    ledgerStart(m1, "otter-a");
    attemptRepo.recordFinish(m1, "otter-a", "aborted", "用户中止");
    ledgerStart(m2, "otter-b");
    attemptRepo.recordFinish(m2, "otter-b", "completed");

    const { items } = await trail.list("conv-1");
    expect(stateOf(items, 1)?.state).toBe("FAILED");
    expect(stateOf(items, 1)?.note).toContain("用户中止");
    expect(stateOf(items, 2)?.state).toBe("CONSUMED");
    expect(stateOf(items, 2)?.note ?? null).toBeNull();
  });

  it("逐目标精确：同信号多目标、目标 B 处理中不影响目标 A 已消费（v1 遮蔽病的 v2 形态校验）", async () => {
    await joinParticipant("otter-a", 0);
    await joinParticipant("otter-b", 0);
    const msgId = await signal({ from: "otter", fromId: "otter-b", tsp: ["otter-a", "otter-b"], level: "URGENT" });
    ledgerStart(msgId, "otter-a");
    attemptRepo.recordFinish(msgId, "otter-a", "completed");
    ledgerStart(msgId, "otter-b"); // B 还在处理

    const { items } = await trail.list("conv-1");
    expect(items).toHaveLength(2);
    expect(items.find(i => i.targetOtterId === "otter-a")?.state).toBe("CONSUMED");
    expect(items.find(i => i.targetOtterId === "otter-b")?.state).toBe("CONSUMING");
    expect(items[0].level).toBe("URGENT");
    expect(items[0].fromType).toBe("otter");
  });

  it("非信号消息不进轨迹：system 消息 / 纯投石给 user / streaming 状态", async () => {
    await joinParticipant("otter-a", 0);
    await signal({ from: "otter", fromId: "otter-a", tsp: ["user"] }); // 投石给 user：非信号
    await signal({ tsp: ["otter-a"], status: "streaming" }); // streaming：未终态
    await signal({ from: "otter", fromId: "otter-a", tsp: ["otter-a"] });

    const { items } = await trail.list("conv-1");
    expect(items).toHaveLength(1); // 仅最后一条 self-yield（otter→otter-a）
  });

  it("repo 未注入（装配降级）→ 全部降级 PENDING，不撒谎", async () => {
    await joinParticipant("otter-a", 0);
    await signal({ tsp: ["otter-a"] });
    const degraded = new QuerySignalTrail({
      conversationRepo: repo,
      queryMessage: new QueryMessage(repo),
      // 不注入 dispatchAttemptRepo
    });
    const { items } = await degraded.list("conv-1");
    expect(items[0].state).toBe("PENDING");
  });

  it("未知 attempt status 的双层防御：schema CHECK 拦入早 + usecase 降级不留假终态", async () => {
    await joinParticipant("otter-a", 0);
    const msgId = await signal({ tsp: ["otter-a"] });
    // 第一道防线：schema CHECK 约束——非法值进不了台账（#735 审视建议 1 的前提：
    // 内部枚举扩展时先改 CHECK 再改映射，中间态不可能静默入库）
    expect(() =>
      db.prepare(`
        INSERT INTO dispatch_attempts (id, conversation_id, message_id, target_otter_id, status, source, attempt_started_at, note)
        VALUES ('att-x', 'conv-1', ?, 'otter-a', 'cancelled', 'chain', datetime('now'), 'future status')
      `).run(msgId),
    ).toThrow(/CHECK constraint failed/);

    // 第二道防线（未来 CHECK 放宽后的窗口）：usecase 对未知值降级 PENDING、
    // 不假证终态、note 不透出——降级路径行为锁死
    const degraded = new QuerySignalTrail({
      conversationRepo: repo,
      queryMessage: new QueryMessage(repo),
      dispatchAttemptRepo: {
        ...attemptRepoInterface(attemptRepo),
        listAttemptsForConversation: () => [{
          id: "att-x", conversationId: "conv-1", messageId: msgId, targetOtterId: "otter-a",
          status: "cancelled" as never, source: "chain" as never,
          attemptStartedAt: "2026-01-01T00:00:02Z", attemptFinishedAt: null, note: "future status",
        }],
      },
    });
    const { items } = await degraded.list("conv-1");
    expect(items[0].state).toBe("PENDING");
    expect(items[0].note ?? null).toBeNull();
  });

  it("按 seq 升序返回（时序展示）", async () => {
    await joinParticipant("otter-a", 0);
    await signal({ tsp: ["otter-a"] });
    await signal({ tsp: ["otter-a"] });
    const { items } = await trail.list("conv-1");
    expect(items.map(i => i.seq)).toEqual([...items.map(i => i.seq)].sort((x, y) => x - y));
    expect(items).toHaveLength(2);
  });
});
