/**
 * CostOutputCollector: 成本/产出数据采集（Issue #583）
 *
 * 三条数据路径：
 * 1. LLMCallCollector: 解析 session JSONL → per-otter per-day token/cost 聚合
 * 2. OtterOutputCollector: 查询 messages 表 → per-otter per-day 发言计数
 * 3. PR/文档计数器: git log → per-date PR 数；docs/features/ → per-date F 文档数
 *
 * 设计原则：
 * - 幂等：同日重扫产生相同结果（replaceForDate 语义）
 * - 数据边界：只取 usage/统计类字段，会话内容不入库
 * - Goodhart 防线：成本/产出只作信号不作 KPI
 *
 * F20260829cstd 审视修复：
 * - Finding 2: 行内 otterId 提取（不再依赖 agent_sessions 表单一映射）
 * - Finding 3: 行级 timestamp 归属（不再按文件名前缀过滤跨日数据）
 * - Scope: 新增工具调用计数（tool_call_count）
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";

const execFileAsync = promisify(execFile);

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
    stopReason?: string;
    content?: Array<{ type: string; [k: string]: unknown }>;
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
  /** stopReason=error 的调用数（F20260914usgm：模型失败次数） */
  errorCalls: number;
  // cacheHitRate 字段已删（#602）：不再单独写入快照，消费端从 cacheReadTokens/inputTokens 推导
}

/** 聚合结果：per-otter per-day 的产出计数 */
export interface OtterOutputRecord {
  date: string;
  otterId: string;
  otterName: string;
  messageCount: number;
  toolCallCount: number;
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

/** 从 JSONL 文件内容解析的 otter 身份信息 */
interface OtterIdentity {
  otterId: string;
  otterName: string;
  otterType: string;
}

/**
 * 从第一个 user message 的 system prompt 中提取 otterId/otterName/otterType。
 */
function parseOtterIdentityFromContent(
  content: Array<{ type: string; [k: string]: unknown }>,
): OtterIdentity | null {
  for (const block of content) {
    if (block.type !== "text") continue;
    const text = block.text as string;
    if (!text) continue;

    const idMatch = text.match(/ID[：:]+\s*([a-z0-9-]{3,36})/);
    const nameMatch = text.match(/名称[：:]\s*(.+)/);
    const typeMatch = text.match(/类型[：:]\s*(\S+)/);

    if (idMatch) {
      return {
        otterId: idMatch[1],
        otterName: nameMatch ? nameMatch[1].trim() : "unknown",
        otterType: typeMatch ? typeMatch[1] : "unknown",
      };
    }
  }
  return null;
}

/** 从 session ID 找映射，或从文件内容提取 otter 身份 */
async function resolveOtterIdentity(
  sessionId: string,
  mappingBySession: Map<string, AgentSessionMapping>,
  filePath: string,
): Promise<OtterIdentity> {
  const mapping = mappingBySession.get(sessionId);
  if (mapping) {
    return { otterId: mapping.otterId, otterName: mapping.otterName, otterType: mapping.otterType };
  }
  return extractIdentityFromFile(filePath);
}

/** 从文件第一个 user message 提取 otter 身份 */
async function extractIdentityFromFile(filePath: string): Promise<OtterIdentity> {
  const fileContent = await readFile(filePath, "utf-8").catch(() => "");
  if (!fileContent) return UNKNOWN_IDENTITY;

  for (const line of fileContent.split("\n").filter(Boolean)) {
    const identity = tryExtractIdentityFromLine(line);
    if (identity) return identity;
  }
  return UNKNOWN_IDENTITY;
}

/** 尝试从单行 JSON 提取 otter 身份（仅 user message） */
function tryExtractIdentityFromLine(line: string): OtterIdentity | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.type !== "message") return null;
    const msg = obj as unknown as SessionMessageLine;
    if (msg.message.role !== "user" || !Array.isArray(msg.message.content)) return null;
    return parseOtterIdentityFromContent(msg.message.content);
  } catch {
    return null;
  }
}

const UNKNOWN_IDENTITY: OtterIdentity = { otterId: "unknown", otterName: "unknown", otterType: "unknown" };

/** 从文件名提取 session ID */
function extractSessionId(fileName: string): string {
  return fileName.replace(/\.jsonl$/, "").split("_").pop() ?? "";
}

/** 从文件名提取 session 开始日期（粗筛用） */
function extractFileDate(fileName: string): string {
  return fileName.slice(0, 10);
}

