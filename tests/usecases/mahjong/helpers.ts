/**
 * 裁判测试公共助手。
 */
import { parseTiles, tileKind, type Tile } from "@entities/mahjong/tile";
import type { Meld } from "@entities/mahjong/meld";
import { evaluateWin, type WinContext, type WinResult } from "../../../src/usecases/mahjong/referee/win";
import type { YakuId } from "../../../src/usecases/mahjong/referee/yaku";

export { parseTiles, tileKind };
export type { Tile, Meld, WinResult };

/** 快速和牌评估：'123m...' 记谱 + 和了张记谱（需为门清中的一张，按值匹配） */
export function winEval(
  hand: string,
  win: string,
  opts: Partial<WinContext> = {},
): WinResult {
  const concealed = parseTiles(hand);
  const want = parseTiles(win)[0];
  const winTile = concealed.find(
    (t) => t.suit === want.suit && t.rank === want.rank && t.aka === want.aka,
  );
  if (!winTile) throw new Error(`win tile ${win} not in hand ${hand}`);
  return evaluateWin({
    concealed,
    melds: [],
    winTile,
    tsumo: false,
    seatWind: "south",
    roundWind: "east",
    doraIndicators: [],
    ...opts,
  });
}

export function yakuIds(r: WinResult): string[] {
  return r.yakus.map((y) => y.id as string);
}

export function hasYaku(r: WinResult, id: YakuId, value?: number): boolean {
  const hit = r.yakus.find((y) => y.id === id);
  if (!hit) return false;
  return value === undefined || hit.value === value;
}

/** 断言役种集合完全一致（顺序无关） */
export function expectYakus(r: WinResult, ids: string[]): void {
  const actual = [...yakuIds(r)].sort();
  const expected = [...ids].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`yaku mismatch: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)} (valid=${r.valid}, reason=${r.reason})`);
  }
}
