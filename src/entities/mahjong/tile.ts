/**
 * 三麻牌模型——雀魂三麻口径：
 * - 全牌 108 张：万子仅 1/9（2~8 万移除），筒索各 36，字牌 28
 * - 赤五：筒/索各 1 张赤（雀魂三麻有赤 5 筒/5 索），5 万不存在故无赤 5 万
 * - 记谱沿用日麻惯例：'123m456p789s11z'，'0' 表示赤五（如 '05p' = 赤5筒+5筒）
 */

export type Suit = "m" | "p" | "s" | "z";

export interface Tile {
  readonly suit: Suit;
  /** m/p/s: 1-9；z: 1-7（东1 南2 西3 北4 白5 发6 中7） */
  readonly rank: number;
  /** 赤五标记（仅 5p/5s 可为 true） */
  readonly aka: boolean;
}

/** 字牌花色数；34 种类索引：m0-8 p9-17 s18-26 z27-33 */
export const SUIT_OFFSET: Record<Suit, number> = { m: 0, p: 9, s: 18, z: 27 };

/** 三麻合法种类集合（27 种）：1m9m + 1-9p + 1-9s + 1-7z */
export const SANMA_KINDS: readonly number[] = (() => {
  const kinds: number[] = [];
  for (let r = 1; r <= 9; r++) if (r === 1 || r === 9) kinds.push(SUIT_OFFSET.m + r - 1);
  for (let r = 1; r <= 9; r++) kinds.push(SUIT_OFFSET.p + r - 1);
  for (let r = 1; r <= 9; r++) kinds.push(SUIT_OFFSET.s + r - 1);
  for (let r = 1; r <= 7; r++) kinds.push(SUIT_OFFSET.z + r - 1);
  return kinds;
})();

const SANMA_KIND_SET = new Set(SANMA_KINDS);

/** 三麻全牌张数：108 */
export const SANMA_TILE_TOTAL = 108;

/** 牌 → 34 种类索引 */
export function tileKind(tile: Tile): number {
  return SUIT_OFFSET[tile.suit] + tile.rank - 1;
}

/** 种类索引 → 规范牌（aka=false） */
export function kindToTile(kind: number): Tile {
  if (kind < 0 || kind > 33) throw new Error(`invalid kind: ${kind}`);
  const suit = (["m", "p", "s", "z"] as Suit[]).find((s) => kind - SUIT_OFFSET[s] >= 0 && kind - SUIT_OFFSET[s] <= (s === "z" ? 6 : 8));
  if (!suit) throw new Error(`invalid kind: ${kind}`);
  return { suit, rank: kind - SUIT_OFFSET[suit] + 1, aka: false };
}

/** 该种类在三麻是否存在（2~8 万为 false） */
export function isSanmaKind(kind: number): boolean {
  return SANMA_KIND_SET.has(kind);
}

/** 幺九字（1/9 与字牌）——符数/断幺判定共用 */
export function isYaochuKind(kind: number): boolean {
  const { rank, suit } = kindToTile(kind);
  return suit === "z" || rank === 1 || rank === 9;
}

/** 解析记谱。'0p'/'0s' = 赤五；'0m' 非法（5 万不存在）；未知/移除牌抛错。 */
export function parseTiles(notation: string): Tile[] {
  const tiles: Tile[] = [];
  const re = /([1-90]+)([mpsz])/g;
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(notation)) !== null) {
    consumed += m[0].length;
    const digits = m[1];
    const suit = m[2] as Suit;
    for (const ch of digits) {
      if (ch === "0") {
        if (suit === "m" || suit === "z") throw new Error(`aka not allowed for ${suit}: ${notation}`);
        tiles.push({ suit, rank: 5, aka: true });
        continue;
      }
      const rank = Number(ch);
      const tile: Tile = { suit, rank, aka: false };
      if (!isSanmaKind(tileKind(tile))) throw new Error(`tile not in sanma set: ${ch}${suit}`);
      tiles.push(tile);
    }
  }
  if (consumed !== notation.length) throw new Error(`invalid notation: ${notation}`);
  return tiles;
}

/** 牌排序键：种类升序、赤五排在普通五之后（同种类内普通 < 赤，与雀魂展示无关仅保稳定） */
export function tileSortKey(tile: Tile): number {
  return tileKind(tile) * 2 + (tile.aka ? 1 : 0);
}

export function sortTiles(tiles: Tile[]): Tile[] {
  return [...tiles].sort((a, b) => tileSortKey(a) - tileSortKey(b));
}

/** 记谱输出（排序后紧凑格式；赤五以 '0' 表示） */
export function formatTiles(tiles: Tile[]): string {
  const sorted = sortTiles(tiles);
  let out = "";
  for (const suit of ["m", "p", "s", "z"] as Suit[]) {
    const group = sorted.filter((t) => t.suit === suit);
    if (group.length === 0) continue;
    out += group.map((t) => (t.aka && t.rank === 5 ? "0" : String(t.rank))).join("") + suit;
  }
  return out;
}

/** 34 长度计数数组（index = tileKind） */
export function countsByKind(tiles: readonly Tile[]): number[] {
  const counts = new Array<number>(34).fill(0);
  for (const t of tiles) counts[tileKind(t)]++;
  return counts;
}

/** 构造三麻完整牌山（108 张；5p/5s 各含 1 张赤五）。 */
export function buildSanmaWall(): Tile[] {
  const wall: Tile[] = [];
  for (const kind of SANMA_KINDS) {
    const base = kindToTile(kind);
    const copyCount = 4;
    for (let i = 0; i < copyCount; i++) {
      const isAkaSlot =
        base.rank === 5 && (base.suit === "p" || base.suit === "s") && i === 0;
      wall.push({ ...base, aka: isAkaSlot });
    }
  }
  return wall;
}

/** 宝牌指示牌 → 宝牌种类（幺九字回转：9m→1m、7z→1z） */
export function doraKindFromIndicator(indicatorKind: number): number {
  const tile = kindToTile(indicatorKind);
  if (tile.suit === "z") {
    return SUIT_OFFSET.z + (tile.rank % 7); // 7→1
  }
  if (tile.rank === 9) return SUIT_OFFSET[tile.suit]; // 9→1
  return indicatorKind + 1;
}
