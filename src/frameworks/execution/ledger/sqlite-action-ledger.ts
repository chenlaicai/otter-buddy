import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, existsSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { LOCAL_EXECUTION_MACHINE_ID } from "@usecases/ports/execution-machine";
import type {
  ActionRecord,
  ActionKind,
  SettleVerdict,
  StartActionInput,
  SweepReport,
} from "@entities/execution/action-record";
import type { ActionLedger } from "@usecases/ports/action-ledger";
import type { Logger } from "@usecases/ports/logger";

/**
 * F20261116actlg：本机动作台账 sqlite 实现。
 *
 * 存储：`<dataDir>/execution-machines/<deviceId>/actions.db`（WAL）。
 * 每机一库——「执行机本地的动作真相」语义：阶段 4/5 远程机各自持有台账，
 * 中枢只经机器接口查询；工具执行热路径与主库隔离。
 *
 * 纪元（boot epoch）：meta.boot_seq 单调递增，每次开机 +1；行携带铸造时的
 * boot_seq，清扫裁决「旧纪元 running 行」。单调计数器规避时钟回拨。
 *
 * 修剪：终态行保留 retentionDays 天 / maxRows 封顶（开机修剪，best-effort）；
 * running/interrupted/unknown 非终态与未处置行永不修剪。
 */
export interface SqliteActionLedgerOptions {
  deviceId?: string;
  retentionDays?: number;
  maxRows?: number;
  logger?: Logger;
}

interface ActionRow {
  action_id: string;
  device_id: string;
  online_session_id: string | null;
  invoke_id: string | null;
  conversation_id: string | null;
  tool_call_id: string | null;
  source: string;
  kind: string;
  target: string | null;
  content_hash: string | null;
  content_bytes: number | null;
  status: string;
  error: string | null;
  result_summary: string | null;
  boot_epoch: number;
  pid: number | null;
  started_at: string;
  settled_at: string | null;
}

const HASH_VERIFIABLE_KINDS = new Set<ActionKind>(["file.write", "file.append", "workspace.write"]);
const INTERRUPTIBLE_KINDS = new Set<ActionKind>(["file.truncate", "file.rename", "file.remove", "file.mkdir", "workspace.delete"]);

export class SqliteActionLedger implements ActionLedger {
  private readonly db: Database.Database;
  private readonly deviceId: string;
  private readonly retentionDays: number;
  private readonly maxRows: number;
  private readonly logger?: Logger;
  /** 当前进程纪元（meta.boot_seq 当前值） */
  readonly bootEpoch: number;
  private mintSeq = 0;

  constructor(readonly file: string, options: SqliteActionLedgerOptions = {}) {
    this.deviceId = options.deviceId ?? LOCAL_EXECUTION_MACHINE_ID;
    this.retentionDays = options.retentionDays ?? 14;
    this.maxRows = options.maxRows ?? 100_000;
    this.logger = options.logger;
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.initTables();
    this.bootEpoch = this.bumpBootEpoch();
  }

