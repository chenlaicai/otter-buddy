/**
 * 手牌分解：标准形（4 面子+雀头）、七对、国士
 * 枚举全部分解供高点法挑选；顺带产出听牌形（听牌张/等待类型）。
 */

import { countsByKind, isSanmaKind, kindToTile, tileKind, type Tile } from "../../../entities/mahjong/tile";
import type { Meld } from "../../../entities/mahjong/meld";

export type SetForm = "concealed" | "open" | "ankan" | "openkan";

export interface SetBlock {
  readonly type: "set";
  readonly kind: number;
  readonly kindOfSet: "run" | "triplet";
  /** run 时 kind = 最小张；triplet 时 kind = 该牌 */
  readonly form: SetForm; // run 恒为 concealed（副露顺子在三麻不存在）
}

export interface PairBlock {
  readonly type: "pair";
  readonly kind: number;
}

export type Block = SetBlock | PairBlock;

export type WaitType = "ryanmen" | "kanchan" | "penchan" | "tanki" | "shanpon";

export interface Pattern {
  readonly kind: "regular" | "chiitoi" | "kokushi";
  readonly blocks: readonly Block[]; // regular: 4 set + 1 pair
  /** 和了张种类 */
  readonly winKind: number;
  readonly ron: boolean;
  /** regular: 和了等待类型；chiitoi: 恒 tanki（符固定不使用）；kokushi: 恒 tanki */
  readonly waitType: WaitType;
  /** 和了张落入的 set 索引（shanpon ron 判定用）；tanki 时为 pair 索引 */
  readonly winBlockIndex: number;
  /** 国士 13 面 */
  readonly isKokushi13?: boolean;
  /** 四暗刻单骑 */
  readonly isSuuankouTanki?: boolean;
}

/** 副露面子 → 固定 SetBlock */
export function meldToBlocks(meld: Meld): SetBlock {
  const kind = tileKind(meld.tiles[0]);
  switch (meld.type) {
    case "chi":
      return { type: "set", kind, kindOfSet: "run", form: "concealed" };
    case "pon":
      return { type: "set", kind, kindOfSet: "triplet", form: "open" };
    case "daiminkan":
    case "kakan":
      return { type: "set", kind, kindOfSet: "triplet", form: "openkan" };
    case "ankan":
      return { type: "set", kind, kindOfSet: "triplet", form: "ankan" };
    case "kita":
      throw new Error("kita is not a meld block");
  }
}

function waitTypeOf(runKind: number, winKind: number): WaitType {
  const w = winKind - runKind; // 0,1,2
  const rank = (runKind % 9) + 1;
  if (w === 1) return "kanchan";
  if ((rank === 1 && (w === 0 || w === 2)) || (rank === 7 && w === 0)) return "penchan";
  return "ryanmen";
}

interface EnumCtx {
  counts: number[];
  fixed: SetBlock[];
  winKind: number;
  ron: boolean;
  out: { sets: SetBlock[]; pairKind: number }[];
}

/** 枚举门清部分的面子分解：凑齐 (4-f) 面子且剩余恰为雀头一对 */
// eslint-disable-next-line complexity, max-statements -- 分解 DFS：刻子/顺子/跳过三分支 + 张数严格剪枝，计数回溯必须同函数闭合
function enumSets(ctx: EnumCtx, kind: number, acc: SetBlock[]): void {
  const need = 4 - ctx.fixed.length;
  if (acc.length === need) {
    // 剩余必须恰为一对（含跳过未消费的种类）
    let restKind = -1;
    let restTotal = 0;
    for (let k = 0; k < 34; k++) {
      if (ctx.counts[k] > 0) {
        restTotal += ctx.counts[k];
        if (ctx.counts[k] === 2) restKind = k;
      }
    }
    if (restTotal === 2 && restKind >= 0) {
      ctx.out.push({ sets: [...acc], pairKind: restKind });
    }
    return;
  }
  while (kind < 34 && ctx.counts[kind] === 0) kind++;
  if (kind === 34) return;
  const remainingSets = need - acc.length;
  const remainTiles = ctx.counts.reduce((s, c) => s + c, 0);
  // 剩余张数必须恰为 remainingSets×3 + 2（面子 + 雀头）
  if (remainTiles !== remainingSets * 3 + 2) return;

  // 刻子
  if (ctx.counts[kind] >= 3) {
    ctx.counts[kind] -= 3;
    acc.push({ type: "set", kind, kindOfSet: "triplet", form: "concealed" });
    enumSets(ctx, kind, acc);
    acc.pop();
    ctx.counts[kind] += 3;
  }
  // 顺子
  const rank = (kind % 9) + 1;
  if (kind < 27 && rank <= 7 && ctx.counts[kind + 1] > 0 && ctx.counts[kind + 2] > 0) {
    ctx.counts[kind]--;
    ctx.counts[kind + 1]--;
    ctx.counts[kind + 2]--;
    acc.push({ type: "set", kind, kindOfSet: "run", form: "concealed" });
    enumSets(ctx, kind, acc);
    acc.pop();
    ctx.counts[kind]++;
    ctx.counts[kind + 1]++;
    ctx.counts[kind + 2]++;
  }
  // 跳过：当前种类留作雀头/他用（不消费、不清零，保证雀头可识别）
  enumSets(ctx, kind + 1, acc);
}