/** 读取 JSONL 文件，按消息 timestamp 过滤，提取 assistant 消息数据 */
async function parseSessionFile(
  filePath: string,
  otterIdentity: OtterIdentity,
  sinceDate?: string,
): Promise<{ costRecords: Array<OtterCostRecord & { _key: string }>; toolCallCount: number }> {
  const content = await readFile(filePath, "utf-8").catch(() => "");
  if (!content) return { costRecords: [], toolCallCount: 0 };

  const costRecords: Array<OtterCostRecord & { _key: string }> = [];
  let toolCallCount = 0;
  let currentModel = "unknown";

  for (const line of content.split("\n").filter(Boolean)) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (obj.type === "model_change") {
      currentModel = (obj as unknown as SessionModelChangeLine).modelId ?? "unknown";
      continue;
    }
    if (obj.type !== "message") continue;

    const msg = obj as unknown as SessionMessageLine;
    if (msg.message.role !== "assistant") continue;

    const date = msg.timestamp.slice(0, 10);
    if (sinceDate && date < sinceDate) continue;

    toolCallCount += countToolCalls(msg.message.content);
    if (!msg.message.usage) continue;

    costRecords.push(buildCostRecord(
      date, otterIdentity,
      msg.message.model ?? currentModel, msg.message.usage,
      msg.message.stopReason === "error",
    ));
  }
  return { costRecords, toolCallCount };
}

/** 统计 content 中 toolCall block 数 */
function countToolCalls(content?: Array<{ type: string; [k: string]: unknown }>): number {
  if (!Array.isArray(content)) return 0;
  return content.filter(b => b.type === "toolCall").length;
}

/** 构建单条 cost 记录 */
function buildCostRecord(
  date: string,
  identity: OtterIdentity,
  model: string,
  usage: SessionUsage,
  isError: boolean,
): OtterCostRecord & { _key: string } {
  return {
    _key: `${date}|${identity.otterId}|${model}`,
    date,
    otterId: identity.otterId,
    otterName: identity.otterName,
    otterType: identity.otterType,
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
    errorCalls: isError ? 1 : 0,
  };
}

/** 按 key 聚合（per-otter per-day per-model）。
 *  cacheHitRate 不再计算（#602）：消费端统一从 cacheReadTokens+inputTokens 推导。 */
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
      existing.errorCalls += rec.errorCalls;
    } else {
      const { _key, ...rest } = rec;
      aggregate.set(_key, rest);
    }
  }
  return [...aggregate.values()];
}

/** 加载 JSONL 文件列表，按 since 日期粗筛 */
async function listSessionFiles(sessionsDir: string, since?: string): Promise<string[]> {
  let files: string[];
  try {
    files = (await readdir(sessionsDir)).filter(f => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  if (!since) return files;

  // 放宽 2 天以覆盖跨日 session
  const sinceDate = new Date(since.slice(0, 10));
  sinceDate.setDate(sinceDate.getDate() - 2);
  const fileFilterDate = sinceDate.toISOString().slice(0, 10);
  return files.filter(f => extractFileDate(f) >= fileFilterDate);
}

export async function collectLlmCalls(
  sessionsDir: string,
  agentSessionSource: AgentSessionSource,
  options?: { since?: string },
): Promise<OtterCostRecord[]> {
  const mappings = await agentSessionSource();
  const mappingBySession = new Map(mappings.map(m => [m.piSessionId, m]));
  const files = await listSessionFiles(sessionsDir, options?.since);
  const allCostRecords: Array<OtterCostRecord & { _key: string }> = [];

  const unknownSessions: string[] = [];
  for (const file of files) {
    const sessionId = extractSessionId(file);
    const identity = await resolveOtterIdentity(sessionId, mappingBySession, join(sessionsDir, file));
    if (identity === UNKNOWN_IDENTITY) unknownSessions.push(sessionId);
    const { costRecords } = await parseSessionFile(
      join(sessionsDir, file),
      identity,
      options?.since?.slice(0, 10),
    );
    allCostRecords.push(...costRecords);
  }

  if (unknownSessions.length > 0) {
    console.warn(
      `[cost-output] ${unknownSessions.length} session(s) could not be mapped to otter ` +
      `(not in agent_sessions, no parseable identity in file). ` +
      `Token usage attributed to 'unknown' bucket. Sample IDs: ${unknownSessions.slice(0, 5).join(", ")}`,
    );
  }

  return aggregateUsageRecords(allCostRecords);
}

// ── OtterOutputCollector: 查询 messages 表 + session JSONL 工具调用 ──

/**
 * 从 messages 表采集 per-otter per-day 的发言计数。
 * 同时合并 session JSONL 中的工具调用计数。
 */
export function collectOtterOutput(
  db: Database.Database,
  toolCallCounts: Map<string, Map<string, number>>,
  options?: { since?: string },
): OtterOutputRecord[] {
  const since = options?.since ?? new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // F20260913ctlv 批4c：数据源切 entries（speak = 獭气泡产出；messages 表已 drop）
  const rows = db.prepare(`
    SELECT
      DATE(e.created_at) AS date,
      e.sender_id AS otterId,
      COALESCE(o.name, e.sender_name, e.sender_id) AS otterName,
      COUNT(*) AS messageCount
    FROM entries e
    LEFT JOIN otters o ON o.id = e.sender_id
    WHERE e.entry_type = 'speak'
      AND DATE(e.created_at) >= ?
    GROUP BY DATE(e.created_at), e.sender_id
    ORDER BY date, otterId
  `).all(since) as Array<{ date: string; otterId: string; otterName: string; messageCount: number }>;

  return rows.map(r => ({
    date: r.date,
    otterId: r.otterId,
    otterName: r.otterName,
    messageCount: Number(r.messageCount),
    toolCallCount: toolCallCounts.get(r.date)?.get(r.otterId) ?? 0,
  }));
}

/** 从单个 JSONL 文件统计 toolCall，返回 per-date per-otter 计数 */
async function countToolCallsInFile(
  filePath: string,
  identity: OtterIdentity,
  sinceDate?: string,
): Promise<Map<string, Map<string, number>>> {
  const content = await readFile(filePath, "utf-8").catch(() => "");
  if (!content) return new Map();

  const result = new Map<string, Map<string, number>>();
  for (const line of content.split("\n").filter(Boolean)) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type !== "message") continue;

    const msg = obj as unknown as SessionMessageLine;
    if (msg.message.role !== "assistant") continue;

    const date = msg.timestamp.slice(0, 10);
    if (sinceDate && date < sinceDate) continue;

    const tcCount = countToolCalls(msg.message.content);
    if (tcCount === 0) continue;

    if (!result.has(date)) result.set(date, new Map());
    const dateMap = result.get(date)!;
    dateMap.set(identity.otterId, (dateMap.get(identity.otterId) ?? 0) + tcCount);
  }
  return result;
}