  /** 开机接线：清扫旧纪元 running 行 + 修剪终态行。组合根 await 它，
   * 保证恢复链读台账前机器真相已裁决。失败自吞（non-fatal）。 */
  async open(): Promise<SweepReport> {
    return this.sweepStaleBoot();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_actions (
        action_id     TEXT PRIMARY KEY,
        device_id     TEXT NOT NULL,
        online_session_id TEXT,
        invoke_id     TEXT,
        conversation_id TEXT,
        tool_call_id  TEXT,
        source        TEXT NOT NULL,
        kind          TEXT NOT NULL,
        target        TEXT,
        content_hash  TEXT,
        content_bytes INTEGER,
        status        TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','interrupted','unknown')),
        error         TEXT,
        result_summary TEXT,
        boot_epoch    INTEGER NOT NULL,
        pid           INTEGER,
        started_at    TEXT NOT NULL,
        settled_at    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_actions_invoke ON execution_actions(invoke_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_actions_status ON execution_actions(status);
      CREATE TABLE IF NOT EXISTS action_ledger_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private bumpBootEpoch(): number {
    const row = this.db.prepare("SELECT value FROM action_ledger_meta WHERE key = 'boot_seq'").get() as { value: string } | undefined;
    const next = (row ? Number(row.value) : 0) + 1;
    this.db.prepare("INSERT INTO action_ledger_meta (key, value) VALUES ('boot_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(next));
    this.db.prepare("INSERT OR REPLACE INTO action_ledger_meta (key, value) VALUES ('boot_pid', ?)").run(String(process.pid));
    return next;
  }

  async start(input: StartActionInput): Promise<{ record: ActionRecord; deduped: boolean }> {
    const actionId = input.actionId ?? this.mintActionId(input.source);
    const dedup = this.settleStaleExistingRow(actionId);
    if (dedup) return dedup;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO execution_actions (
        action_id, device_id, online_session_id, invoke_id, conversation_id, tool_call_id,
        source, kind, target, content_hash, content_bytes, status, error, result_summary,
        boot_epoch, pid, started_at, settled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, ?, ?, NULL)
      ON CONFLICT(action_id) DO UPDATE SET
        target = excluded.target,
        content_hash = excluded.content_hash,
        content_bytes = excluded.content_bytes,
        boot_epoch = excluded.boot_epoch,
        pid = excluded.pid,
        started_at = excluded.started_at,
        status = 'running',
        error = NULL,
        result_summary = NULL,
        settled_at = NULL
    `).run(
      actionId, input.deviceId ?? this.deviceId, input.onlineSessionId ?? null,
      input.invokeId ?? null, input.conversationId ?? null, input.toolCallId ?? null,
      input.source, input.kind, truncate(input.target), input.contentHash ?? null,
      input.contentBytes ?? null, this.bootEpoch, input.pid ?? process.pid ?? null, now,
    );
    const row = this.db.prepare("SELECT * FROM execution_actions WHERE action_id = ?").get(actionId) as ActionRow;
    return { record: rowToRecord(row), deduped: false };
  }

  /** 同 actionId 已有行的去重/清扫预处理：仅 succeeded 去重（已完成确定性结果）；
   *  failed/interrupted/unknown 不是「已完成」——重开新一轮，重做合法；
   *  清扫漏网的旧纪元 running 行先裁决。 */
  private settleStaleExistingRow(actionId: string): { record: ActionRecord; deduped: boolean } | null {
    const existing = this.db.prepare("SELECT * FROM execution_actions WHERE action_id = ?").get(actionId) as ActionRow | undefined;
    if (!existing) return null;
    if (existing.status === "succeeded") {
      return { record: rowToRecord(existing), deduped: true };
    }
    if (existing.status === "running" && existing.boot_epoch < this.bootEpoch) {
      this.applySweepVerdict(existing);
    }
    return null;
  }

  async settle(actionId: string, verdict: SettleVerdict, settledAt?: string): Promise<void> {
    this.db.prepare(`
      UPDATE execution_actions
      SET status = ?, error = ?, result_summary = ?, settled_at = ?
      WHERE action_id = ? AND status = 'running'
    `).run(
      verdict.status,
      "error" in verdict && verdict.error !== undefined ? truncate(verdict.error, 2000) : null,
      verdict.resultSummary !== undefined ? JSON.stringify(verdict.resultSummary) : null,
      settledAt ?? new Date().toISOString(),
      actionId,
    );
  }

  async getByActionId(actionId: string): Promise<ActionRecord | null> {
    const row = this.db.prepare("SELECT * FROM execution_actions WHERE action_id = ?").get(actionId) as ActionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  async listByInvoke(invokeId: string, limit = 200): Promise<ActionRecord[]> {
    const rows = this.db.prepare("SELECT * FROM execution_actions WHERE invoke_id = ? ORDER BY started_at ASC, action_id ASC LIMIT ?").all(invokeId, limit) as ActionRow[];
    return rows.map(rowToRecord);
  }

  async sweepStaleBoot(): Promise<SweepReport> {
    const report: SweepReport = { upgradedToSucceeded: 0, markedInterrupted: 0, markedUnknown: 0, pruned: 0 };
    try {
      const stale = this.db.prepare("SELECT * FROM execution_actions WHERE status = 'running' AND boot_epoch < ?").all(this.bootEpoch) as ActionRow[];
      for (const row of stale) {
        const delta = this.applySweepVerdict(row);
        report.upgradedToSucceeded += delta.upgradedToSucceeded;
        report.markedInterrupted += delta.markedInterrupted;
        report.markedUnknown += delta.markedUnknown;
      }
      report.pruned = this.pruneTerminalRows();
      if (stale.length > 0 || report.pruned > 0) {
        this.logger?.info("action ledger boot sweep", {
          file: this.file, stale: stale.length,
          upgraded: report.upgradedToSucceeded, interrupted: report.markedInterrupted,
          unknown: report.markedUnknown, pruned: report.pruned,
        });
      }
    } catch (err) {
      // 台账清扫失败不阻断启动（non-fatal 纪律）——残留 running 行保留，下次开机再扫
      this.logger?.warn("action ledger boot sweep failed (non-fatal)", { error: err instanceof Error ? err.message : String(err) });
    }
    return report;
  }

  /** 单行清扫裁决（文件写 hash 核对；exec → unknown；幂等类 → interrupted）。 */
  private applySweepVerdict(row: ActionRow): { upgradedToSucceeded: number; markedInterrupted: number; markedUnknown: number } {
    const kind = row.kind as ActionKind;
    const now = new Date().toISOString();
    const settle = (status: string, error: string | null, summary: Record<string, unknown> | null) => {
      this.db.prepare("UPDATE execution_actions SET status = ?, error = ?, result_summary = ?, settled_at = ? WHERE action_id = ?")
        .run(status, error, summary ? JSON.stringify(summary) : null, now, row.action_id);
    };
    if (HASH_VERIFIABLE_KINDS.has(kind) && row.target && row.content_hash) {
      const verdict = this.verifyHashOnDisk(row.target, row.content_hash, row.content_bytes, kind);
      if (verdict.matched) {
        settle("succeeded", null, { receiptRecovered: true, ...verdict.detail });
        return { upgradedToSucceeded: 1, markedInterrupted: 0, markedUnknown: 0 };
      }
      settle("interrupted", "crash before completion; hash mismatch", { receiptRecovered: false });
      return { upgradedToSucceeded: 0, markedInterrupted: 1, markedUnknown: 0 };
    }
    if (kind === "shell.exec") {
      // 崩溃时命令正在跑：连「跑没跑完」都不知道——unknown 转检查，禁止猜测重试
      settle("unknown", "interrupted by crash; side effects unverifiable", null);
      return { upgradedToSucceeded: 0, markedInterrupted: 0, markedUnknown: 1 };
    }
    if (INTERRUPTIBLE_KINDS.has(kind)) {
      settle("interrupted", "interrupted by crash; idempotent redo safe", null);
      return { upgradedToSucceeded: 0, markedInterrupted: 1, markedUnknown: 0 };
    }
    settle("unknown", "unrecognized kind after crash", null);
    return { upgradedToSucceeded: 0, markedInterrupted: 0, markedUnknown: 1 };
  }

  /**
   * 磁盘 hash 核对：file.write → 全文件 sha256 == content_hash；
   * file.append → 文件尾部 content_bytes 字节 sha256 == content_hash。
   */
  private verifyHashOnDisk(target: string, contentHash: string, contentBytes: number | null, kind: ActionKind): { matched: boolean; detail?: Record<string, unknown> } {
    try {
      const real = this.resolveExisting(target);
      if (!real || !statSync(real).isFile()) return { matched: false };
      if (kind === "file.append" && contentBytes !== null) {
        const buf = readFileSync(real);
        if (buf.length < contentBytes) return { matched: false };
        const tail = buf.subarray(buf.length - contentBytes);
        return { matched: sha256(tail) === contentHash, detail: { verified: "append-tail" } };
      }
      return { matched: sha256(readFileSync(real)) === contentHash, detail: { verified: "full-file" } };
    } catch {
      return { matched: false };
    }
  }

  /** 跟随 symlink 后返回存在的最终路径；不存在返回 null。 */
  private resolveExisting(target: string): string | null {
    try {
      return realpathSync(target);
    } catch {
      return existsSync(target) ? target : null;
    }
  }

  private pruneTerminalRows(): number {
    const cutoff = new Date(Date.now() - this.retentionDays * 86_400_000).toISOString();
    const byAge = this.db.prepare(
      "DELETE FROM execution_actions WHERE status IN ('succeeded','failed') AND settled_at IS NOT NULL AND settled_at < ?",
    ).run(cutoff).changes;
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM execution_actions WHERE status IN ('succeeded','failed')").get() as { n: number }).n;
    let byCap = 0;
    if (count > this.maxRows) {
      byCap = this.db.prepare(`
        DELETE FROM execution_actions WHERE action_id IN (
          SELECT action_id FROM execution_actions WHERE status IN ('succeeded','failed')
          ORDER BY settled_at ASC LIMIT ?
        )
      `).run(count - this.maxRows).changes;
    }
    return byAge + byCap;
  }

  private mintActionId(source: string): string {
    this.mintSeq += 1;
    return `${source}:${this.bootEpoch}:${this.mintSeq}`;
  }

  close(): void {
    this.db.close();
  }
}

function rowToRecord(row: ActionRow): ActionRecord {
  return {
    actionId: row.action_id,
    deviceId: row.device_id,
    onlineSessionId: row.online_session_id,
    invokeId: row.invoke_id,
    conversationId: row.conversation_id,
    toolCallId: row.tool_call_id,
    source: row.source as ActionRecord["source"],
    kind: row.kind as ActionKind,
    target: row.target,
    contentHash: row.content_hash,
    contentBytes: row.content_bytes,
    status: row.status as ActionRecord["status"],
    error: row.error,
    resultSummary: row.result_summary,
    bootEpoch: row.boot_epoch,
    pid: row.pid,
    startedAt: row.started_at,
    settledAt: row.settled_at,
  };
}

function truncate(value: string | undefined | null, max = 512): string | null {
  if (value === undefined || value === null) return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function sha256(data: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 测试/清理辅助：删除临时文件失败残留（best-effort）。 */
export function cleanupTempQuietly(tmpPath: string): void {
  try { rmSync(tmpPath, { force: true }); } catch { /* best-effort */ }
}
