/**
 * 役种识别——三麻可成立役种全集（无吃、万子无 2-8 → 三色同顺不可成立故不列入）。
 * 役满切替：存在役满时非役满不计（非青天井）。
 */

import { kindToTile, type Tile } from "../../../entities/mahjong/tile";
import type { Meld } from "../../../entities/mahjong/meld";
import type { Pattern } from "./decompose";

export type CommonYakuId =
  | "riichi"
  | "ippatsu"
  | "menzenTsumo"
  | "haitei"
  | "houtei"
  | "rinshan"
  | "chankan"
  | "pinfu"
  | "tanyao"
  | "iipeikou"
  | "roundWind"
  | "seatWind"
  | "haku"
  | "hatsu"
  | "chun"
  | "sanpeikou"
  | "toitoi"
  | "sanankou"
  | "ittsuu"
  | "chanta"
  | "chiitoitsu"
  | "shousangen"
  | "honroutou"
  | "sankantsu"
  | "junchan"
  | "ryanpeikou"
  | "honitsu"
  | "chinitsu";

export type YakumanYakuId =
  | "kokushi"
  | "kokushi13"
  | "suuankou"
  | "suuankouTanki"
  | "daisangen"
  | "shousuushii"
  | "daisuushii"
  | "tsuuiisou"
  | "chinroutou"
  | "ryuuiisou"
  | "chuuren"
  | "chuurenPure"
  | "suukantsu";

export type YakuId = CommonYakuId | YakumanYakuId;

/** 番数（普通役：门清/副露） */
export const COMMON_HAN: Record<CommonYakuId, readonly [number, number]> = {
  riichi: [1, 0],
  ippatsu: [1, 0],
  menzenTsumo: [1, 0],
  haitei: [1, 1],
  houtei: [1, 1],
  rinshan: [1, 1],
  chankan: [1, 1],
  pinfu: [1, 0],
  tanyao: [1, 1],
  iipeikou: [1, 0],
  roundWind: [1, 1],
  seatWind: [1, 1],
  haku: [1, 1],
  hatsu: [1, 1],
  chun: [1, 1],
  sanpeikou: [2, 2],
  toitoi: [2, 2],
  sanankou: [2, 2],
  ittsuu: [2, 1],
  chanta: [2, 1],
  chiitoitsu: [2, 0],
  shousangen: [2, 2],
  honroutou: [2, 2],
  sankantsu: [2, 2],
  junchan: [3, 2],
  ryanpeikou: [3, 0],
  honitsu: [3, 2],
  chinitsu: [6, 3],
};

/** 役满倍数（双倍役满 = 2） */
export const YAKUMAN_MULT: Record<YakumanYakuId, number> = {
  kokushi: 1,
  kokushi13: 2,
  suuankou: 1,
  suuankouTanki: 2,
  daisangen: 1,
  shousuushii: 1,
  daisuushii: 2,
  tsuuiisou: 1,
  chinroutou: 1,
  ryuuiisou: 1,
  chuuren: 1,
  chuurenPure: 2,
  suukantsu: 1,
};

export interface YakuHit {
  readonly id: YakuId;
  /** 该役番数（役满为倍数） */
  readonly value: number;
}

export interface YakuContext {
  readonly tsumo: boolean;
  readonly ron: boolean;
  readonly menzen: boolean;
  /** 立直（含一发由 ippatsu 字段另给） */
  readonly riichi: boolean;
  readonly ippatsu: boolean;
  readonly seatWindKind: number;
  readonly roundWindKind: number;
  /** 嶺上开花（暗杠/加杠后自摸） */
  readonly rinshan: boolean;
  /** 槍槓 */
  readonly chankan: boolean;
  /** 海底摸月（自摸最后一枚） */
  readonly haitei: boolean;
  /** 河底捞鱼（荣和最后一枚） */
  readonly houtei: boolean;
  /** 和了张（14 张中的一张；用于国士 13 面、纯正九莲判定） */
  readonly winTile: Tile;
  /** 和了前 13 张（concealed 去掉 winTile 一张） */
  readonly preWinTiles: readonly Tile[];
}

const GREEN = new Set([19, 20, 21, 23, 25, 32]); // 2s3s4s6s8s 发

function tileKinds(tiles: readonly Tile[]): number[] {
  return tiles.map((t) => t.suit === "m" ? t.rank - 1 : t.suit === "p" ? t.rank + 8 : t.suit === "s" ? t.rank + 17 : t.rank + 26);
}

function allTilesOf(pattern: Pattern, melds: readonly Meld[]): Tile[] {
  const tiles: Tile[] = [];
  for (const b of pattern.blocks) {
    if (b.type === "pair") {
      const t = kindToTile(b.kind);
      tiles.push(t, t);
    } else if (b.kindOfSet === "run") {
      tiles.push(kindToTile(b.kind), kindToTile(b.kind + 1), kindToTile(b.kind + 2));
    } else {
      const t = kindToTile(b.kind);
      tiles.push(t, t, t);
      if (melds.some((m) => (m.type === "daiminkan" || m.type === "ankan" || m.type === "kakan") && m.tiles[0].suit === t.suit && m.tiles[0].rank === t.rank)) {
        tiles.push(t); // 杠的第 4 张
      }
    }
  }
  return tiles;
}

