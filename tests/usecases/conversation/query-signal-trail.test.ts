/**
 * QuerySignalTrail 单元测试（真 sqlite，F20260902u5tr）。
 * 三态判定 + 信号判据边界 + 游标缺省降级，全部对真 DB 断言。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { QuerySignalTrail } from "@usecases/conversation/query-signal-trail";
import { QueryMessage } from "@usecases/conversation/query-message";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
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

describe("QuerySignalTrail（真 sqlite）", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;
  let otterRepo: SqliteOtterRepository;
  let trail: QuerySignalTrail;
  let turnSeq = 0;

  beforeEach(async () => {
    turnSeq = 0; // 每用例独立编号（跨用例残留会让 turnNumber 与游标比较漂移）
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
    otterRepo = new SqliteOtterRepository(db);
    trail = new QuerySignalTrail({
      conversationRepo: repo,
      queryMessage: new QueryMessage(repo),
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
   *  createdAt 可选：CONSUMING 判定依赖「目标最新消息是否在 5min 窗口内」，
   *  需要可控的时间戳（默认固定值必落在窗口外）。 */
  async function signal(opts: {
    from?: "user" | "otter";
    fromId?: string;
    tsp: string[];
    level?: string | null;
    status?: "completed" | "streaming";
    createdAt?: string;
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
      createdAt: opts.createdAt ?? "2026-01-01T00:00:00Z",
      completedAt: null,
      signalLevel: null,
      signalMeta: null,
    });
    if ((opts.status ?? "completed") === "completed") {
      // 生产时序：streaming（干活）→ startSpeaking（yield 设路由，落 tsp/level）→ completed。
      // streaming 占位不调 startSpeaking——生产中 startSpeaking 只在 yield 时发生，
      // 提前调用会把消息推入 speaking 态，失真（CONSUMING 判据只认 streaming）。
      await repo.startSpeaking(id, "hi", opts.tsp, opts.level ?? null, null);
      await repo.completeMessage({ messageId: id, talkingStonePassedTo: opts.tsp, completedAt: "2026-01-01T00:00:01Z" });
    }
    return id;
  }

  it("PENDING：游标未越过信号 turn", async () => {
    await joinParticipant("otter-a", 0);
    await signal({ tsp: ["otter-a"] });

    const { items } = await trail.list("conv-1");
    expect(items).toHaveLength(1);
    expect(items[0].state).toBe("PENDING");
    expect(items[0].targetOtterId).toBe("otter-a");
    expect(items[0].level).toBe("NORMAL"); // 用户消息无列值 → 归一 NORMAL
    expect(items[0].fromType).toBe("user");
  });

  it("CONSUMED：游标已越过信号 turn", async () => {
    await joinParticipant("otter-a", 0);
    await signal({ tsp: ["otter-a"] }); // turn 1
    await repo.updateLastReadTurnNumber("conv-1", "otter-a", 2); // 回应 turn

    const { items } = await trail.list("conv-1");
    expect(items[0].state).toBe("CONSUMED");
  });

  it("URGENT 档位透出 + 同信号多目标展开为多项", async () => {
    await joinParticipant("otter-a", 0);
    await joinParticipant("otter-b", 0);
    await signal({ from: "otter", fromId: "otter-b", tsp: ["otter-a", "user"], level: "URGENT" });

    const { items } = await trail.list("conv-1");
    // user 目标被排除，仅 otter-a 一项
    expect(items).toHaveLength(1);
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

  it("游标缺省（无参与者行）降级 PENDING，不假证已读", async () => {
    await signal({ tsp: ["otter-a"] }); // otter-a 未 join
    const { items } = await trail.list("conv-1");
    expect(items[0].state).toBe("PENDING");
  });

  it("CONSUMED 优先于 CONSUMING：目标 streaming 期间已消费信号 A 不被遮蔽（#696 审视发现 1）", async () => {
    await joinParticipant("otter-a", 0);
    await signal({ tsp: ["otter-a"] }); // 信号 A，turn 1
    await signal({ tsp: ["otter-a"] }); // 信号 B，turn 2
    await repo.updateLastReadTurnNumber("conv-1", "otter-a", 2); // 游标越过 A
    // 目标獭正在处理（streaming、5min 窗口内）
    await signal({
      from: "otter", fromId: "otter-a", tsp: [], status: "streaming",
      createdAt: new Date().toISOString(),
    });

    const { items } = await trail.list("conv-1");
    const stateOf = (seq: number) => items.find(i => i.seq === seq)?.state;
    // 修复前：streaming 判定先行 → 已消费的 A 也显示 CONSUMING（说谎）；修复后逐信号精确
    expect(stateOf(1)).toBe("CONSUMED");
  });

  it("CONSUMING：信号未消费 + 目标最新消息 streaming 在窗口内", async () => {
    await joinParticipant("otter-a", 0);
    await signal({ tsp: ["otter-a"] }); // turn 1，游标 0 未消费（路由器已点火、链尾 markBatchRead 未跑的真实窗口）
    await signal({
      from: "otter", fromId: "otter-a", tsp: [], status: "streaming",
      createdAt: new Date().toISOString(),
    });

    const { items } = await trail.list("conv-1");
    expect(items).toHaveLength(1);
    expect(items[0].state).toBe("CONSUMING");
  });

  it("streaming 超出 5min 窗口 → 不判 CONSUMING，降级 PENDING", async () => {
    await joinParticipant("otter-a", 0);
    await signal({ tsp: ["otter-a"] });
    await signal({
      from: "otter", fromId: "otter-a", tsp: [], status: "streaming",
      // 11 分钟前：超过 ACTIVE_WINDOW_MS(5min)，reconcile 前的遗留 streaming 占位
      createdAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    });

    const { items } = await trail.list("conv-1");
    expect(items[0].state).toBe("PENDING");
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
