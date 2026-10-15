/**
 * 和牌总评：分解 × 役种 × 符 × 宝牌 × 点数，高点法取最大点。
 * 无役（含仅宝牌）→ valid=false。役满切替在 detectYaku 内完成。
 */

import { isSanmaKind, sortTiles, tileKind, type Tile } from "../../../entities/mahjong/tile";
import { isMenzen, type Meld } from "../../../entities/mahjong/meld";
import { decompose, type Pattern } from "./decompose";
import { calcFu, type FuContext } from "./fu";
import { countDora, type DoraCount } from "./dora";
import { pointsFromHanFu, yakumanPoints, type PointBreakdown, type ScoreOptions } from "./points";
import { YAKUMAN_MULT, detectYaku, type YakuHit } from "./yaku";

export interface WinContext {
  /** 和了时门清手牌，**含和了张**（副露后面数 = 14 - 3×副露数） */
  readonly concealed: readonly Tile[];
  readonly melds: readonly Meld[];
  /** 拔北次数（计宝牌，不入面子） */
  readonly kitaCount?: number;
  /** 和了张（必须在 concealed 中） */
  readonly winTile: Tile;
  readonly tsumo: boolean;
  readonly riichi?: boolean;
  readonly ippatsu?: boolean;
  readonly seatWind: "east" | "south" | "west";
  readonly roundWind: "east" | "south" | "west";
  readonly rinshan?: boolean;
  readonly chankan?: boolean;
  readonly haitei?: boolean;
  readonly houtei?: boolean;
  readonly doraIndicators: readonly Tile[];
  readonly uraIndicators?: readonly Tile[];
  readonly options?: ScoreOptions;
  /** 连风雀头记 4 符（默认开） */
  readonly doubleWindPairFu?: boolean;
}

export interface WinResult {
  readonly valid: boolean;
  readonly reason?: "TILE_NOT_SANMA" | "BAD_HAND_SIZE" | "NOT_WINNING" | "NO_YAKU";
  /** 役种命中（无役返回空） */
  readonly yakus: YakuHit[];
  /** 役种番数合计（不含宝牌） */
  readonly yakuHan: number;
  readonly dora: DoraCount;
  /** 含宝牌总番 */
  readonly totalHan: number;
  readonly fu?: number;
  readonly points?: PointBreakdown;
  /** 最优分解（供引擎展示） */
  readonly pattern?: Pattern;
}

const WIND_KIND: Record<string, number> = { east: 27, south: 28, west: 29 };

// eslint-disable-next-line complexity, max-statements, max-lines-per-function -- 和牌总评管线（校验→分解→役→符→宝牌→点数→高点法），拆分需跨函数传递上下文会割裂高点法挑选循环
export function evaluateWin(ctx: WinContext): WinResult {
  const melds = ctx.melds;
  const winKind = tileKind(ctx.winTile);

  // 牌合法性（含 2-8 万移除、字牌≤7）
  const all = [...ctx.concealed, ...melds.flatMap((m) => [...m.tiles])];
  if (all.some((t) => !isSanmaKind(tileKind(t)))) {
    return { valid: false, reason: "TILE_NOT_SANMA", yakus: [], yakuHan: 0, dora: emptyDora(), totalHan: 0 };
  }

  // 手牌张数：14 - 3×副露（拔北不占）
  const expected = 14 - 3 * melds.filter((m) => m.type !== "kita").length;
  if (ctx.concealed.length !== expected) {
    return { valid: false, reason: "BAD_HAND_SIZE", yakus: [], yakuHan: 0, dora: emptyDora(), totalHan: 0 };
  }
  if (!ctx.concealed.some((t) => t === ctx.winTile || (t.suit === ctx.winTile.suit && t.rank === ctx.winTile.rank && t.aka === ctx.winTile.aka))) {
    return { valid: false, reason: "BAD_HAND_SIZE", yakus: [], yakuHan: 0, dora: emptyDora(), totalHan: 0 };
  }

  const menzen = isMenzen({ melds });
  const preWinTiles = removeOneTile(ctx.concealed, ctx.winTile);

  const patterns = decompose(ctx.concealed, melds, winKind, !ctx.tsumo);
  if (patterns.length === 0) {
    return { valid: false, reason: "NOT_WINNING", yakus: [], yakuHan: 0, dora: emptyDora(), totalHan: 0 };
  }

  const seatWindKind = WIND_KIND[ctx.seatWind];
  const roundWindKind = WIND_KIND[ctx.roundWind];

  const dora = countDora({
    tiles: ctx.concealed,
    melds,
    doraIndicators: ctx.doraIndicators,
    uraIndicators: ctx.uraIndicators,
    riichi: ctx.riichi === true,
    kitaCount: ctx.kitaCount ?? 0,
  });

  const yakuCtx = {
    tsumo: ctx.tsumo,
    ron: !ctx.tsumo,
    menzen,
    riichi: ctx.riichi === true,
    ippatsu: ctx.ippatsu === true,
    seatWindKind,
    roundWindKind,
    rinshan: ctx.rinshan === true,
    chankan: ctx.chankan === true,
    haitei: ctx.haitei === true,
    houtei: ctx.houtei === true,
    winTile: ctx.winTile,
    preWinTiles,
  };

  const fuCtx: FuContext = {
    tsumo: ctx.tsumo,
    seatWindKind,
    roundWindKind,
    doubleWindPairFu: ctx.doubleWindPairFu,
  };

  let best: WinResult | null = null;

  for (const pattern of patterns) {
    const yakus = detectYaku(pattern, melds, yakuCtx);
    if (yakus.length === 0) continue; // 无役不成立
    const fu = calcFu(pattern, melds, fuCtx);
    const yakuHan = yakus.reduce((s, y) => s + y.value, 0);

    // 役满：仅役满计，32000×倍数（累计役满仅当无役满役种时）
    const yakuHanNonYakuman = yakus.filter((y) => !(y.id in YAKUMAN_MULT));
    const isYakuman = yakus.length > 0 && yakuHanNonYakuman.length === 0;
    let points: PointBreakdown;
    if (isYakuman) {
      const k = yakus.reduce((s, y) => s + y.value, 0);
      points = yakumanPoints(k);
    } else {
      const totalHan = yakus.reduce((s, y) => s + y.value, 0) + dora.total;
      points = pointsFromHanFu(totalHan, fu, ctx.options);
    }

    const result: WinResult = {
      valid: true,
      yakus,
      yakuHan,
      dora,
      totalHan: yakuHan + dora.total,
      fu,
      points,
      pattern,
    };
    if (!best || pointValue(result) > pointValue(best)) best = result;
  }

  if (!best) {
    return { valid: false, reason: "NO_YAKU", yakus: [], yakuHan: 0, dora, totalHan: dora.total };
  }
  return best;
}

function pointValue(r: WinResult): number {
  if (!r.points) return -1;
  // 高点法：同点优先高翻（oracle 同点时选了 10 番版），再比符
  return r.points.ron * 1e6 + r.yakuHan * 1e3 + (r.fu ?? 0);
}

function emptyDora(): DoraCount {
  return { dora: 0, aka: 0, ura: 0, kita: 0, total: 0 };
}

function removeOneTile(tiles: readonly Tile[], tile: Tile): Tile[] {
  const i = tiles.findIndex((t) => t.suit === tile.suit && t.rank === tile.rank && t.aka === tile.aka);
  if (i < 0) return [...tiles];
  return [...tiles.slice(0, i), ...tiles.slice(i + 1)];
}

export { sortTiles };
