/**
 * 宝牌计数：指示牌宝牌 / 里宝牌 / 赤宝牌 / 拔北宝牌。
 * 拔北宝牌 = 拔北者自己的每张北 1 番（仅计入拔北者和牌时；不算役）。
 */

import { doraKindFromIndicator, tileKind, type Tile } from "../../../entities/mahjong/tile";
import type { Meld } from "../../../entities/mahjong/meld";

export interface DoraInput {
  /** 和了者门清部分手牌（含和了张）；副露牌由 melds 单独传入，勿重复 */
  readonly tiles: readonly Tile[];
  readonly melds: readonly Meld[];
  /** 表宝牌指示牌 */
  readonly doraIndicators: readonly Tile[];
  /** 里宝牌指示牌（立直和了时有效） */
  readonly uraIndicators?: readonly Tile[];
  /** 立直和了（才有里宝牌） */
  readonly riichi: boolean;
  /** 和了者本局拔北次数 */
  readonly kitaCount: number;
}

export interface DoraCount {
  readonly dora: number;
  readonly aka: number;
  readonly ura: number;
  readonly kita: number;
  /** 总计（dora + aka + ura + kita），计入翻数 */
  readonly total: number;
}

function countKind(tiles: readonly Tile[], kind: number): number {
  let n = 0;
  for (const t of tiles) if (tileKind(t) === kind) n++;
  return n;
}

export function countDora(input: DoraInput): DoraCount {
  const handTiles: Tile[] = [...input.tiles];
  for (const m of input.melds) for (const t of m.tiles) handTiles.push(t);

  let dora = 0;
  for (const ind of input.doraIndicators) {
    dora += countKind(handTiles, doraKindFromIndicator(tileKind(ind)));
  }

  const aka = handTiles.filter((t) => t.aka).length;

  let ura = 0;
  if (input.riichi && input.uraIndicators) {
    for (const ind of input.uraIndicators) {
      ura += countKind(handTiles, doraKindFromIndicator(tileKind(ind)));
    }
  }

  const kita = input.kitaCount;

  return { dora, aka, ura, kita, total: dora + aka + ura + kita };
}
