/**
 * M-9af49d4a R2：durable 会话「当前世代 entries」只读投影（换世档案合成原料）。
 *
 * Why 直读 sqlite 而不开 Harness：readCurrentSessionEntries 的调用点含 probeFirstTurn
 * （正常 invoke 期的 buildDynamicContext），DurableSession.open 的 recoverAfterReopen
 * 会 abort 未完任务——正常轮里误伤在跑 generation。只读连接零副作用（与运维查库同模式）。
 *
 * Why 不复用 jsonl 分支：#1783 迁移后前世对话在 durable sqlite 里（entries 表），
 * JSONL 读取器拿不到原料 → 换世档案 100% 机械转储（2026-11-10 08:04 起全部降级）。
 *
 * 语义对齐 legacy 分支：undefined=读失败/无档案；[]=真空 session（0 条有结构）——
 * 调用方（collectJsonlSlice）以此区分 'jsonl-read-fail' 与 'empty-session' 降级归因。
 *
 * 投影形状：coding-agent SessionEntry 面（session-slicer/buildSessionContext 消费）：
 * type=id/parentId/timestamp/message{role,content,stopReason?,usage?}；
 * pi.compaction → {type:"compaction", summary}（getLatestCompactionEntry 跨代种子）。
 * durable EntryRecord 无 timestamp——合成单调时间戳（仅骨架/序列化展示用，不驱动行为）。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/** sdk-invoke-port 的最小结构面（避免 frameworks → usecases 深依赖反转） */
interface SessionEntryShape {
  type: string;
  id: string;
  [key: string]: unknown;
}

interface DurableEntryRow {
  id: number;
  head: number | null;
  record: string;
}

interface DurableEntryRecord {
  kind?: string;
  model?: Array<{ role?: string; content?: unknown }>;
}

/** pi-ai content（string | blocks）→ 纯文本（compaction summary 提取用） */
function textOfContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((b): b is { type: string; text?: string } => typeof b === "object" && b !== null)
    .map(b => (typeof b.text === "string" ? b.text : ""))
    .filter(t => t.length > 0);
  return parts.length ? parts.join("\n") : undefined;
}

/** 世代边界：最后一条 head 非空条目的 head 值（reset/compaction 指向的活动上下文首条）；
 *  无 head 持有者 = 单世代全量（-Infinity）。 */
function findGenerationBoundary(rows: DurableEntryRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].head != null) return rows[i].head as number;
  }
  return -Infinity;
}

/** 单条 durable entry → SessionEntry；无上下文载荷的记账条目返回 undefined */
function projectEntry(row: DurableEntryRow, timestamp: string): SessionEntryShape | undefined {
  const parsed = JSON.parse(row.record) as DurableEntryRecord;
  if (parsed.kind === "pi.compaction") {
    return { type: "compaction", id: `d${row.id}`, timestamp, summary: textOfContent(parsed.model?.[0]?.content) ?? "" };
  }
  const message = parsed.model?.[0];
  if (!message || typeof message.role !== "string") return undefined;
  return { type: "message", id: `d${row.id}`, timestamp, message };
}

/**
 * 只读投影 durable 库「当前世代」entries（= rawContext 活动视图的镜像）。
 * 仅取根 conversation（海獭每獭一库单会话模型）；parentId 链式重接、时间戳合成单调。
 */
export function readDurableActiveSessionEntries(file: string): SessionEntryShape[] | undefined {
  const resolved = path.resolve(file);
  if (!existsSync(resolved)) return undefined;
  const db = new Database(resolved, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(
      `SELECT id, head, record FROM entries
       WHERE conversation_id = (SELECT MIN(id) FROM conversations)
       ORDER BY id ASC`,
    ).all() as DurableEntryRow[];
    if (rows.length === 0) return [];

    const boundary = findGenerationBoundary(rows);
    const active = rows.filter(r => r.id >= boundary);
    const base = Date.now() - active.length * 1000;
    const out: SessionEntryShape[] = [];
    for (let i = 0; i < active.length; i++) {
      const projected = projectEntry(active[i], new Date(base + i * 1000).toISOString());
      if (projected) {
        (projected as unknown as { parentId: string | null }).parentId = out.length ? out[out.length - 1].id : null;
        out.push(projected);
      }
    }
    return out;
  } finally {
    db.close();
  }
}
