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

/** SessionStats is cumulative. A lower counter means a session reset, not negative consumption. */
export function diffTokenUsage(before: TokenUsage, after: TokenUsage): TokenUsage {
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
