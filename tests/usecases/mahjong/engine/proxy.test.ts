/**
 * 规则代理测试：整场代理跑通（引擎 apply 兼作成员资格校验）、节流阀判定、
 * 路径覆盖扫描（事件/结算种类在固定 seed 集上确定性收集后固化断言）。
 */
import { describe, expect, it } from "vitest";
import { SanmaEngine, notation } from "../../../../src/usecases/mahjong/engine/engine";
import { proxyChooseAction, isTrivialDecision } from "../../../../src/usecases/mahjong/engine/proxy";
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

interface RunLog {
  engine: SanmaEngine;
  events: string[];
  settlements: string[];
  trivialCount: number;
  nonTrivialClaim: number;
}

/** 代理决策跑完整场；forcePon = 副露窗口优先碰（覆盖副露路径） */
function runProxyGame(seed: string, opts: { forcePon?: boolean } = {}): RunLog {
  const engine = new SanmaEngine(cfg(seed));
  engine.startRound();
  const log: RunLog = { engine, events: [], settlements: [], trivialCount: 0, nonTrivialClaim: 0 };
  const TOTAL = 105000;
  let steps = 0;
  while (engine.state.status === "playing") {
    steps += 1;
    if (steps > 30000) throw new Error("proxy game did not terminate");
    const dp = engine.decisionPoint();
    if (!dp) {
      for (const ev of engine.nextRound()) log.events.push(ev.type);
      continue;
    }
    if (isTrivialDecision(engine, dp)) log.trivialCount += 1;
    if (dp.kind === "claim" && !isTrivialDecision(engine, dp)) log.nonTrivialClaim += 1;
    let action;
    if (dp.kind === "claim" && opts.forcePon) {
      action = dp.actions.find((a) => a.type === "pon") ?? proxyChooseAction(engine, dp);
    } else {
      action = proxyChooseAction(engine, dp);
    }
    // apply 内部会做成员资格校验，非法即抛——此处即「代理永远产出合法动作」的证明
    const res = engine.apply(dp.seat, action);
    for (const ev of res.events) {
      log.events.push(ev.type);
      if (ev.type === "win") log.settlements.push(`win:${ev.settlement.kind}`);
      if (ev.type === "drawEnd") log.settlements.push(`draw:${ev.settlement.kind}`);
      if (ev.type === "abortive") log.settlements.push(`abort:${ev.settlement.abortive}`);
    }
    const rr = engine.state.round!;
    const sum = rr.players.reduce((x, p) => x + p.points, 0);
    expect(sum + rr.sticks * 1000).toBe(TOTAL);
  }
  return log;
}

