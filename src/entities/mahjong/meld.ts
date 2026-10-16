/**
 * 副露与手牌类型——三麻：无吃（chi 仅保留类型用于显式拒绝），
 * 有碰/明杠/暗杠/加杠/拔北（抜きドラ）。
 */

import type { Tile } from "./tile";

/** 副露来源（碰/明杠用）：上家/对家/下家 */
export type MeldSource = "kamicha" | "toimen" | "shimocha";

export type MeldType = "chi" | "pon" | "daiminkan" | "ankan" | "kakan" | "kita";

export interface Meld {
  readonly type: MeldType;
  /** 碰/杠：组成面子的牌（4 张则含 4 张）；碰 3 张、明杠 4 张；chi：3 张；kita：那张北 */
  readonly tiles: readonly Tile[];
  /** 碰/明杠/吃（鸣牌来源），暗杠/加杠/拔北无 */
  readonly from?: MeldSource;
}

/** 鸣牌动作请求（合法性校验输入） */
export interface CallRequest {
  readonly type: "chi" | "pon" | "daiminkan" | "ankan" | "kakan" | "kita";
  /** 被鸣的牌（碰/明杠/吃为别家打出的牌；暗杠/加杠/拔北为手内牌） */
  readonly called?: Tile;
  /** 暗杠/加杠/拔北目标牌 */
  readonly tile?: Tile;
}

/** 手牌（不含宝牌计数等局面信息——纯手牌结构） */
export interface Hand {
  /** 门清部分（含自摸/和牌张），已排序与否均可，裁判内部自行排序 */
  readonly concealed: readonly Tile[];
  /** 副露面子（碰/杠等，不含拔北） */
  readonly melds: readonly Meld[];
  /** 拔北累计数（北出自手牌，单独计数；不算面子） */
  readonly kitaCount: number;
}

/** 门清判定：有碰/明杠/加杠/吃 = 非门清；暗杠与拔北保持门清 */
export function isMenzen(hand: Pick<Hand, "melds">): boolean {
  return hand.melds.every((m) => m.type === "ankan" || m.type === "kita");
}

/** 面子种类数（副露 + 门清暗刻暗杠），用于向听数输入 */
export function meldCount(hand: Pick<Hand, "melds">): number {
  return hand.melds.length;
}
