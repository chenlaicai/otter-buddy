/**
 * Durable 当前世代读取原语 + coding-agent SessionEntry 投影。
 *
 * 边界规则：世代边界与可见范围由 pi-durable 的公开 Storage 契约持有
 * （findLatestHeadMarker + scanEntries），消费者不再认识 entries/head/record
 * 等 SQLite 表结构。打开 Storage 只用于既有库的只读查询，不开 Harness，
 * 因而不会触发 recoverAfterReopen 误 abort 正常 invoke。
 *
 * undefined=读失败/无档案；[]=真空 session。调用方据此区分降级原因。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";
import {
  ROOT_CONVERSATION_ID,
  type Cursor,
  type EntryRecord,
  type Storage,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

/** sdk-invoke-port 的最小结构面（避免 frameworks → usecases 深依赖反转） */
interface SessionEntryShape {
  type: string;
  id: string;
  [key: string]: unknown;
}

/**
 * better-sqlite3 readonly → chord SqliteDatabase 的最小异步适配。
 * SqliteStorage.open 会检查既有 schema；事务回调只承载该检查的幂等 DDL，
 * 真正写迁移会被 readonly 连接拒绝，不把只读读取器变成隐式升级器。
 */
class ReadonlySqliteDatabase implements SqliteDatabase, SqliteExecutor {
  constructor(private readonly db: Database.Database) {}

  async exec(sql: string): Promise<void> { this.db.exec(sql); }
  async run(sql: string, ...params: SqliteValue[]): Promise<void> {
    // SqliteStorage.open 的幂等 schema 标记即使记录已存在，SQLite 仍按写操作
    // 拒绝 readonly 连接。只在目标标记确实存在时吞掉该 no-op；缺标记或真迁移
    // 继续响亮失败，绝不把只读入口变成隐式升级器。
    const bootstrap = sql.match(/^INSERT OR IGNORE INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s+\(singleton,/i);
    if (bootstrap) {
      const present = this.db.prepare(`SELECT 1 AS present FROM ${bootstrap[1]} WHERE singleton = 1`).get();
      if (present) return;
      throw new Error(`Durable readonly open requires initialized schema marker: ${bootstrap[1]}`);
    }
    this.db.prepare(sql).run(...params);
  }
  async runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
    return Number(this.db.prepare(sql).run(...params).changes);
  }
  async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }
  async transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return callback(this);
  }
  async close(): Promise<void> { this.db.close(); }
}

const ENTRY_PAGE_SIZE = 500;

/**
 * 基座读侧原语：返回根会话当前世代的原始 EntryRecord，分页直至尾端。
 * 只依赖 Storage 公共契约；换存储实现或改 SQLite schema 不要求消费者跟随修改。
 */
export async function readDurableActiveEntries(storage: Storage): Promise<EntryRecord[]> {
  const boundary = await storage.findLatestHeadMarker(
    ROOT_CONVERSATION_ID,
    undefined,
    BACKGROUND_CONTEXT,
  );
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanEntries(
      {
        conversationId: ROOT_CONVERSATION_ID,
        minEntryId: boundary?.head,
        order: "ascending",
      },
      ENTRY_PAGE_SIZE,
      cursor,
      BACKGROUND_CONTEXT,
    );
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return entries;
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

/** durable EntryRecord → coding-agent SessionEntry；无模型载荷的记账条目跳过。 */
export function projectDurableSessionEntries(entries: readonly EntryRecord[]): SessionEntryShape[] {
  const base = Date.now() - entries.length * 1000;
  const out: SessionEntryShape[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const timestamp = new Date(base + i * 1000).toISOString();
    let projected: SessionEntryShape | undefined;
    if (entry.kind === "pi.compaction") {
      projected = {
        type: "compaction",
        id: `d${entry.id}`,
        timestamp,
        summary: textOfContent(entry.model?.[0]?.content) ?? "",
      };
    } else {
      const message = entry.model?.[0];
      if (message && typeof message.role === "string") {
        projected = { type: "message", id: `d${entry.id}`, timestamp, message };
      }
    }
    if (projected) {
      (projected as unknown as { parentId: string | null }).parentId = out.length ? out[out.length - 1].id : null;
      out.push(projected);
    }
  }
  return out;
}

/** 既有 durable 库的零 Harness 只读入口；schema 检查失败响亮抛给工厂降级归因。 */
export async function readDurableActiveSessionEntries(file: string): Promise<SessionEntryShape[] | undefined> {
  const resolved = path.resolve(file);
  if (!existsSync(resolved)) return undefined;
  const storage = await SqliteStorage.open(
    new ReadonlySqliteDatabase(new Database(resolved, { readonly: true, fileMustExist: true })),
  );
  try {
    return projectDurableSessionEntries(await readDurableActiveEntries(storage));
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
}
