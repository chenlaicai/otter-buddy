/**
 * 规则代理（简单贪心兜底）——超时/异常/熔断/无决策量时的自动决策者。
 *
 * 策略（方案口径）：
 *   - 能和就和（ron/tsumo 一出现就取）
 *   - 听牌即立直（有立直合法候选即立直；优先摸切立直）
 *   - 安全牌优先：任一对手立直时，弃牌候选收敛到「每家立直者牌河都出现过的种类」（genbutsu），
 *     非空才收敛；空则退回牌效
 *   - 牌效弃牌：按弃后向听最小挑选，并列时优先摸切
 *   - 拔北：仅当北为孤张（手中 1 张、不入牌形结构）时拔
 *   - 副露（碰/杠）：一律过——兜底策略保守不副露（引擎单元测试另行覆盖副露路径）
 *
 * isTrivialDecision = 节流阀判定：无任何特殊动作且代理结论 = 摸切 → 无需唤醒 LLM。
 */

import { countsByKind, tileKind, type Tile } from "../../../entities/mahjong/tile";
import { shanten } from "../referee";
import { notation } from "./engine";
import type { SanmaEngine } from "./engine";
import type { DecisionPoint, EngineAction, Seat } from "./types";

/** 弃后向听（越小越好） */
function shantenAfter(handMinus: readonly Tile[], meldN: number): number {
  return shanten(handMinus, meldN).min;
}

/** 对手立直者们都弃过该种类才视为安全（genbutsu 交集） */
function isGenbutsu(engine: SanmaEngine, tile: Tile): boolean {
  const r = engine.state.round;
  if (!r) return false;
  const riichiSeats = r.players.filter((p) => p.riichi);
  if (riichiSeats.length === 0) return false;
  const k = tileKind(tile);
  return riichiSeats.every((p) => p.discards.some((d) => tileKind(d) === k));
}

function chooseDiscard(engine: SanmaEngine, dp: DecisionPoint, seat: Seat): EngineAction {
  const r = engine.state.round!;
  const p = r.players[seat];
  const plain = dp.actions.filter((a): a is Extract<EngineAction, { type: "discard" }> => a.type === "discard");
  const riichiOnes = plain.filter((a) => a.riichi === true);
  // 听牌即立直：优先摸切立直，否则首个合法立直弃牌
  if (riichiOnes.length > 0) {
    const tsumogiri = dp.drawn ? riichiOnes.find((a) => a.tile === dp.drawn) : undefined;
    return tsumogiri ?? riichiOnes[0]!;
  }
  const base = plain.filter((a) => a.riichi !== true);
  let candidates = base;
  const safe = r.players.filter((x) => x.riichi).length > 0 ? base.filter((a) => isGenbutsu(engine, handTile(p.hand, a.tile))) : [];
  if (safe.length > 0) candidates = safe;
  // 牌效：弃后向听最小；并列优先摸切
  let best: Extract<EngineAction, { type: "discard" }> | undefined;
  let bestShanten = Number.POSITIVE_INFINITY;
  for (const a of candidates) {
    const rest = [...p.hand];
    rest.splice(rest.indexOf(handTile(p.hand, a.tile)), 1);
    const s = shantenAfter(rest, p.melds.length);
    const prefer = a.tile === dp.drawn ? -0.5 : 0; // 摸切并列优先
    if (s + prefer < bestShanten) {
      bestShanten = s + prefer;
      best = a;
    }
  }
  return best ?? base[0]!;
}

function handTile(hand: readonly Tile[], n: string): Tile {
  return hand.find((t) => notation(t) === n)!;
}

/** 代理决策：从决策点合法动作集中挑选（引擎 apply 会再验一次成员资格） */
export function proxyChooseAction(engine: SanmaEngine, dp: DecisionPoint): EngineAction {
  if (dp.kind === "claim") {
    const ron = dp.actions.find((a) => a.type === "ron");
    if (ron) return ron;
    return dp.actions.find((a) => a.type === "pass") ?? dp.actions[0]!;
  }
  const seat = dp.seat;
  const r = engine.state.round!;
  const p = r.players[seat];
  const tsumo = dp.actions.find((a) => a.type === "tsumo");
  if (tsumo) return tsumo;
  // 拔北：孤张北才拔（不破坏牌形）
  const kita = dp.actions.find((a) => a.type === "kita");
  if (kita) {
    const cnt = countsByKind(p.hand);
    if (cnt[30] === 1) return kita;
  }
  if (dp.actions.some((a) => a.type === "discard")) return chooseDiscard(engine, dp, seat);
  // 剩余特殊动作（杠/九种九牌）：兜底保守——杠保留、九种九牌放弃（继续打）
  const kan = dp.actions.find((a) => a.type === "ankan" || a.type === "kakan");
  if (kan) return kan;
  const first = dp.actions[0];
  if (first) return first;
  throw new Error("proxy: empty action set");
}

/** 节流阀判定：无特殊动作且代理结论=摸切 → 自动执行、不唤醒 LLM */
export function isTrivialDecision(engine: SanmaEngine, dp: DecisionPoint): boolean {
  if (dp.kind !== "turn") return false;
  if (dp.actions.some((a) => a.type !== "discard")) return false;
  if (!dp.drawn) return false;
  try {
    const chosen = proxyChooseAction(engine, dp);
    return chosen.type === "discard" && chosen.tile === dp.drawn && chosen.riichi !== true;
  } catch {
    return false;
  }
}