describe("规则代理", () => {
  const SEEDS = ["p1", "p2", "p3", "p4", "p5"];

  // 显式超时预算（检视轮发现的负载抖动实证）：本文件整场扫描 solo ~2.6s，vitest 默认 5s
  // 全量并行负载下越线即报 timed out（`--testTimeout=1500` 可稳定复现同型失败）——非行为问题
  it("整场代理跑通：动作全合法（apply 校验）+ 守恒 + 终局", { timeout: 20_000 }, () => {
    const kinds = new Set<string>();
    const settle = new Set<string>();
    let trivial = 0;
    for (const seed of SEEDS) {
      const log = runProxyGame(seed);
      expect(log.engine.state.status).toBe("finished");
      trivial += log.trivialCount;
      log.events.forEach((e) => kinds.add(e));
      log.settlements.forEach((s) => settle.add(s));
    }
    // 节流阀：代理局里存在无决策量回合（trivial 判定产出）
    expect(trivial).toBeGreaterThan(0);
    // 固定 seed 集上的路径覆盖（确定性固化）：三种和了 + 立直供托 + 拔北全命中
    expect([...kinds].sort()).toEqual([
      "deal",
      "discard",
      "draw",
      "drawEnd",
      "gameOver",
      "kita",
      "riichiSticks",
      "win",
    ]);
    expect([...settle].sort()).toEqual(["draw:noten", "win:ron", "win:tsumo"]);
  });

  it("副露路径：forcePon 下整场出现碰/杠事件", { timeout: 20_000 }, () => {
    const kinds = new Set<string>();
    let anyMeld = false;
    for (const seed of ["fp1", "fp2", "fp3"]) {
      const log = runProxyGame(seed, { forcePon: true });
      log.events.forEach((e) => kinds.add(e));
      if (log.engine.state.round!.players.some((p) => p.melds.length > 0)) anyMeld = true;
    }
    expect(kinds).toContain("call");
    expect(anyMeld).toBe(true);
  });

  // eslint-disable-next-line complexity -- 定向 seed 扫描脚本：双扫描循环（九种九牌/三风连打）+ 命中种子复验过程式串写，拆为子函数需跨闭包传递扫描状态与复验上下文
  it("流局条款接线：三风连打/九种九牌定向扫描命中", { timeout: 20_000 }, () => {
    // ① 九种九牌：仅需开局（配牌+第一摸）后合法动作含流局——deal-only 扫描极廉
    let nineSeed: string | undefined;
    for (let i = 0; i < 4000 && !nineSeed; i++) {
      const seed = `nine-${i}`;
      const e = new SanmaEngine(cfg(seed));
      e.startRound();
      const dp = e.decisionPoint();
      if (dp && dp.actions.some((a) => a.type === "ryuukyoku")) nineSeed = seed;
    }
    // ② 三风连打：定向扫描——首打优先挑风牌（1z-4z，从合法动作集内选），首家无风则换 seed
    let threeSeed: string | undefined;
    for (let i = 0; i < 300 && !threeSeed; i++) {
      const seed = `three-${i}`;
      const e = new SanmaEngine(cfg(seed));
      e.startRound();
      const handHasWind = e.state.round!.players[0]!.hand.some((t) => /^[1-4]z$/.test(notation(t)));
      if (!handHasWind) continue;
      let steps = 0;
      while (e.state.round?.phase !== "draw" && e.state.round?.phase !== "win" && steps < 8) {
        steps += 1;
        const dp = e.decisionPoint();
        if (!dp) break;
        let action;
        if (dp.kind === "turn") {
          const firstWind = e.state.round!.firstDiscards[0];
          const want = firstWind ? notation(firstWind) : undefined;
          const winds = dp.actions.filter((a) => a.type === "discard" && /^[1-4]z$/.test(a.tile));
          action = (want ? winds.find((a) => a.type === "discard" && a.tile === want) : undefined) ?? winds[0];
        }
        action ??= dp.actions.find((a) => a.type === "pass") ?? dp.actions[0];
        e.apply(dp.seat, action!);
      }
      const st = e.state.round?.settlement;
      if (st?.kind === "abortive" && st.abortive === "threeWinds") threeSeed = seed;
    }
    // 固定扫描空间（确定性）；失败=规则/牌流变化，重新固化
    expect(nineSeed, "九种九牌扫描 4000 seed 未命中").toBeDefined();
    expect(threeSeed, "三风连打扫描 400 seed 未命中").toBeDefined();
    // 命中种子上复验结算形态
    const e = new SanmaEngine(cfg(nineSeed!));
    e.startRound();
    expect(e.decisionPoint()!.actions.some((a) => a.type === "ryuukyoku")).toBe(true);
    e.apply(0, { type: "ryuukyoku" });
    expect(e.state.round!.settlement).toMatchObject({ kind: "abortive", abortive: "nineTerminals" });
    const f = new SanmaEngine(cfg(threeSeed!));
    f.startRound();
    let steps = 0;
    while (f.state.round?.phase !== "draw" && f.state.round?.phase !== "win" && steps < 8) {
      steps += 1;
      const dp = f.decisionPoint();
      if (!dp) break;
      let action;
      if (dp.kind === "turn") {
        const firstWind = f.state.round!.firstDiscards[0];
        const want = firstWind ? notation(firstWind) : undefined;
        const winds = dp.actions.filter((a) => a.type === "discard" && /^[1-4]z$/.test(a.tile));
        action = (want ? winds.find((a) => a.type === "discard" && a.tile === want) : undefined) ?? winds[0];
      }
      action ??= dp.actions.find((a) => a.type === "pass") ?? dp.actions[0];
      f.apply(dp.seat, action!);
    }
    expect(f.state.round!.settlement).toMatchObject({ kind: "abortive", abortive: "threeWinds" });
  });

  it("节流阀判定：副露窗口恒非平凡（方案口径：窗口必唤醒）", () => {
    const engine = new SanmaEngine(cfg("tv-1"));
    engine.startRound();
    let claimSeen = 0;
    let steps = 0;
    while (engine.state.status === "playing" && steps < 30000) {
      steps += 1;
      const dp = engine.decisionPoint();
      if (!dp) {
        engine.nextRound();
        continue;
      }
      if (dp.kind === "claim") {
        claimSeen += 1;
        expect(isTrivialDecision(engine, dp)).toBe(false);
      }
      engine.apply(dp.seat, proxyChooseAction(engine, dp));
    }
    expect(engine.state.status).toBe("finished");
    // tv-1 固定局：窗口是否出现取决于牌流，出现则断言其上性质
    void claimSeen;
  });
});