function tripletKinds(pattern: Pattern): { kind: number; concealed: boolean }[] {
  return pattern.blocks
    .filter((b) => b.type === "set" && b.kindOfSet === "triplet")
    .map((b) => ({
      kind: (b as { kind: number }).kind,
      concealed: (b as { form: string }).form === "concealed",
    }));
}

function runKey(b: { kind: number }): number {
  return b.kind;
}

/** 役种识别：返回普通役与役满（普通役仅在无役满或青天井时生效——由调用方裁决）。 */
// eslint-disable-next-line complexity, max-statements, max-lines-per-function -- 役种规则表：41 役逐条判定天然多分支；按役拆为子函数会使局面上下文（ctx/判据）在十几次调用间传递，表驱动的可读性与对读性优先
export function detectYaku(pattern: Pattern, melds: readonly Meld[], ctx: YakuContext): YakuHit[] {
  const menzen = ctx.menzen;
  const yakus: YakuHit[] = [];
  const allTiles = allTilesOf(pattern, melds);
  const kinds = tileKinds(allTiles);
  const sets = pattern.blocks.filter((b) => b.type === "set") as { kind: number; kindOfSet: string; form: string }[];
  const pair = pattern.blocks.find((b) => b.type === "pair") as { kind: number } | undefined;

  const runs = sets.filter((s) => s.kindOfSet === "run");
  const trips = tripletKinds(pattern);

  // ---------- 役满候选 ----------
  const yakuman: YakumanYakuId[] = [];

  if (pattern.kind === "kokushi") {
    const preKinds = new Set(tileKinds(ctx.preWinTiles));
    if (preKinds.size === 13) yakuman.push("kokushi13");
    else yakuman.push("kokushi");
  }

  if (pattern.kind === "regular" && pair) {
    // 国士以外的标准形也可成役满（双碰荣和 → 非暗刻，断四暗刻）
    const shanponRon = pattern.waitType === "shanpon" && ctx.ron;
    const allTripConcealed = trips.length === 4 && trips.every((t) => t.concealed) && !shanponRon;
    if (trips.length === 4 && allTripConcealed) {
      if (pattern.waitType === "tanki") yakuman.push("suuankouTanki");
      else yakuman.push("suuankou");
    }
    const dragons = [31, 32, 33];
    const dragonTrips = dragons.filter((d) => trips.some((t) => t.kind === d));
    if (dragonTrips.length === 3) yakuman.push("daisangen");
    const winds = [27, 28, 29, 30];
    const windTrips = winds.filter((w) => trips.some((t) => t.kind === w));
    if (windTrips.length === 3 && pair && winds.includes(pair.kind)) yakuman.push("shousuushii");
    if (windTrips.length === 4) yakuman.push("daisuushii");

    if (kinds.every((k) => k >= 27)) yakuman.push("tsuuiisou");
    if (kinds.every((k) => k % 9 === 0 || k % 9 === 8)) yakuman.push("chinroutou");
    if (kinds.every((k) => GREEN.has(k))) yakuman.push("ryuuiisou");
    if (melds.filter((m) => m.type === "ankan" || m.type === "daiminkan" || m.type === "kakan").length === 4) yakuman.push("suukantsu");

    // 九莲宝灯：单一数牌、1≥3、9≥3、2-8 各≥1、共 14 张
    const suits = new Set(allTiles.filter((t) => t.suit !== "z").map((t) => t.suit));
    if (suits.size === 1 && allTiles.every((t) => t.suit !== "z")) {
      const suit = [...suits][0];
      const counts = new Array(10).fill(0);
      for (const t of allTiles) counts[t.rank]++;
      const ok =
        counts[1] >= 3 &&
        counts[9] >= 3 &&
        [2, 3, 4, 5, 6, 7, 8].every((r) => counts[r] >= 1) &&
        counts.reduce((a, b) => a + b, 0) === 14;
      if (ok && ctx.preWinTiles.every((t) => t.suit === suit)) {
        const c = new Array(10).fill(0);
        for (const t of ctx.preWinTiles) c[t.rank]++;
        // 纯正：和了前恰为 1112345678999（9 面听）
        const pure = c[1] === 3 && c[9] === 3 && [2, 3, 4, 5, 6, 7, 8].every((r) => c[r] === 1);
        yakuman.push(pure ? "chuurenPure" : "chuuren");
      }
    }
  }

  if (yakuman.length > 0) {
    return yakuman.map((id) => ({ id, value: YAKUMAN_MULT[id] }));
  }

  // ---------- 普通役 ----------
  const add = (id: CommonYakuId) => {
    const [m, o] = COMMON_HAN[id];
    const han = menzen ? m : o;
    if (han > 0) yakus.push({ id, value: han });
  };

  if (ctx.riichi) {
    add("riichi");
    if (ctx.ippatsu) add("ippatsu");
  }
  if (menzen && ctx.tsumo) add("menzenTsumo");
  if (ctx.haitei && ctx.tsumo) add("haitei");
  if (ctx.houtei && ctx.ron) add("houtei");
  if (ctx.rinshan && ctx.tsumo) add("rinshan");
  if (ctx.chankan && ctx.ron) add("chankan");

  if (kinds.every((k) => k % 9 !== 0 && k % 9 !== 8 && k < 27)) add("tanyao");

  // 役牌（仅刻子/杠子成立，雀头不算役——oracle 验证）
  const tripKinds = new Set(trips.map((t) => t.kind));
  if (tripKinds.has(ctx.roundWindKind)) add("roundWind");
  if (tripKinds.has(ctx.seatWindKind)) add("seatWind");
  if (tripKinds.has(31)) add("haku");
  if (tripKinds.has(32)) add("hatsu");
  if (tripKinds.has(33)) add("chun");

  // 平和：门清、全部顺子、两面听、雀头非役牌
  if (
    pattern.kind === "regular" &&
    menzen &&
    runs.length === 4 &&
    pattern.waitType === "ryanmen" &&
    pair !== undefined &&
    pair.kind !== ctx.roundWindKind &&
    pair.kind !== ctx.seatWindKind &&
    pair.kind < 31
  ) {
    add("pinfu");
  }

  // 一盃口 / 二盃口（门清）；二盃口成立时不再另计一盃口（oracle 验证）
  if (menzen && pattern.kind === "regular") {
    const runCounts = new Map<number, number>();
    for (const r of runs) runCounts.set(runKey(r), (runCounts.get(runKey(r)) ?? 0) + 1);
    let pairsOfRuns = 0;
    for (const c of runCounts.values()) pairsOfRuns += Math.floor(c / 2);
    if (pairsOfRuns >= 2) add("ryanpeikou");
    else if (pairsOfRuns >= 1) add("iipeikou");
  }

  // 一气通贯（万子在三麻不可成立，算法上自然不命中）
  if (runs.length >= 3) {
    const runSet = new Set(runs.map((r) => r.kind));
    for (const base of [0, 9, 18]) {
      if (runSet.has(base + 0) && runSet.has(base + 3) && runSet.has(base + 6)) {
        add("ittsuu");
        break;
      }
    }
  }

  // 对对和 / 三暗刻 / 三杠子 / 混老头 / 纯全带 / 混全带 / 三色同刻 / 小三元
  const isYaochuKindNum = (k: number) => k >= 27 || k % 9 === 0 || k % 9 === 8;

  if (pattern.kind === "regular") {
    if (sets.length === 4 && sets.every((s) => s.kindOfSet === "triplet")) add("toitoi");
    const concealedTrips = trips.filter((t) => t.concealed).length;
    // 双碰荣和的和了刻子按明刻化
    const concealedForSanankou = pattern.waitType === "shanpon" && ctx.ron ? concealedTrips - 1 : concealedTrips;
    if (concealedForSanankou >= 3) add("sanankou");
    const kanCount = melds.filter((m) => m.type === "daiminkan" || m.type === "ankan" || m.type === "kakan").length;
    if (kanCount === 3) add("sankantsu");

    if (kinds.every((k) => isYaochuKindNum(k))) add("honroutou");

    // 全带幺九：每块含幺九且至少一副顺子（无顺子的纯混老头不计全带——oracle 验证）；无字→纯全带
    const hasRun = runs.length >= 1;
    const blocksAllYao = pattern.blocks.every((b) => {
      if (b.type === "pair") return isYaochuKindNum(b.kind);
      if (b.kindOfSet === "triplet") return isYaochuKindNum(b.kind);
      const r = b.kind % 9;
      return r === 0 || r + 2 === 8; // 123 或 789
    });
    if (hasRun && blocksAllYao) {
      const noHonor = kinds.every((k) => k < 27);
      if (noHonor) add("junchan");
      else add("chanta");
    }

    // 三色同刻
    if (trips.length >= 3) {
      const map = new Map<number, Set<string>>();
      for (const t of trips) {
        const tile = kindToTile(t.kind);
        if (tile.suit === "z") continue;
        if (!map.has(tile.rank)) map.set(tile.rank, new Set());
        map.get(tile.rank)!.add(tile.suit);
      }
      for (const suits of map.values()) if (suits.size >= 3) add("sanpeikou");
    }

    // 小三元：两副露役牌刻 + 一张役牌对
    if (pair && pair.kind >= 31) {
      const dragonTrips = [31, 32, 33].filter((d) => trips.some((t) => t.kind === d));
      if (dragonTrips.length === 2) add("shousangen");
    }
  }

  // 七对子
  if (pattern.kind === "chiitoi") add("chiitoitsu");

  // 混一色 / 清一色
  const suitSet = new Set(kinds.filter((k) => k < 27).map((k) => kindToTile(k).suit));
  const hasHonor = kinds.some((k) => k >= 27);
  if (suitSet.size === 1) {
    if (hasHonor) add("honitsu");
    else add("chinitsu");
  }

  return yakus;
}
