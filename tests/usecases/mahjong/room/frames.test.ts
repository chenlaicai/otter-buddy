/**
 * 落帧测试：入帧/哈希链校验/篡改侦测/最新帧恢复（断线重连语义）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteFrameStore } from "../../../../src/usecases/mahjong/room/frames";
import { SanmaEngine, restoreEngine, notation } from "../../../../src/usecases/mahjong/engine/engine";
import { proxyChooseAction } from "../../../../src/usecases/mahjong/engine/proxy";
import type { GameConfig } from "../../../../src/usecases/mahjong/engine/types";

function cfg(seed: string): GameConfig {
  return {
    seed,
    startPoints: 35000,
    players: [
      { kind: "otter", name: "A", otterId: "otter-a" },
      { kind: "human", name: "B" },
      { kind: "proxy", name: "C" },
    ],
  };
}

describe("SqliteFrameStore 落帧", () => {
  let db: Database.Database;
  let store: SqliteFrameStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    store = new SqliteFrameStore(db);
  });

  afterEach(() => db.close());

  it("入帧 + 哈希链校验 + 篡改侦测", () => {
    store.createGame("g1", "room-1", cfg("f-seed"));
    const engine = new SanmaEngine(cfg("f-seed"));
    const events = engine.startRound();
    expect(events[0]!.type).toBe("deal");
    store.appendFrame("g1", engine.state, null); // 建局首帧（无触发动作）

    // 代理走 15 步，每步落帧
    for (let i = 0; i < 15; i++) {
      const dp = engine.decisionPoint();
      if (!dp) break;
      const action = proxyChooseAction(engine, dp);
      engine.apply(dp.seat, action);
      store.appendFrame("g1", engine.state, action);
    }
    const last = store.latestFrame("g1");
    expect(last).not.toBeNull();
    expect(last!.seq).toBeGreaterThan(0);
    expect(store.verifyChain("g1")).toBeNull();

    // 篡改中间帧 state → 链校验定位
    const victim = db
      .prepare("SELECT state_json FROM mahjong_frames WHERE game_id = 'g1' AND seq = 3")
      .get() as { state_json: string };
    const tampered = { ...(JSON.parse(victim.state_json) as Record<string, unknown>), hacked: true };
    db.prepare("UPDATE mahjong_frames SET state_json = ? WHERE game_id = ? AND seq = ?").run(
      JSON.stringify(tampered),
      "g1",
      3,
    );
    expect(store.verifyChain("g1")).toBe(3);
  });

  it("最新帧恢复：全状态往返一致 + 恢复后可继续推进", () => {
    store.createGame("g2", "room-2", cfg("recover-seed"));
    const engine = new SanmaEngine(cfg("recover-seed"));
    engine.startRound();
    store.appendFrame("g2", engine.state, null);
    let steps = 0;
    for (let i = 0; i < 10; i++) {
      const dp = engine.decisionPoint();
      if (!dp) break;
      const action = proxyChooseAction(engine, dp);
      engine.apply(dp.seat, action);
      store.appendFrame("g2", engine.state, action);
      steps += 1;
    }
    expect(steps).toBeGreaterThan(0);
    const frame = store.latestFrame("g2")!;

    // 恢复：状态逐字节等价（确定性快照往返）
    const restored = restoreEngine(frame.state);
    expect(JSON.stringify(restored.state)).toBe(JSON.stringify(frame.state));
    expect(restored.state.round!.players.map((p) => p.hand.map(notation).join(""))).toEqual(
      engine.state.round!.players.map((p) => p.hand.map(notation).join("")),
    );

    // 恢复后与原引擎并行同步推进（同动作同结果——可继续对局）
    const dpA = engine.decisionPoint();
    const dpB = restored.decisionPoint();
    expect(dpB).not.toBeNull();
    if (dpA && dpB) {
      const act = proxyChooseAction(restored, dpB);
      engine.apply(dpA.seat, act);
      restored.apply(dpB.seat, act);
      expect(JSON.stringify(restored.state)).toBe(JSON.stringify(engine.state));
    }
  });

  it("game 元数据：创建/按房间查找/状态更新", () => {
    store.createGame("g3", "room-3", cfg("meta-seed"));
    const g = store.getGame("g3")!;
    expect(g.roomId).toBe("room-3");
    expect(g.seed).toBe("meta-seed");
    expect(g.status).toBe("playing");
    store.updateGameStatus("g3", "finished");
    expect(store.getGame("g3")!.status).toBe("finished");
    expect(store.findGameByRoom("room-3")!.id).toBe("g3");
    expect(store.findGameByRoom("nope")).toBeNull();
  });
});
