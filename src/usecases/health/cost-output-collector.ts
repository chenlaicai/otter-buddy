/**
 * CostOutputCollector: 成本/产出数据采集（Issue #583）
 *
 * 两条数据路径：
 * 1. LLMCallCollector: 解析 session JSONL → per-otter per-day token/cost 聚合
 * 2. OtterOutputCollector: 查询 messages 表 → per-otter per-day 发言计数
 *
 * 设计原则：
 * - 幂等：同日重扫产生相同结果（replaceForDate 语义）
 * - 数据边界：只取 usage/统计类字段，会话内容不入库
 * - Goodhart 防线：成本/产出只作信号不作 KPI
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";

// ── Types ──

/** 单条 session JSONL assistant message 的 usage 原始结构 */
interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/** 单条 session JSONL message 行（部分字段） */
interface SessionMessageLine {
  type: "message";
  id: string;
  timestamp: string;
  message: {
    role: string;
    model?: string;
    usage?: SessionUsage;
  };
}

/** session JSONL model_change 行 */
interface SessionModelChangeLine {
  type: "model_change";
  modelId: string;
}

/** 聚合结果：per-otter per-day per-model 的 token/cost 统计 */
export interface OtterCostRecord {
  date: string;
  otterId: string;
  otterName: string;
  otterType: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
  callCount: number;
  cacheHitRate: number;
}

/** 聚合结果：per-otter per-day 的产出计数 */
export interface OtterOutputRecord {
  date: string;
  otterId: string;
  otterName: string;
  messageCount: number;
}

// ── LLMCallCollector: 解析 session JSONL ──

/** agent_sessions 表行（用于 session → otter 映射） */
export interface AgentSessionMapping {
  piSessionId: string;
  otterId: string;
  otterName: string;
  otterType: string;
}

/** 注入的 DB 查询函数：获取 session → otter 映射 */
export type AgentSessionSource = () => Promise<AgentSessionMapping[]>;

/**
 * 从 session JSONL 目录采集 per-otter per-day per-model 的 LLM 调用成本。
 *
 * 解析逻辑：
 * 1. 每个 .jsonl 文件 = 一个 session（文件名含 pi_session_id）
 * 2. 通过 agent_sessions 表关联到 otterId/otterName
 * 3. 遍历 type=message 且 role=assistant 的行，提取 usage + model
 * 4. 按 date + otterId + model 聚合
 */
/** 解析单个 session JSONL 文件，提取 assistant 消息的 usage 记录 */
async function parseSessionFile(
  filePath: string,
  mapping: AgentSessionMapping,
): Promise<Array<OtterCostRecord & { _key: string }>> {
  const content = await readFile(filePath, "utf-8").catch(() => "");
  if (!content) return [];

  const results: Array<OtterCostRecord & { _key: string }> = [];
  let currentModel = "unknown";

  for (const line of content.split("\n").filter(Boolean)) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (obj.type === "model_change") {
      const mc = obj as unknown as SessionModelChangeLine;
      currentModel = mc.modelId ?? "unknown";
      continue;
    }

    if (obj.type !== "message") continue;
    const msg = obj as unknown as SessionMessageLine;
    if (msg.message.role !== "assistant" || !msg.message.usage) continue;

    const usage = msg.message.usage;
    const model = msg.message.model ?? currentModel;
    const date = msg.timestamp.slice(0, 10);

    results.push({
      _key: `${date}|${mapping.otterId}|${model}`,
      date,
      otterId: mapping.otterId,
      otterName: mapping.otterName,
      otterType: mapping.otterType,
      model,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      totalTokens: usage.totalTokens,
      costInput: usage.cost.input,
      costOutput: usage.cost.output,
      costCacheRead: usage.cost.cacheRead,
      costCacheWrite: usage.cost.cacheWrite,
      costTotal: usage.cost.total,
      callCount: 1,
      cacheHitRate: 0,
    });
  }
  return results;
}

/** 按 key 聚合并计算 cache hit rate */
function aggregateUsageRecords(
  records: Array<OtterCostRecord & { _key: string }>,
): OtterCostRecord[] {
  const aggregate = new Map<string, OtterCostRecord>();
  for (const rec of records) {
    const existing = aggregate.get(rec._key);
    if (existing) {
      existing.inputTokens += rec.inputTokens;
      existing.outputTokens += rec.outputTokens;
      existing.cacheReadTokens += rec.cacheReadTokens;
      existing.cacheWriteTokens += rec.cacheWriteTokens;
      existing.totalTokens += rec.totalTokens;
      existing.costInput += rec.costInput;
      existing.costOutput += rec.costOutput;
      existing.costCacheRead += rec.costCacheRead;
      existing.costCacheWrite += rec.costCacheWrite;
      existing.costTotal += rec.costTotal;
      existing.callCount += rec.callCount;
    } else {
      const { _key, ...rest } = rec;
      aggregate.set(_key, rest);
    }
  }
  for (const record of aggregate.values()) {
    const denom = record.cacheReadTokens + record.inputTokens;
    record.cacheHitRate = denom > 0 ? record.cacheReadTokens / denom : 0;
  }
  return [...aggregate.values()];
}

export async function collectLlmCalls(
  sessionsDir: string,
  agentSessionSource: AgentSessionSource,
  options?: { since?: string },
): Promise<OtterCostRecord[]> {
  const mappings = await agentSessionSource();
  const mappingBySession = new Map(mappings.map(m => [m.piSessionId, m]));

  let files: string[];
  try {
    files = (await readdir(sessionsDir)).filter(f => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  if (options?.since) {
    const sincePrefix = options.since.slice(0, 10);
    files = files.filter(f => f.slice(0, 10) >= sincePrefix);
  }

  const allRecords: Array<OtterCostRecord & { _key: string }> = [];
  for (const file of files) {
    const sessionId = file.replace(/\.jsonl$/, "").split("_").pop() ?? "";
    const mapping = mappingBySession.get(sessionId);
    if (!mapping) continue;
    const records = await parseSessionFile(join(sessionsDir, file), mapping);
    allRecords.push(...records);
  }

  return aggregateUsageRecords(allRecords);
}

// ── OtterOutputCollector: 查询 messages 表 ──

/**
 * 从 messages 表采集 per-otter per-day 的发言计数。
 *
 * v1 口径：sender_type='otter' 的消息按 sender_id + date 聚合。
 * sender_id 即 otter_id，join otters 表取名字。
 */
export function collectOtterOutput(
  db: Database.Database,
  options?: { since?: string },
): OtterOutputRecord[] {
  const since = options?.since ?? new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT
      DATE(m.created_at) AS date,
      m.sender_id AS otterId,
      COALESCE(o.name, m.sender_name, m.sender_id) AS otterName,
      COUNT(*) AS messageCount
    FROM messages m
    LEFT JOIN otters o ON o.id = m.sender_id
    WHERE m.sender_type = 'otter'
      AND DATE(m.created_at) >= ?
    GROUP BY DATE(m.created_at), m.sender_id
    ORDER BY date, otterId
  `).all(since) as Array<{ date: string; otterId: string; otterName: string; messageCount: number }>;

  return rows.map(r => ({
    date: r.date,
    otterId: r.otterId,
    otterName: r.otterName,
    messageCount: Number(r.messageCount),
  }));
}
