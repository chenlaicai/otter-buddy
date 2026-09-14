/**
 * InvokeStatsCollector: 单次问答均值采集（F20260914usgm，从 cost-output-collector 拆出守 max-lines）。
 *
 * 数据源 invokes 表。token 口径：invokes.token_usage_* 是 session 累计快照，
 * 按 otter_id + started_at 升序相邻差分（首条/回退取全量）——与 agent-metrics.ts 同模式。
 * 分组：per-day per-model（metadata.model，无则 "unknown"）+ per-day 全模型合计（"_total"）。
 */

import type Database from "better-sqlite3";

/** per-day（全或按 model）的单次问答均值记录 */
export interface InvokeStatsRecord {
  date: string;
  /** 模型名；"_total" 为全模型合计行 */
  model: string;
  invokeCount: number;
  /** 平均每次 invoke 工具调用数 */
  avgToolCalls: number;
  /** 平均每次 invoke 耗时（秒） */
  avgDurationSec: number;
  /** 平均每次 invoke 输入 token（session 累计差分后） */
  avgInputTokens: number;
  /** 平均每次 invoke 输出 token（session 累计差分后） */
  avgOutputTokens: number;
}

interface InvokeStatsRow {
  otter_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  tool_call_count: number;
  token_usage_input: number | null;
  token_usage_output: number | null;
  metadata: string | null;
}

/**
 * 从 invokes 表采集 per-day 单次问答均值（F20260914usgm）。
 *
 * token 口径：invokes.token_usage_* 是 session 累计快照（同 session 前一次 invoke 的
 * 基线之上的累计值）。此处按 otter_id + started_at 升序做相邻差分：首条取全量、
 * 回退（新 session）取全量、增量取差值——与 agent-metrics.ts 差分逻辑同模式。
 * 差分结果 sum 后除以有 token 值的 invoke 数（无值行不进均值分母）。
 *
 * 分组：per-day per-model（model 从 metadata.model 取，无则 "unknown"）+ per-day 全模型合计（"_total"）。
 * 耗时分母：有 ended_at 的行；均值不含 running/无终态行。
 */
/** collectInvokeStats 内部累加器 */
interface InvokeStatsAcc {
  invokeCount: number;
  toolCalls: number;
  durationSec: number;
  durationCount: number;
  inputTokens: number;
  outputTokens: number;
  tokenCount: number;
}

/** 从 metadata JSON 提取 model，无则 "unknown"（与 buildModelBreakdown 同口径） */
function extractModelFromMetadata(metadata: string | null): string {
  if (!metadata) return "unknown";
  try {
    const meta = JSON.parse(metadata) as { model?: string };
    return meta.model ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** 单维度差分：cur 相对 last 的增量；cur 回退（新 session）取全量 */
function diffOne(cur: number | null, last: number | undefined): number | null {
  if (cur === null) return null;
  return last !== undefined && cur >= last ? cur - last : cur;
}

/** token 差分（per-otter 时序）：返回增量（无值为 null）；同步更新基线 */
function diffTokenUsage(
  lastSnapshot: Map<string, { input: number; output: number }>,
  row: InvokeStatsRow,
): { dInput: number | null; dOutput: number | null } {
  const last = lastSnapshot.get(row.otter_id);
  const dInput = diffOne(row.token_usage_input, last?.input);
  const dOutput = diffOne(row.token_usage_output, last?.output);
  if (row.token_usage_input !== null || row.token_usage_output !== null) {
    lastSnapshot.set(row.otter_id, {
      input: row.token_usage_input ?? last?.input ?? 0,
      output: row.token_usage_output ?? last?.output ?? 0,
    });
  }
  return { dInput, dOutput };
}

export function collectInvokeStats(
  db: Database.Database,
  options?: { since?: string },
): InvokeStatsRecord[] {
  const since = options?.since ?? new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT otter_id, status, started_at, ended_at, tool_call_count,
           token_usage_input, token_usage_output, metadata
    FROM invokes
    WHERE DATE(started_at) >= ?
    ORDER BY otter_id, started_at ASC
  `).all(since) as InvokeStatsRow[];

  // otterId → 上一次 invoke 的累计快照（差分基线）
  const lastSnapshot = new Map<string, { input: number; output: number }>();
  const acc = new Map<string, InvokeStatsAcc>();
  const getAcc = (key: string): InvokeStatsAcc => {
    let a = acc.get(key);
    if (!a) {
      a = { invokeCount: 0, toolCalls: 0, durationSec: 0, durationCount: 0, inputTokens: 0, outputTokens: 0, tokenCount: 0 };
      acc.set(key, a);
    }
    return a;
  };

  for (const row of rows) {
    const date = row.started_at.slice(0, 10);
    const model = extractModelFromMetadata(row.metadata);
    const { dInput, dOutput } = diffTokenUsage(lastSnapshot, row);
    // 耗时（有终态的行才进均值）
    const durationSec = row.ended_at
      ? (new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) / 1000
      : null;

    for (const modelKey of [model, "_total"]) {
      const a = getAcc(`${date}|${modelKey}`);
      a.invokeCount += 1;
      a.toolCalls += row.tool_call_count;
      if (durationSec !== null) {
        a.durationSec += durationSec;
        a.durationCount += 1;
      }
      if (dInput !== null || dOutput !== null) {
        a.inputTokens += dInput ?? 0;
        a.outputTokens += dOutput ?? 0;
        a.tokenCount += 1;
      }
    }
  }

  return [...acc.entries()].map(formatInvokeStatsAcc);
}

/** 累加器 → InvokeStatsRecord */
function formatInvokeStatsAcc([key, a]: [string, InvokeStatsAcc]): InvokeStatsRecord {
  const [date, model] = key.split("|");
  return {
    date,
    model,
    invokeCount: a.invokeCount,
    avgToolCalls: Number((a.toolCalls / a.invokeCount).toFixed(1)),
    avgDurationSec: a.durationCount > 0 ? Number((a.durationSec / a.durationCount).toFixed(1)) : 0,
    avgInputTokens: a.tokenCount > 0 ? Math.round(a.inputTokens / a.tokenCount) : 0,
    avgOutputTokens: a.tokenCount > 0 ? Math.round(a.outputTokens / a.tokenCount) : 0,
  };
}

