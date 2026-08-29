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
  cacheHitRate: number;
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
 *
 * system prompt 包含如下格式：
 * - 名称：<name>
 * - ID：<uuid>
 * - 类型：<type>
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

/**
 * 解析单个 session JSONL 文件，提取 assistant 消息的 usage 记录和工具调用计数。
 *
 * Finding 2 修复：从 user message 内容中提取 otterId，不依赖 agent_sessions 映射。
 * Finding 3 修复：使用每条消息的 timestamp 确定日期，而非文件名前缀。
 */
async function parseSessionFile(
  filePath: string,
  otterIdentity: OtterIdentity,
  sinceDate?: string,
): Promise<{
  costRecords: Array<OtterCostRecord & { _key: string }>;
  toolCallCount: number;
}> {
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
      const mc = obj as unknown as SessionModelChangeLine;
      currentModel = mc.modelId ?? "unknown";
      continue;
    }

    if (obj.type !== "message") continue;
    const msg = obj as unknown as SessionMessageLine;
    if (msg.message.role !== "assistant") continue;

    // Finding 3 修复：使用消息级 timestamp 确定日期
    const date = msg.timestamp.slice(0, 10);
    if (sinceDate && date < sinceDate) continue;

    // 统计工具调用（type=toolCall 的 content block）
    const msgContent = msg.message.content;
    if (Array.isArray(msgContent)) {
      for (const block of msgContent) {
        if (block.type === "toolCall") {
          toolCallCount++;
        }
      }
    }

    if (!msg.message.usage) continue;

    const usage = msg.message.usage;
    const model = msg.message.model ?? currentModel;

    costRecords.push({
      _key: `${date}|${otterIdentity.otterId}|${model}`,
      date,
      otterId: otterIdentity.otterId,
      otterName: otterIdentity.otterName,
      otterType: otterIdentity.otterType,
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
  return { costRecords, toolCallCount };
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

/**
 * 从文件名提取 session 开始日期（粗筛用）。
 * 文件名格式：YYYY-MM-DDTHH-MM-SS-MMMZ_<session_id>.jsonl
 */
function extractFileDate(fileName: string): string {
  return fileName.slice(0, 10);
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

  // Finding 3 修复：放宽文件级过滤，since 前 2 天的文件也读入（跨日 session 可能跨多天）
  // 精确过滤在 parseSessionFile 内按消息 timestamp 执行
  if (options?.since) {
    const sinceDate = new Date(options.since.slice(0, 10));
    sinceDate.setDate(sinceDate.getDate() - 2);
    const fileFilterDate = sinceDate.toISOString().slice(0, 10);
    files = files.filter(f => extractFileDate(f) >= fileFilterDate);
  }

  const allCostRecords: Array<OtterCostRecord & { _key: string }> = [];

  for (const file of files) {
    // 从文件名提取 session ID，尝试 agent_sessions 映射
    const sessionId = file.replace(/\.jsonl$/, "").split("_").pop() ?? "";
    const mapping = mappingBySession.get(sessionId);

    // Finding 2 修复：优先使用行内 otterId，其次 agent_sessions 映射，最后 unknown 桶
    let otterIdentity: OtterIdentity;
    if (mapping) {
      otterIdentity = { otterId: mapping.otterId, otterName: mapping.otterName, otterType: mapping.otterType };
    } else {
      // 从文件第一个 user message 提取 otterId
      const fileContent = await readFile(join(sessionsDir, file), "utf-8").catch(() => "");
      const firstLine = fileContent.split("\n").find(l => l.trim());
      let extracted: OtterIdentity | null = null;
      if (firstLine) {
        try {
          const firstObj = JSON.parse(firstLine) as Record<string, unknown>;
          // 第一行可能是 session header，需要跳过找到 user message
          for (const line of fileContent.split("\n").filter(Boolean)) {
            const obj = JSON.parse(line) as Record<string, unknown>;
            if (obj.type === "message") {
              const msg = obj as SessionMessageLine;
              if (msg.message.role === "user" && Array.isArray(msg.message.content)) {
                extracted = parseOtterIdentityFromContent(msg.message.content);
                break;
              }
            }
          }
        } catch { /* skip parse errors */ }
      }
      otterIdentity = extracted ?? { otterId: "unknown", otterName: "unknown", otterType: "unknown" };
    }

    const { costRecords } = await parseSessionFile(
      join(sessionsDir, file),
      otterIdentity,
      options?.since?.slice(0, 10),
    );
    allCostRecords.push(...costRecords);
  }

  return aggregateUsageRecords(allCostRecords);
}

// ── OtterOutputCollector: 查询 messages 表 + session JSONL 工具调用 ──

/**
 * 从 messages 表采集 per-otter per-day 的发言计数。
 * 同时采集 session JSONL 中的工具调用计数。
 *
 * v1 口径：
 * - message_count: sender_type='otter' 的消息按 sender_id + date 聚合
 * - tool_call_count: session JSONL 中 assistant 消息的 toolCall content block 数
 */
export function collectOtterOutput(
  db: Database.Database,
  toolCallCounts: Map<string, Map<string, number>>,
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
    toolCallCount: toolCallCounts.get(r.date)?.get(r.otterId) ?? 0,
  }));
}

