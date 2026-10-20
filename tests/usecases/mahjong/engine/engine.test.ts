/**
 * 引擎状态机测试：确定性配牌 / 全剧本跑通东风战 / 点数守恒 / 非法动作拒绝。
 * 剧本代理 = 简单贪心：能和就和，否则打刚摸的牌，副露窗口一律过。
 */
import { describe, expect, it } from "vitest";
import { SanmaEngine, IllegalActionError, notation } from "../../../../src/usecases/mahjong/engine/engine";
import { parseTiles } from "../../../../src/entities/mahjong/tile";
import type { GameConfig, Seat } from "../../../../src/usecases/mahjong/engine/types";

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

/** 用剧本代理把整场东风战跑完；每步校验点数守恒 */
function runScriptedGame(seed: string): { engine: SanmaEngine; steps: number } {
  const engine = new SanmaEngine(cfg(seed));
  engine.startRound();
  const TOTAL = 35000 * 3;
  let steps = 0;
  while (engine.state.status === "playing") {
    steps += 1;
    if (steps > 20000) throw new Error("scripted game did not terminate");
    const dp = engine.decisionPoint();
    if (!dp) {
      // 结算停驻 → 推进
      engine.nextRound();
      if (dp === null && engine.state.status === "playing" && engine.decisionPoint() === null) {
        throw new Error("stuck: no decision point but round not settled");
      }
      continue;
    }
    let action;
    if (dp.kind === "claim") {
      action = dp.actions.find((a) => a.type === "pass")!;
    } else {
      const win = dp.actions.find((a) => a.type === "tsumo" || a.type === "ron");
      if (win) {
        action = win;
      } else if (dp.drawn) {
        action = dp.actions.find((a) => a.type === "discard" && a.tile === dp.drawn && !a.riichi);
      }
      action ??= dp.actions.find((a) => a.type === "discard");
      action ??= dp.actions.find((a) => a.type === "kita") ?? dp.actions[0];
    }
    expect(action, `no action at step ${steps} phase=${engine.state.round?.phase}`).toBeDefined();
    engine.apply(dp.seat, action!);
    // 点数守恒：场上点数 + 供托 = 105000
    const sum = engine.state.round!.players.reduce((x, p) => x + p.points, 0);
    expect(sum + engine.state.sticks * 1000).toBe(TOTAL);
  }
  return { engine, steps };
}

describe("SanmaEngine", () => {
  it("同 seed 确定性：配牌与全程状态一致", () => {
    const a = new SanmaEngine(cfg("det-seed-7"));
    const b = new SanmaEngine(cfg("det-seed-7"));
    a.startRound();
    b.startRound();
    const handsA = a.state.round!.players.map((p) => p.hand.map(notation).join(""));
    const handsB = b.state.round!.players.map((p) => p.hand.map(notation).join(""));
    expect(handsA).toEqual(handsB);
    expect(a.state.round!.wall.tiles.map(notation)).toEqual(b.state.round!.wall.tiles.map(notation));
    // 副本验证：整场跑完后全状态一致
    const ga = runScriptedGame("det-seed-7");
    const gb = runScriptedGame("det-seed-7");
    expect(JSON.stringify(ga.engine.state)).toBe(JSON.stringify(gb.engine.state));
    expect(ga.steps).toBe(gb.steps);
  });

  it("开局：仅庄家有决策点，动作集非空", () => {
    const e = new SanmaEngine(cfg("open-1"));
    e.startRound();
    const dp = e.decisionPoint();
    expect(dp).not.toBeNull();
    expect(dp!.kind).toBe("turn");
    expect(dp!.seat).toBe(0); // roundNo=1 → dealer=0
    expect(dp!.drawn).toBeDefined();
    expect(dp!.actions.filter((a) => a.type === "discard").length).toBeGreaterThan(0);
    // 非当前家无动作
    expect(e.legalActions(1 as Seat)).toEqual([]);
  });

  it("剧本代理跑完东风战：终局 + 守恒（多 seed 冒烟）", () => {
    for (const seed of ["s1", "s2", "seed-東", "20261016"]) {
      const { engine } = runScriptedGame(seed);
      expect(engine.state.status).toBe("finished");
      expect(engine.state.roundNo).toBe(4);
      const points = engine.state.round!.players.map((p) => p.points);
      expect(points.reduce((x, y) => x + y, 0)).toBe(105000 - engine.state.sticks * 1000);
      expect(points.every((p) => p >= 0)).toBe(true);
    }
  });

  it("非法动作拒绝：座位/动作不在合法集", () => {
    const e = new SanmaEngine(cfg("illegal-1"));
    e.startRound();
    // 非当前家出牌
    expect(() => e.apply(1 as Seat, { type: "discard", tile: "1p" })).toThrow(IllegalActionError);
    // 当前家打出不在手牌的牌
    expect(() => e.apply(0 as Seat, { type: "discard", tile: "9s" })).toThrow(IllegalActionError);
    // 结算后动作拒绝——直接对未开的局 apply
    const fresh = new SanmaEngine(cfg("illegal-2"));
    expect(() => fresh.apply(0 as Seat, { type: "discard", tile: "1p" })).toThrow(IllegalActionError);
  });

  it("同 seed 不同 seed 配牌不同（洗牌有效性）", () => {
    const a = new SanmaEngine(cfg("x-1"));
    const b = new SanmaEngine(cfg("x-2"));
    a.startRound();
    b.startRound();
    const ha = a.state.round!.players.map((p) => p.hand.map(notation).join(""));
    const hb = b.state.round!.players.map((p) => p.hand.map(notation).join(""));
    expect(ha).not.toEqual(hb);
  });
});

