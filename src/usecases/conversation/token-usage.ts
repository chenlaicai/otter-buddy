/** Four SDK token counters. Snapshot and per-invoke delta share this shape, never its semantics. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const keys = ["input", "output", "cacheRead", "cacheWrite"] as const;

function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function isFiniteNumber(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value);
}
/** SessionStats is cumulative. A lower counter means a session reset, not negative consumption.
 *  F20261026ctbg（审视发现 4）：after 四分量全非有限数 = telemetry 缺失，返回 undefined 而非
 *  显式零对象——缺失不得冒充「显式零增量」的语义停滞证据（停滞判定只认有数字的 0，
 *  缺失由 hard depth 兜底）。部分缺失（如 Pi 历史的空 cache 列）不算全缺失，照常差分。 */
export function diffTokenUsage(before: TokenUsage, after: TokenUsage): TokenUsage | undefined {
  if (!keys.some(key => isFiniteNumber(after[key]))) return undefined;
  const delta: TokenUsage = { input: 0, output: 0 };
  for (const key of keys) {
    const current = finite(after[key]);
    delta[key] = current >= finite(before[key]) ? current - finite(before[key]) : current;
  }
  return delta;
}

/** Recursive retries/self-restarts belong to one logical chain invocation; add their deltas once. */
export function addTokenUsage(a?: TokenUsage, b?: TokenUsage): TokenUsage | undefined {
  if (!a && !b) return undefined;
  const total: TokenUsage = { input: 0, output: 0 };
  for (const key of keys) total[key] = finite(a?.[key]) + finite(b?.[key]);
  return total;
}

export function totalTokenUsage(usage: TokenUsage): number {
  return keys.reduce((total, key) => total + finite(usage[key]), 0);
}
