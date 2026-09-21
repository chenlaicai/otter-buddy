/**
 * F20260921otcl：出生挑色纯函数（单一算法，两处消费）。
 *
 * 消费方：CreateOtter usecase（实时出生分配）+ db/migration 存量回填。
 * 放 entities 层的理由：migration（frameworks）与 usecase 都能依赖 entities，
 * 且算法不依赖 DB / api-contract——色板 key 数组作为参数传入（entities 不 import
 * 契约层，保持依赖方向：entities ← usecases/frameworks ← api-contract 值经参数注入）。
 *
 * 规则（方案 §3）：
 * 1. 从色板挑第一个未占用 key
 * 2. 8 色全占用时挑占用数最少的——并列时取色板数组中 index 最小者（确定性
 *    tie-breaking，保证迁移回填与实时分配行为一致）
 */

/** 占用集：色板 key → 已占用数（对话内 active/在场獭的出生色计数） */
export type OtterColorOccupancy = Map<string, number>;

/**
 * 挑一个对话内未占用的色板 key。
 * @param paletteKeyOrder 色板 key 有序数组（api-contract OTTER_PALETTE_KEYS 注入）
 * @param occupied 该对话的占用集（只读——本函数不落账；调用方在色落定后自行累加，见 CreateOtter 与回填迁移）
 */
export function pickOtterColor(paletteKeyOrder: readonly string[], occupied: OtterColorOccupancy): string {
  // 1. 第一个未占用
  for (const key of paletteKeyOrder) {
    if (!occupied.has(key)) return key;
  }
  // 2. 全占用：占用数最少，并列取 index 最小（顺序遍历 + 严格小于比较天然实现）
  let best = paletteKeyOrder[0];
  let bestCount = occupied.get(best) ?? 0;
  for (const key of paletteKeyOrder) {
    const count = occupied.get(key) ?? 0;
    if (count < bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}