/** 合并多个文件的 toolCall 计数 */
function mergeToolCallCounts(
  target: Map<string, Map<string, number>>,
  source: Map<string, Map<string, number>>,
): void {
  for (const [date, dateMap] of source) {
    if (!target.has(date)) target.set(date, new Map());
    const targetDate = target.get(date)!;
    for (const [otterId, count] of dateMap) {
      targetDate.set(otterId, (targetDate.get(otterId) ?? 0) + count);
    }
  }
}

/**
 * 从 session JSONL 目录采集 per-otter per-day 的工具调用计数。
 */
export async function collectToolCallCounts(
  sessionsDir: string,
  agentSessionSource: AgentSessionSource,
  options?: { since?: string },
): Promise<Map<string, Map<string, number>>> {
  const mappings = await agentSessionSource();
  const mappingBySession = new Map(mappings.map(m => [m.piSessionId, m]));
  const files = await listSessionFiles(sessionsDir, options?.since);
  const result = new Map<string, Map<string, number>>();
  const sinceDate = options?.since?.slice(0, 10);

  const unknownSessions: string[] = [];
  for (const file of files) {
    const sessionId = extractSessionId(file);
    const identity = await resolveOtterIdentity(sessionId, mappingBySession, join(sessionsDir, file));
    if (identity === UNKNOWN_IDENTITY) unknownSessions.push(sessionId);
    const fileCounts = await countToolCallsInFile(join(sessionsDir, file), identity, sinceDate);
    mergeToolCallCounts(result, fileCounts);
  }

  if (unknownSessions.length > 0) {
    console.warn(
      `[cost-output] ${unknownSessions.length} session(s) could not be mapped to otter ` +
      `(tool call counts attributed to 'unknown' bucket). Sample IDs: ${unknownSessions.slice(0, 5).join(", ")}`,
    );
  }

  return result;
}

