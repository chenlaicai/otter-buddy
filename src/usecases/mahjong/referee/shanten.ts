/**
 * 向听数（三麻适配：万子无 2-8，算法按 34 种类计数天然兼容）
 * - 标准形：8 - 2×面子 - 塔子 - 雀头（约束：面子+塔子 ≤ 4）
 * - 七对：6 - 对子数 + max(0, 7 - 种类数)
 * - 国士：13 - 幺九字种类数 - (含对子 ? 1 : 0)
 */

import { countsByKind, isSanmaKind, tileKind, type Tile } from "../../../entities/mahjong/tile";

export interface ShantenResult {
  /** 三型最小向听（-1 = 和了形） */
  readonly min: number;
  readonly regular: number;
  readonly chiitoi: number;
  readonly kokushi: number;
}

interface Best {
  v: number; // 2A + B + C 最大值
}

// eslint-disable-next-line max-lines-per-function, max-params, max-statements, complexity -- 向听 DFS：刻子/顺子/对子/搭子/跳过五分支 + 计数回溯必须同函数闭合；参数为搜索状态（固定副露数参与剪枝），拆参会破坏回溯不变量
function dfsRegular(
  counts: number[],
  kind: number,
  sets: number,
  partials: number,
  pair: number,
  best: Best,
  fixedSets: number,
): void {
  while (kind < 34 && counts[kind] === 0) kind++;
  if (kind === 34) {
    const score = 2 * (sets + fixedSets) + partials + pair;
    if (score > best.v) best.v = score;
    return;
  }

  const take = (k: number, n: number) => {
    counts[k] -= n;
  };
  const put = (k: number, n: number) => {
    counts[k] += n;
  };

  // 刻子（约束：面子+塔子 ≤ 4）
  if (counts[kind] >= 3 && sets + fixedSets + partials < 4) {
    take(kind, 3);
    dfsRegular(counts, kind, sets + 1, partials, pair, best, fixedSets);
    put(kind, 3);
  }
  // 顺子（仅 m/p/s 且 rank≤7；三麻中万子因无 2-8 自然不可成顺）
  const rank = (kind % 9) + 1;
  if (kind < 27 && rank <= 7 && counts[kind + 1] > 0 && counts[kind + 2] > 0 && sets + fixedSets + partials < 4) {
    take(kind, 1);
    take(kind + 1, 1);
    take(kind + 2, 1);
    dfsRegular(counts, kind, sets + 1, partials, pair, best, fixedSets);
    put(kind, 1);
    put(kind + 1, 1);
    put(kind + 2, 1);
  }
  // 对子：作雀头（仅一次）
  if (counts[kind] >= 2 && pair === 0) {
    take(kind, 2);
    dfsRegular(counts, kind, sets, partials, 1, best, fixedSets);
    put(kind, 2);
  }
  // 对子：作塔子（对碰/单骑材料）
  if (counts[kind] >= 2 && sets + fixedSets + partials < 4) {
    take(kind, 2);
    dfsRegular(counts, kind, sets, partials + 1, pair, best, fixedSets);
    put(kind, 2);
  }
  // 搭子：两面/嵌张（含边张形）
  if (kind < 27 && sets + fixedSets + partials < 4) {
    if (rank <= 8 && counts[kind + 1] > 0) {
      take(kind, 1);
      take(kind + 1, 1);
      dfsRegular(counts, kind, sets, partials + 1, pair, best, fixedSets);
      put(kind, 1);
      put(kind + 1, 1);
    }
    if (rank <= 7 && rank >= 2 && counts[kind + 2] > 0) {
      take(kind, 1);
      take(kind + 2, 1);
      dfsRegular(counts, kind, sets, partials + 1, pair, best, fixedSets);
      put(kind, 1);
      put(kind + 2, 1);
    }
  }

  // 跳过当前种类
  const remain = counts[kind];
  counts[kind] = 0;
  dfsRegular(counts, kind + 1, sets, partials, pair, best, fixedSets);
  counts[kind] = remain;
}

export function regularShanten(counts: number[], fixedSets: number): number {
  const best: Best = { v: -100 };
  dfsRegular([...counts], 0, 0, 0, 0, best, fixedSets);
  const n = 8 - best.v;
  return n < -1 ? -1 : n;
}

export function chiitoiShanten(counts: number[]): number {
  let pairs = 0;
  let kinds = 0;
  for (let k = 0; k < 34; k++) {
    if (counts[k] > 0) kinds++;
    if (counts[k] >= 2) pairs++;
    if (counts[k] >= 4) pairs++; // 4 张算两对
  }
  const s = 6 - pairs + Math.max(0, 7 - kinds);
  return s < -1 ? -1 : s;
}

export function kokushiShanten(counts: number[]): number {
  let types = 0;
  let hasPair = 0;
  for (let k = 0; k < 34; k++) {
    const isYaochu = k >= 27 || k % 9 === 0 || k % 9 === 8;
    if (!isYaochu) continue;
    if (counts[k] > 0) types++;
    if (counts[k] >= 2) hasPair = 1;
  }
  return 13 - types - hasPair;
}

/** 向听数计算入口。concealed 不含副露；fixedMelds = 副露面子数（碰/杠）。 */
export function shanten(concealed: readonly Tile[], fixedMelds = 0): ShantenResult {
  const counts = countsByKind(concealed);
  if (!concealed.every((t) => isSanmaKind(tileKind(t)))) {
    throw new Error("non-sanma tile in hand");
  }
  const regular = regularShanten(counts, fixedMelds);
  // 七对/国士仅在门清 0 副露时可能
  const chiitoi = fixedMelds === 0 ? chiitoiShanten(counts) : 99;
  const kokushi = fixedMelds === 0 ? kokushiShanten(counts) : 99;
  const min = Math.min(regular, chiitoi, kokushi);
  return { min, regular, chiitoi, kokushi };
}
