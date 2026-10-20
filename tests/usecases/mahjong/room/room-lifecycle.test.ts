/**
 * 牌局生命周期控制测试（#1564-5/#1564-6）：
 *  - 局终结算停驻：有真人的房暂停等「继续」；continueRound 放行进下局
 *  - 停驻超时自动继续（settleHoldMs 到期）
 *  - stopRoom 停局：进行中也可停，房间出 Map 且广播通知
 *  - 真人离桌 runaway 界：连续超时代打到限自动停局
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteFrameStore } from "../../../../src/usecases/mahjong/room/frames";
import { RoomBus, RoomService, type RoomEvent } from "../../../../src/usecases/mahjong/room/room-service";
import type { OtterGateway } from "../../../../src/usecases/mahjong/room/otter-adapter";
import type { DecisionPoint, EngineAction, GameConfig } from "../../../../src/usecases/mahjong/engine/types";

/** mock 獭：能和就和，否则第一个合法动作（与 room-service.test 同构） */
function scriptedGateway(calls: { count: number }): OtterGateway {
  return {
    async invoke(_otterId: string, prompt: string): Promise<string> {
      calls.count += 1;
      const matches = [...prompt.matchAll(/^\s*(\d+)\. (\{.*\})$/gm)];
      if (matches.length === 0) return "我无法解析局面（非 JSON 回复）";
      const actions = matches.map((m) => JSON.parse(m[2]) as EngineAction);
      const winIdx = actions.findIndex((a) => a.type === "tsumo" || a.type === "ron");
      const chosen = winIdx >= 0 ? matches[winIdx]! : matches[0]!;
      return `\`\`\`json\n{"action": ${chosen[2]}, "speech": "（獭）走这步"}\n\`\`\``;
    },
  };
}

function cfg(seed: string): GameConfig {
  return {
    seed,
    startPoints: 35000,
    players: [
      { kind: "otter", name: "A", otterId: "otter-a" },
      { kind: "human", name: "B" },
      { kind: "otter", name: "C", otterId: "otter-c" },
    ],
  };
}

describe("牌局生命周期：结算停驻 / 停局 / 离桌界（#1564-5/#1564-6）", () => {
  let db: Database.Database;
  let store: SqliteFrameStore;
  let bus: RoomBus;
  let events: RoomEvent[];

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    store = new SqliteFrameStore(db);
    bus = new RoomBus();
    events = [];
    bus.subscribe("r1", (e) => events.push(e));
  });

  afterEach(() => db.close());

  /** 驱动到第一个结算停驻点（真人位持续注入，直到局终停驻） */
  async function driveToSettlement(svc: RoomService, roomId: string): Promise<void> {
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 20000) throw new Error("drive-to-settlement guard");
      await svc.settled(roomId);
      const v = svc.view(roomId, null)!;
      if (v.awaitingHuman) {
        const dp = v.decision as DecisionPoint;
        const humanSeat = [0, 1, 2].find((s) => v.players[s]!.kind === "human")!;
        expect(svc.injectHumanAction(roomId, humanSeat as 0 | 1 | 2, dp.actions[0]!).ok).toBe(true);
        continue;
      }
      if (v.settlement && v.status === "playing") return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it("有真人的房局终结算停驻——不自动换局，continueRound 后进下局", async () => {
    const svc = new RoomService({
      store,
      gateway: scriptedGateway({ count: 0 }),
      bus,
      humanTimeoutMs: 60_000,
      humanGraceMs: 60_000,
      settleHoldMs: 60_000, // 停驻足够长：测试内不自动继续
    });
    svc.createRoom("r1", cfg("settle-pause-seed"));
    await driveToSettlement(svc, "r1");
    // 停驻实证：150ms 后仍在停驻（修复前局终瞬间自动换局）
    await new Promise((r) => setTimeout(r, 150));
    await svc.settled("r1");
    expect(svc.view("r1", null)!.settlement).toBeTruthy();
    // 「继续」→ 进下局（结算消失、状态仍 playing）
    expect(svc.continueRound("r1")).toMatchObject({ ok: true });
    await svc.settled("r1");
    const v2 = svc.view("r1", null)!;
    expect(v2.settlement).toBeFalsy();
    expect(v2.status).toBe("playing");
    // 非停驻态点继续 → 拒绝（接口幂等防护）
    expect(svc.continueRound("r1")).toMatchObject({ ok: false });
    svc.close("r1");
  });

  it("停驻超时自动继续（settleHoldMs 到期进下局，不需人点）", async () => {
    const svc = new RoomService({
      store,
      gateway: scriptedGateway({ count: 0 }),
      bus,
      humanTimeoutMs: 60_000,
      humanGraceMs: 60_000,
      settleHoldMs: 40,
    });
    svc.createRoom("r1", cfg("settle-auto-seed"));
    await driveToSettlement(svc, "r1");
    // 不点继续：等超时自动进下局
    await new Promise((r) => setTimeout(r, 250));
    await svc.settled("r1");
    const v = svc.view("r1", null)!;
    expect(v.settlement).toBeFalsy();
    expect(v.status).toBe("playing");
    svc.close("r1");
  });

  it("stopRoom 停局——进行中也可停，房间出 Map 且广播通知", async () => {
    const svc = new RoomService({
      store,
      gateway: scriptedGateway({ count: 0 }),
      bus,
      humanTimeoutMs: 60_000,
      humanGraceMs: 60_000,
    });
    svc.createRoom("r1", cfg("stop-seed-1"));
    await svc.settled("r1");
    expect(svc.view("r1", null)).not.toBeNull();
    expect(svc.stopRoom("r1")).toMatchObject({ ok: true });
    expect(svc.view("r1", null)).toBeNull();
    expect(svc.stopRoom("r1")).toMatchObject({ ok: false, reason: "room not found" });
    const notices = events.filter((e) => e.type === "error" && e.message.includes("主动停局"));
    expect(notices.length).toBe(1);
  });

  it("真人连续超时代打到限自动停局（离桌 runaway 界）", async () => {
    const svc = new RoomService({
      store,
      gateway: scriptedGateway({ count: 0 }),
      bus,
      humanTimeoutMs: 10,
      humanGraceMs: 10,
      humanIdleStrikeLimit: 2,
      settleHoldMs: 5,
    });
    // 真人坐庄：每个自家回合都超时代打，计数快速到限
    const config: GameConfig = {
      ...cfg("strike-seed-1"),
      players: [
        { kind: "human", name: "H" },
        { kind: "otter", name: "A", otterId: "otter-a" },
        { kind: "otter", name: "C", otterId: "otter-c" },
      ],
    };
    svc.createRoom("r1", config);
    await new Promise((r) => setTimeout(r, 400));
    expect(svc.view("r1", null)).toBeNull(); // 到限自动停局
    const notices = events.filter((e) => e.type === "error" && e.message.includes("自动停局"));
    expect(notices.length).toBe(1);
  });
});