/** 由门清14张（含和了张）+副露 枚举标准形分解 */
export function decomposeRegular(
  concealed: readonly Tile[],
  melds: readonly Meld[],
  winKind: number,
  ron: boolean,
): Pattern[] {
  const fixed = melds.filter((m) => m.type !== "kita").map(meldToBlocks);
  const counts = countsByKind(concealed);
  if (fixed.length > 4) return [];

  const ctx: EnumCtx = { counts, fixed, winKind, ron, out: [] };
  enumSets(ctx, 0, []);
  const patterns: Pattern[] = [];
  for (const { sets, pairKind } of ctx.out) {
    const blocks: Block[] = [...fixed, ...sets];
    const allBlocks: Block[] = [...blocks, { type: "pair", kind: pairKind }];
    // 和了张可由多个块认领（如对子与顺子同含和了张）——全部产出交高点法
    for (const claim of waitClaims(allBlocks, winKind, ron)) {
      patterns.push({
        kind: "regular",
        blocks: allBlocks,
        winKind,
        ron,
        waitType: claim.waitType,
        winBlockIndex: claim.index,
      });
    }
  }
  return patterns;
}

function waitClaims(
  blocks: Block[],
  winKind: number,
  _ron: boolean,
): { waitType: WaitType; index: number }[] {
  const claims: { waitType: WaitType; index: number }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "pair" && b.kind === winKind) {
      claims.push({ waitType: "tanki", index: i });
    }
    if (b.type === "set" && b.kindOfSet === "run") {
      const w = winKind - b.kind;
      if (w >= 0 && w <= 2) {
        claims.push({ waitType: waitTypeOf(b.kind, winKind), index: i });
      }
    }
    if (b.type === "set" && b.kindOfSet === "triplet" && b.kind === winKind) {
      // shanpon：ron 计明刻化；tsumo 计暗刻（fu 层区分）
      claims.push({ waitType: "shanpon", index: i });
    }
  }
  return claims;
}

export function decomposeChiitoi(concealed: readonly Tile[], winKind: number, ron: boolean): Pattern[] {
  if (concealed.length !== 14) return [];
  const counts = countsByKind(concealed);
  let pairs = 0;
  let kinds = 0;
  for (let k = 0; k < 34; k++) {
    if (counts[k] > 0) kinds++;
    if (counts[k] === 2) pairs++;
    else if (counts[k] !== 0) return [];
  }
  if (pairs !== 7 || kinds !== 7) return [];
  const blocks: Block[] = [];
  for (let k = 0; k < 34; k++) if (counts[k] === 2) blocks.push({ type: "pair", kind: k });
  return [
    { kind: "chiitoi", blocks, winKind, ron, waitType: "tanki", winBlockIndex: blocks.findIndex((b) => b.kind === winKind) },
  ];
}

const KOKUSHI_KINDS: number[] = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];

export function decomposeKokushi(concealed: readonly Tile[], winKind: number, ron: boolean): Pattern[] {
  if (concealed.length !== 14) return [];
  const counts = countsByKind(concealed);
  for (let k = 0; k < 34; k++) {
    if (counts[k] === 0) continue;
    if (!KOKUSHI_KINDS.includes(k)) return [];
    if (counts[k] > 2) return [];
  }
  const distinct = KOKUSHI_KINDS.filter((k) => counts[k] > 0).length;
  const hasPair = KOKUSHI_KINDS.some((k) => counts[k] === 2);
  if (distinct === 13 && hasPair) {
    // 13 面：13 种齐全且含一对（和了张可为任意幺九字）
    const blocks: Block[] = KOKUSHI_KINDS.map((k) =>
      counts[k] === 2 ? { type: "pair" as const, kind: k } : { type: "set" as const, kind: k, kindOfSet: "triplet" as const, form: "concealed" as const },
    );
    return [{ kind: "kokushi", blocks, winKind, ron, waitType: "tanki", winBlockIndex: blocks.findIndex((b) => b.kind === winKind) }];
  }
  return [];
}

/** 全分解入口：返回所有可成立的和了形（含副露固定面子）。 */
export function decompose(concealed: readonly Tile[], melds: readonly Meld[], winKind: number, ron: boolean): Pattern[] {
  if (!concealed.every((t) => isSanmaKind(tileKind(t)))) throw new Error("non-sanma tile");
  const menzen = melds.every((m) => m.type === "ankan" || m.type === "kita");
  const out: Pattern[] = [];
  out.push(...decomposeRegular(concealed, melds, winKind, ron));
  if (menzen) {
    out.push(...decomposeChiitoi(concealed, winKind, ron));
    out.push(...decomposeKokushi(concealed, winKind, ron));
  }
  return out;
}

/** 13 张（门清部分，不含和了张）→ 听牌种类（三麻合法种类） */
export function waits(concealed13: readonly Tile[], melds: readonly Meld[] = []): number[] {
  const counts = countsByKind(concealed13);
  const result: number[] = [];
  for (const k of [0, 8, ...Array.from({ length: 9 }, (_, i) => 9 + i), ...Array.from({ length: 9 }, (_, i) => 18 + i), ...Array.from({ length: 7 }, (_, i) => 27 + i)]) {
    if (!isSanmaKind(k)) continue;
    if (counts[k] >= 4) continue;
    const tile = kindToTile(k);
    const after = [...concealed13, tile];
    if (decompose(after, melds, k, true).length > 0) result.push(k);
  }
  return result;
}

/** 是否和了形（14 张含和了张） */
export function isWinning(concealed: readonly Tile[], melds: readonly Meld[], winKind: number, ron: boolean): boolean {
  return decompose(concealed, melds, winKind, ron).length > 0;
}