// ─── #1564-2 立直后摸打约束：仅摸切 + 暗杠听牌形不变（RED→GREEN）───

describe("立直后摸打约束（#1564-2）", () => {
  /** 白盒造一个立直态：当前家 riichi=true，手牌 = hand13 + drawn（drawn 入手并由 r.drawn 引用） */
  function forceRiichiTurn(hand13: string, drawn: string): SanmaEngine {
    const e = new SanmaEngine(cfg(`riichi-${hand13}-${drawn}`));
    e.startRound();
    const r = e.state.round!;
    const p = r.players[r.turn];
    p.hand = [...parseTiles(hand13), ...parseTiles(drawn)];
    p.riichi = true;
    p.ippatsu = false;
    r.drawn = p.hand[p.hand.length - 1]!;
    r.drawnRinshan = false;
    r.phase = "turn";
    return e;
  }

  it("立直后打牌候选仅剩刚摸的那张（tsumogiri），其余手牌张不可打", () => {
    const e = forceRiichiTurn("123p456p789s11z22p", "9s");
    const dp = e.decisionPoint()!;
    const discards = dp.actions.filter((a) => a.type === "discard");
    expect(discards).toEqual([{ type: "discard", tile: "9s" }]);
  });

  it("立直后打非摸切张被引擎拒绝（IllegalActionError）", () => {
    const e = forceRiichiTurn("123p456p789s11z22p", "9s");
    const seat = e.decisionPoint()!.seat;
    // 打非摸切的1p → 拒
    expect(() => e.apply(seat, { type: "discard", tile: "1p" })).toThrow(IllegalActionError);
    // 摸切 9s 合法可执行
    expect(() => e.apply(seat, { type: "discard", tile: "9s" })).not.toThrow();
  });

  it("立直后副露（碰/大明杠）不进候选——只能荣和或过", () => {
    const e = forceRiichiTurn("123p456p789s11z22p", "9s");
    const r = e.state.round!;
    const me = r.turn;
    const next = ((me + 1) % 3) as Seat;
    const third = ((me + 2) % 3) as Seat;
    r.players[next]!.hand = parseTiles("1z345p789s55s19m22s");
    r.players[third]!.hand = parseTiles("19m111p555s333p45z");
    // 立直家摸切 → 无人鸣 9s → 下家摸牌后打 1z
    e.apply(me, { type: "discard", tile: "9s" });
    e.apply(next, { type: "discard", tile: "1z" });
    const dp = e.decisionPoint()!;
    expect(dp.kind).toBe("claim");
    expect(dp.seat).toBe(me);
    expect(dp.actions.some((a) => a.type === "pon" || a.type === "daiminkan")).toBe(false);
    expect(dp.actions.some((a) => a.type === "pass")).toBe(true);
  });

  it("立直后暗杠/加杠照常提供（雀魂口径：无听牌不变限制）", () => {
    const e = forceRiichiTurn("111s23s567p789p99p", "1s");
    const dp = e.decisionPoint()!;
    expect(dp.actions.some((a) => a.type === "ankan" && a.kind === "1s")).toBe(true);
  });
});
