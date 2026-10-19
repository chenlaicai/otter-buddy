/**
 * 流局判定（三麻）：
 * - 三风连打：开局第一巡三家第一打均为同一风牌（四风连打的三麻适配）
 * - 四杠散了：全场杠数合计 4（含抢杠/岭上和了优先——和了在先时和了成立）
 * - 九种九牌：庄家配牌+第一摸中幺九字 ≥9 种类（仅庄家首巡）
 * - 流局满贯：流局时仅一家听牌 → 该家得 4000（两家各付 2000）
 * - 荒牌流局：听牌家数 1/2 → 未听者合计付 3000（听牌家各得 3000/家数倒数）
 */

import { tileKind, type Tile } from "../../../entities/mahjong/tile";

export type AbortiveDrawKind = "threeWinds" | "fourKans" | "nineTerminals";

export interface AbortiveDrawInput {
  /** 开局第一打（按行动顺序，最多 3 张）——仅第一巡且无人副露 */
  readonly firstDiscards?: readonly Tile[];
  readonly firstDiscardsComplete?: boolean;
  /** 全场杠数（碰明杠/暗杠/加杠合计，不含拔北） */
  readonly totalKans: number;
  /** 第 4 杠刚完成且无人岭上和了 */
  readonly fourthKanResolved?: boolean;
  /** 庄家首巡手牌（14 张）；非首巡或非庄家为 undefined */
  readonly dealerFirstDrawTiles?: readonly Tile[];
}

export interface AbortiveDrawResult {
  readonly kind: AbortiveDrawKind | null;
  /** 九种九牌：庄家可选择流局 */
  readonly nineTerminalsAvailable?: boolean;
}

function isYaochuKind(k: number): boolean {
  return k >= 27 || k % 9 === 0 || k % 9 === 8;
}

export function detectAbortiveDraw(input: AbortiveDrawInput): AbortiveDrawResult {
  // 三风连打：第一打均为同一风牌（东/南/西/北任一，三家同风）
  if (input.firstDiscardsComplete && input.firstDiscards && input.firstDiscards.length === 3) {
    const kinds = input.firstDiscards.map(tileKind);
    const allWind = kinds.every((k) => k >= 27 && k <= 30);
    if (allWind && kinds[0] === kinds[1] && kinds[1] === kinds[2]) {
      return { kind: "threeWinds" };
    }
  }

  // 四杠散了
  if (input.totalKans >= 4 && input.fourthKanResolved !== false) {
    return { kind: "fourKans" };
  }

  // 九种九牌
  if (input.dealerFirstDrawTiles && input.dealerFirstDrawTiles.length === 14) {
    const kinds = new Set(input.dealerFirstDrawTiles.map(tileKind).filter(isYaochuKind));
    if (kinds.size >= 9) {
      return { kind: "nineTerminals", nineTerminalsAvailable: true };
    }
  }

  return { kind: null };
}

export interface NotenSettlementInput {
  /** 三家是否听牌（index 0-2） */
  readonly tenpai: readonly boolean[];
}

export interface NotenSettlement {
  readonly tenpaiCount: number;
  /** 流局满贯成立（恰一家听牌） */
  readonly manganDraw: boolean;
  /** 各家点数增减（正=收入） */
  readonly deltas: readonly number[];
}

/**
 * 荒牌流局点数分配（三麻）：
 * - 流局满贯：恰 1 家听牌 → +4000，两家各 −2000
 * - 其余：听牌者共分 3000（未听者支付）：2 听 → 各 +1500；1 听 → +3000（流局满贯覆盖）；0/3 听 → 无交换
 */
export function notenSettlement(input: NotenSettlementInput): NotenSettlement {
  const t = input.tenpai;
  if (t.length !== 3) throw new Error("sanma needs 3 players");
  const tenpaiCount = t.filter(Boolean).length;
  const deltas = [0, 0, 0];

  if (tenpaiCount === 1) {
    const wi = t.findIndex(Boolean);
    deltas[wi] = 4000;
    for (let i = 0; i < 3; i++) if (i !== wi) deltas[i] = -2000;
    return { tenpaiCount, manganDraw: true, deltas };
  }
  if (tenpaiCount === 2) {
    const noten = t.findIndex((x) => !x);
    deltas[noten] = -3000;
    for (let i = 0; i < 3; i++) if (t[i]) deltas[i] = 1500;
    return { tenpaiCount, manganDraw: false, deltas };
  }
  return { tenpaiCount, manganDraw: false, deltas };
}