// ── InvokeStatsCollector: 单次问答均值（F20260914usgm，数据源 invokes 表） ──

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
  interface Acc {
    invokeCount: number;
    toolCalls: number;
    durationSec: number;
    durationCount: number;
    inputTokens: number;
    outputTokens: number;
    tokenCount: number;
  }
  const acc = new Map<string, Acc>();
  const getAcc = (key: string): Acc => {
    let a = acc.get(key);
    if (!a) {
      a = { invokeCount: 0, toolCalls: 0, durationSec: 0, durationCount: 0, inputTokens: 0, outputTokens: 0, tokenCount: 0 };
      acc.set(key, a);
    }
    return a;
  };

  for (const row of rows) {
    const date = row.started_at.slice(0, 10);
    let model = "unknown";
    if (row.metadata) {
      try {
        const meta = JSON.parse(row.metadata) as { model?: string };
        if (meta.model) model = meta.model;
      } catch {
        // metadata 非法 JSON → unknown 桶
      }
    }

    // token 差分（per-otter 时序）
    const last = lastSnapshot.get(row.otter_id);
    const dInput = row.token_usage_input !== null
      ? (last && row.token_usage_input >= last.input ? row.token_usage_input - last.input : row.token_usage_input)
      : null;
    const dOutput = row.token_usage_output !== null
      ? (last && row.token_usage_output >= last.output ? row.token_usage_output - last.output : row.token_usage_output)
      : null;
    if (row.token_usage_input !== null || row.token_usage_output !== null) {
      lastSnapshot.set(row.otter_id, {
        input: row.token_usage_input ?? last?.input ?? 0,
        output: row.token_usage_output ?? last?.output ?? 0,
      });
    }

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

  return [...acc.entries()].map(([key, a]) => {
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
  });
}

// ── PR 数采集（git log 统计合并提交） ──

/** per-date 的 PR 数 */
export interface PrCountRecord {
  date: string;
  prCount: number;
}

/**
 * 通过 git log 统计合并的 PR 数量。
 * GitHub merge commit 格式：Merge pull request #NNN from ...
 */
export async function collectPrCounts(
  repoPath: string,
  sinceDays = 60,
): Promise<PrCountRecord[]> {
  try {
    const sinceDate = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { stdout } = await execFileAsync("git", [
      "log",
      "--oneline",
      "--since", sinceDate,
      "--merges",
      "--format=%aI",
    ], { cwd: repoPath, maxBuffer: 5 * 1024 * 1024 });

    const counts = new Map<string, number>();
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      const date = line.slice(0, 10);
      counts.set(date, (counts.get(date) ?? 0) + 1);
    }

    return [...counts.entries()].map(([date, prCount]) => ({ date, prCount }));
  } catch {
    return [];
  }
}

// ── F 文档数采集（docs/features/ 统计） ──

/** per-date 的 F 文档数 */
export interface FdocCountRecord {
  date: string;
  fdocCount: number;
}

// ── 每日派工数采集（dispatch_records 统计） ──

/** per-date 的派工数 */
export interface DispatchCountRecord {
  date: string;
  dispatchCount: number;
}

/**
 * F20260912avlb：从 dispatch_records 表采集 per-date 的每日派工数。
 * 口径：按 dispatched_at 日期聚合（有 dispatched_at 的记录数 = 当日实际派出的工）。
 * 旧口径（「任务完成数」：只认 completed/failed 终态）自上线以来一直静默归零——
 * 终态从未有写入路径（见特性文档「数据层真相」），是死口径；本切换为客观可判定的
 * 「派工」事件。存量 in_progress 迁移时用原 updatedAt 填充 dispatched_at，历史不丢。
 */
export function collectDispatchTaskCounts(
  db: Database.Database,
  options?: { since?: string },
): DispatchCountRecord[] {
  const since = options?.since ?? new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT substr(dispatched_at, 1, 10) AS date, COUNT(*) AS count
    FROM dispatch_records
    WHERE dispatched_at IS NOT NULL AND substr(dispatched_at, 1, 10) >= ?
    GROUP BY substr(dispatched_at, 1, 10)
  `).all(since) as Array<{ date: string; count: number }>;

  return rows.map(r => ({ date: r.date, dispatchCount: r.count }));
}

/**
 * 通过 docs/features/ 目录中的 .md 文件名提取日期，统计每日 F 文档数。
 */
export async function collectFdocCounts(repoPath: string): Promise<FdocCountRecord[]> {
  const { collectFeatureDocs } = await import("./feature-doc-collector");
  const docs = await collectFeatureDocs(repoPath);

  const counts = new Map<string, number>();
  for (const doc of docs) {
    const date = doc.createdAt
      ? doc.createdAt.slice(0, 10)
      : extractDateFromId(doc.id);
    if (date) counts.set(date, (counts.get(date) ?? 0) + 1);
  }

  return [...counts.entries()].map(([date, fdocCount]) => ({ date, fdocCount }));
}

/** 从 F 文档 ID 提取日期（FYYYYMMDDxxxx） */
function extractDateFromId(id: string): string | null {
  const match = id?.match(/^F(\d{8})/);
  if (!match) return null;
  const d = match[1];
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}
