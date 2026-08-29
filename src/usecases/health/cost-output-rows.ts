/**
 * CostOutputRows: cost_output 快照行构建（Issue #583）
 *
 * 将 LLMCallCollector 和 OtterOutputCollector 的采集结果转为
 * health_snapshots 表的 CreateSnapshotRow 格式。
 *
 * metric_type = "cost_output"，metric_key 为指标名，metadata 含 otter 标识。
 * 同一 snapshotDate 的所有行一次 replaceForDate 写入（幂等）。
 *
 * 数据边界：usage/统计类字段入库，会话内容不入库。
 * Goodhart 防线：成本/产出只作信号不作 KPI——行内不含任何排名/评分/百分位。
 */

import type { OtterCostRecord, OtterOutputRecord } from "./cost-output-collector";

/** 与 HealthSnapshotRepository.CreateHealthSnapshot 同构 */
export interface CreateCostOutputRow {
  snapshotDate: string;
  metricType: string;
  metricKey: string;
  metricValue: number;
  metadata?: string;
}

/** metadata 中的 otter 标识（per-otter per-model 行用） */
interface OtterMeta {
  otterId: string;
  otterName: string;
  otterType?: string;
  model?: string;
}

/** 标准指标键清单（metric_key 值） */
export const COST_OUTPUT_KEYS = {
  INPUT_TOKENS: "input_tokens",
  OUTPUT_TOKENS: "output_tokens",
  CACHE_READ_TOKENS: "cache_read_tokens",
  CACHE_WRITE_TOKENS: "cache_write_tokens",
  TOTAL_TOKENS: "total_tokens",
  COST_INPUT: "cost_input",
  COST_OUTPUT: "cost_output",
  COST_CACHE_READ: "cost_cache_read",
  COST_CACHE_WRITE: "cost_cache_write",
  COST_TOTAL: "cost_total",
  LLM_CALL_COUNT: "llm_call_count",
  CACHE_HIT_RATE: "cache_hit_rate",
  MESSAGE_COUNT: "message_count",
} as const;

/**
 * 构建 cost_output 快照行集。
 *
 * 每条 OtterCostRecord 生成 12 行（12 个指标键），
 * 每条 OtterOutputRecord 生成 1 行（message_count），
 * 按 OtterOutputRecord 匹配的 cost 记录不再重复生成 message_count（避免覆盖）。
 */
export function buildCostOutputSnapshotRows(
  snapshotDate: string,
  costRecords: OtterCostRecord[],
  outputRecords: OtterOutputRecord[],
): CreateCostOutputRow[] {
  const rows: CreateCostOutputRow[] = [];

  // 1. Per-otter per-model cost 行
  for (const rec of costRecords) {
    const meta: OtterMeta = {
      otterId: rec.otterId,
      otterName: rec.otterName,
      otterType: rec.otterType,
      model: rec.model,
    };
    const metaStr = JSON.stringify(meta);

    rows.push(
      makeRow(snapshotDate, COST_OUTPUT_KEYS.INPUT_TOKENS, rec.inputTokens, metaStr),
      makeRow(snapshotDate, COST_OUTPUT_KEYS.OUTPUT_TOKENS, rec.outputTokens, metaStr),
      makeRow(snapshotDate, COST_OUTPUT_KEYS.CACHE_READ_TOKENS, rec.cacheReadTokens, metaStr),
      makeRow(snapshotDate, COST_OUTPUT_KEYS.CACHE_WRITE_TOKENS, rec.cacheWriteTokens, metaStr),
      makeRow(snapshotDate, COST_OUTPUT_KEYS.TOTAL_TOKENS, rec.totalTokens, metaStr),
      makeRow(snapshotDate, COST_OUTPUT_KEYS.COST_INPUT, rec.costInput, metaStr),
      makeRow(snapshotDate, COST_OUTPUT_KEYS.COST_OUTPUT, rec.costOutput, metaStr),
      makeRow(snapshotDate, COST_OUTPUT_KEYS.COST_CACHE_READ, rec.costCacheRead, metaStr),
      makeRow(snapshotDate, COST_OUTPUT_KEYS.COST_CACHE_WRITE, rec.costCacheWrite, metaStr),
      makeRow(snapshotDate, COST_OUTPUT_KEYS.COST_TOTAL, rec.costTotal, metaStr),
      makeRow(snapshotDate, COST_OUTPUT_KEYS.LLM_CALL_COUNT, rec.callCount, metaStr),
      makeRow(snapshotDate, COST_OUTPUT_KEYS.CACHE_HIT_RATE, rec.cacheHitRate, metaStr),
    );
  }

  // 2. Per-otter output 行（message_count）
  for (const rec of outputRecords) {
    const meta: OtterMeta = { otterId: rec.otterId, otterName: rec.otterName };
    rows.push(
      makeRow(snapshotDate, COST_OUTPUT_KEYS.MESSAGE_COUNT, rec.messageCount, JSON.stringify(meta)),
    );
  }

  return rows;
}

function makeRow(
  snapshotDate: string,
  metricKey: string,
  metricValue: number,
  metadata: string,
): CreateCostOutputRow {
  return { snapshotDate, metricType: "cost_output", metricKey, metricValue, metadata };
}