/**
 * 从 session JSONL 目录采集 per-otter per-day 的工具调用计数。
 *
 * Finding 2/3 修复同 LLMCallCollector：行内 otterId + 消息级 timestamp。
 * 返回结构：Map<date, Map<otterId, count>>
 */
export async function collectToolCallCounts(
  sessionsDir: string,
  agentSessionSource: AgentSessionSource,
  options?: { since?: string },
): Promise<Map<string, Map<string, number>>> {
  const mappings = await agentSessionSource();
  const mappingBySession = new Map(mappings.map(m => [m.piSessionId, m]));

  let files: string[];
  try {
    files = (await readdir(sessionsDir)).filter(f => f.endsWith(".jsonl"));
  } catch {
    return new Map();
  }

  // Finding 3 修复：放宽文件级过滤（同 collectLlmCalls）
  if (options?.since) {
    const sinceDate = new Date(options.since.slice(0, 10));
    sinceDate.setDate(sinceDate.getDate() - 2);
    const fileFilterDate = sinceDate.toISOString().slice(0, 10);
    files = files.filter(f => extractFileDate(f) >= fileFilterDate);
  }

  const result = new Map<string, Map<string, number>>();

  for (const file of files) {
    const sessionId = file.replace(/\.jsonl$/, "").split("_").pop() ?? "";
    const mapping = mappingBySession.get(sessionId);

    let otterIdentity: OtterIdentity;
    if (mapping) {
      otterIdentity = { otterId: mapping.otterId, otterName: mapping.otterName, otterType: mapping.otterType };
    } else {
      const fileContent = await readFile(join(sessionsDir, file), "utf-8").catch(() => "");
      let extracted: OtterIdentity | null = null;
      if (fileContent) {
        for (const line of fileContent.split("\n").filter(Boolean)) {
          try {
            const obj = JSON.parse(line) as Record<string, unknown>;
            if (obj.type === "message") {
              const msg = obj as SessionMessageLine;
              if (msg.message.role === "user" && Array.isArray(msg.message.content)) {
                extracted = parseOtterIdentityFromContent(msg.message.content);
                break;
              }
            }
          } catch { continue; }
        }
      }
      otterIdentity = extracted ?? { otterId: "unknown", otterName: "unknown", otterType: "unknown" };
    }

    const content = await readFile(join(sessionsDir, file), "utf-8").catch(() => "");
    if (!content) continue;

    const sinceDate = options?.since?.slice(0, 10);

    for (const line of content.split("\n").filter(Boolean)) {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (obj.type !== "message") continue;
      const msg = obj as SessionMessageLine;
      if (msg.message.role !== "assistant") continue;

      // Finding 3：消息级 timestamp 归属
      const date = msg.timestamp.slice(0, 10);
      if (sinceDate && date < sinceDate) continue;

      const msgContent = msg.message.content;
      if (!Array.isArray(msgContent)) continue;

      for (const block of msgContent) {
        if (block.type === "toolCall") {
          if (!result.has(date)) result.set(date, new Map());
          const dateMap = result.get(date)!;
          dateMap.set(otterIdentity.otterId, (dateMap.get(otterIdentity.otterId) ?? 0) + 1);
        }
      }
    }
  }

  return result;
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
      // %aI format: 2026-08-28T10:30:00+08:00
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

/**
 * 通过 docs/features/ 目录中的 .md 文件名提取日期，统计每日 F 文档数。
 * F 文档文件名格式：FYYYYMMDDxxxx-*.md
 */
export async function collectFdocCounts(repoPath: string): Promise<FdocCountRecord[]> {
  const { collectFeatureDocs } = await import("./feature-doc-collector");
  const docs = await collectFeatureDocs(repoPath);

  const counts = new Map<string, number>();
  for (const doc of docs) {
    // 使用 frontmatter 中的 created_at 字段，格式 YYYY-MM-DD
    if (doc.createdAt) {
      const date = doc.createdAt.slice(0, 10);
      counts.set(date, (counts.get(date) ?? 0) + 1);
    } else {
      // fallback: 从文件名提取日期（FYYYYMMDD）
      const match = doc.id?.match(/^F(\d{8})/);
      if (match) {
        const d = match[1];
        const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
        counts.set(date, (counts.get(date) ?? 0) + 1);
      }
    }
  }

  return [...counts.entries()].map(([date, fdocCount]) => ({ date, fdocCount }));
}
