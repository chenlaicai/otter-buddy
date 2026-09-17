/**
 * SignalRepository: signals 表读写（Issue #399/#400）
 *
 * 信号状态机：open → (acknowledged) → resolved/dismissed。
 * 相同 signal_type + feature_id/file_path 的重复触发做 occurrences 累加
 * 而非新开一行（特性文档 signals 表设计：first_seen/last_seen/occurrences）。
 */

import type Database from "better-sqlite3";

export interface SignalRecord {
  id: number;
  signal_type: string;
  severity: string;
  feature_id: string | null;
  file_path: string | null;
  evidence: string;
  first_seen: string;
  last_seen: string;
  occurrences: number;
  status: string;
  suggested_action: string | null;
  created_at: string;
  resolved_at: string | null;
  /** 结构化证据详情 JSON（Issue #644，如 bug_recurrence 全类型 commit 序列）。null=无 */
  evidence_detail: string | null;
  /** 置信度：low=大概率误报（UI 折叠收纳）。null=normal（存量默认） */
  confidence: string | null;
  /** F20260917trig：处置状态机——NULL/'open'=未接单；'triaged'=已归口；'in_progress'=修复中。终态仍走 status */
  triage_status: string | null;
  /** F20260917trig：绑定的 GitHub issue 编号（处置锚点） */
  issue_number: number | null;
  /** F20260917trig：归口时间（老化计时起点之一） */
  triaged_at: string | null;
  /** F20260917trig：处置说明（如「并入 #1012」「误报，阈值问题见 #1012」） */
  triage_note: string | null;
}

export interface UpsertSignal {
  signalType: string;
  severity: string;
  featureId: string | null;
  filePath: string | null;
  evidence: string;
  suggestedAction: string | null;
  /** 结构化证据详情（可选——窗口滑动时整体重算覆盖，非 append） */
  evidenceDetail?: unknown;
  /** 置信度（可选，缺省 normal） */
  confidence?: string | null;
}

export class SignalRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * upsert：open 状态的同键信号 occurrences+1 / last_seen 刷新；
   * 无匹配则新开一行。返回受影响行。
   */
  upsert(signal: UpsertSignal, seenAt: Date = new Date()): SignalRecord {
    const now = seenAt.toISOString();
    const detailJson = signal.evidenceDetail !== undefined
      ? JSON.stringify(signal.evidenceDetail)
      : null;

    const existing = this.db
      .prepare(`
        SELECT * FROM signals
        WHERE status = 'open' AND signal_type = ?
          AND COALESCE(feature_id, '') = COALESCE(?, '')
          AND COALESCE(file_path, '') = COALESCE(?, '')
        ORDER BY id DESC LIMIT 1
      `)
      .get(signal.signalType, signal.featureId, signal.filePath) as SignalRecord | undefined;

    if (existing) {
      // Issue #644：UPDATE 分支必须同步刷 evidence_detail + confidence——只刷旧三字段
      // 会导致存量信号的置信分层永远不更新（合议审读 §3.1）。COALESCE 语义：本次未传
      // 时不覆盖旧值（旧行为调用方不受影响）；窗口滑动重算时传新值覆盖。
      // Issue #645 审视 S1：severity / suggested_action 同理必须刷——僵尸阶梯是首个
      // 让同一信号 severity 随时间变化的功能（黄档首开→红档推进），不刷则档位冻结、
      // 消费侧按 severity 路由失效。severity 必传直接覆盖（其余 8 类传入值=注册表
      // 常量=存量值，零行为变化）；suggested_action 可空走 COALESCE（同防御语义）。
      this.db
        .prepare(`UPDATE signals SET
            last_seen = ?,
            occurrences = occurrences + 1,
            evidence = ?,
            evidence_detail = COALESCE(?, evidence_detail),
            confidence = COALESCE(?, confidence),
            severity = ?,
            suggested_action = COALESCE(?, suggested_action)
          WHERE id = ?`)
        .run(now, signal.evidence, detailJson, signal.confidence ?? null,
             signal.severity, signal.suggestedAction, existing.id);
      return this.coalesceExisting(existing, signal, detailJson, now);
    }

    // id 为 INTEGER PRIMARY KEY AUTOINCREMENT（Phase 0 schema 定义），用自增 id 而非 UUID
    return this.insertNew(signal, detailJson, now);
  }

  /** INSERT 新行分支（upsert 拆出控行数）——triage 四字段取默认值 NULL
   *  （F20260917trig §3 末：复发新行不继承旧行绑定/note，视为新事件走完整未接单流程） */
  private insertNew(signal: UpsertSignal, detailJson: string | null, now: string): SignalRecord {
    const r = this.db
      .prepare(`
        INSERT INTO signals (signal_type, severity, feature_id, file_path, evidence,
                             first_seen, last_seen, occurrences, status, suggested_action,
                             evidence_detail, confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'open', ?, ?, ?)
      `)
      .run(
        signal.signalType, signal.severity, signal.featureId, signal.filePath,
        signal.evidence, now, now, signal.suggestedAction,
        detailJson, signal.confidence ?? null,
      );
    const id = Number(r.lastInsertRowid);
    return {
      id,
      signal_type: signal.signalType,
      severity: signal.severity,
      feature_id: signal.featureId,
      file_path: signal.filePath,
      evidence: signal.evidence,
      first_seen: now,
      last_seen: now,
      occurrences: 1,
      status: "open",
      suggested_action: signal.suggestedAction,
      created_at: now,
      resolved_at: null,
      evidence_detail: detailJson,
      confidence: signal.confidence ?? null,
      triage_status: null,
      issue_number: null,
      triaged_at: null,
      triage_note: null,
    };
  }

  /** Issue #644/#645：UPDATE 分支返回值拼装——与 SQL 侧刷新列保持一致
   *  （detail/confidence COALESCE、severity/suggested_action 覆盖、计数刷新） */
  private coalesceExisting(
    existing: SignalRecord,
    signal: UpsertSignal,
    detailJson: string | null,
    now: string,
  ): SignalRecord {
    return {
      ...existing,
      last_seen: now,
      occurrences: existing.occurrences + 1,
      evidence: signal.evidence,
      evidence_detail: detailJson !== null ? detailJson : existing.evidence_detail,
      confidence: signal.confidence ?? existing.confidence,
      severity: signal.severity,
      suggested_action: signal.suggestedAction ?? existing.suggested_action,
    };
  }

  findOpen(): SignalRecord[] {
    return this.db
      .prepare("SELECT * FROM signals WHERE status = 'open' ORDER BY last_seen DESC")
      .all() as SignalRecord[];
  }

  findByStatus(status: string): SignalRecord[] {
    return this.db
      .prepare("SELECT * FROM signals WHERE status = ? ORDER BY last_seen DESC")
      .all(status) as SignalRecord[];
  }

  resolve(id: number, resolvedAt: Date = new Date()): boolean {
    // F20260917trig §6：auto-resolve/resolve 终态化时同步抹平处置进度字段
    // （triage_status/issue_number 置 NULL，triage_note 保留作历史痕迹）——
    // 终态覆盖进度，进度只在 open 期内有意义（§6 选项 b 语义）。
    const r = this.db
      .prepare(`UPDATE signals SET status = 'resolved', resolved_at = ?,
        triage_status = NULL, issue_number = NULL
        WHERE id = ? AND status = 'open'`)
      .run(resolvedAt.toISOString(), id);
    return r.changes > 0;
  }

  dismiss(id: number, resolvedAt: Date = new Date()): boolean {
    // 抹平语义同 resolve（§6）——dismiss 也是终态化。
    const r = this.db
      .prepare(`UPDATE signals SET status = 'dismissed', resolved_at = ?,
        triage_status = NULL, issue_number = NULL
        WHERE id = ? AND status = 'open'`)
      .run(resolvedAt.toISOString(), id);
    return r.changes > 0;
  }

  /**
   * F20260917trig：处置进度写入的唯一入口（§1 写入边界防御声明）。
   * agent 工具与 HTTP 端点均调用此方法，任何入口不得各自实现 SQL（§2 架构约束 F3）。
   *
   * action 语义（§2 幂等语义表）：
   * - bind_issue：triage_status='triaged', issue_number=N, triaged_at=now（覆盖式更新，允许换绑）
   * - in_progress：triage_status='in_progress'（前置须已 bind_issue；幂等跳过）
   * - dismiss：status='dismissed' 终态 + triage_note=note 必写库（note 必填；幂等跳过）
   */
  triage(
    id: number,
    action: "bind_issue" | "in_progress" | "dismiss",
    opts: { issueNumber?: number; note?: string; now?: Date } = {},
  ): { ok: boolean; reason?: string; record?: SignalRecord } {
    const existing = this.db.prepare("SELECT * FROM signals WHERE id = ?").get(id) as SignalRecord | undefined;
    if (!existing) return { ok: false, reason: `信号 ${id} 不存在` };
    const now = (opts.now ?? new Date()).toISOString();
    switch (action) {
      case "bind_issue": return this.triageBindIssue(id, existing, opts, now);
      case "in_progress": return this.triageInProgress(id, existing);
      case "dismiss": return this.triageDismiss(id, existing, opts, now);
    }
  }

  /** bind_issue：triage_status='triaged', issue_number=N, triaged_at=now（覆盖式更新，允许换绑） */
  private triageBindIssue(
    id: number, existing: SignalRecord,
    opts: { issueNumber?: number; note?: string }, now: string,
  ): { ok: boolean; reason?: string; record?: SignalRecord } {
    if (existing.status !== "open") {
      return { ok: false, reason: `信号 ${id} 已是终态 ${existing.status}，不可归口` };
    }
    if (!opts.issueNumber) return { ok: false, reason: "bind_issue 的 issueNumber 必填" };
    this.db.prepare(`UPDATE signals SET
        triage_status = 'triaged', issue_number = ?, triaged_at = ?,
        triage_note = COALESCE(?, triage_note)
      WHERE id = ?`)
      .run(opts.issueNumber, now, opts.note ?? null, id);
    return { ok: true, record: this.findById(id) };
  }

  /** in_progress：triage_status='in_progress'（前置须已 bind_issue；幂等跳过） */
  private triageInProgress(
    id: number, existing: SignalRecord,
  ): { ok: boolean; reason?: string; record?: SignalRecord } {
    if (existing.status !== "open") {
      return { ok: false, reason: `信号 ${id} 已是终态 ${existing.status}，不可标修复中` };
    }
    // 幂等跳过：已 in_progress 重复调无副作用
    if (existing.triage_status === "in_progress") {
      return { ok: true, reason: "幂等：已是 in_progress", record: existing };
    }
    // 前置：须已 bind_issue（§2 参数约束）
    if (existing.triage_status !== "triaged" || !existing.issue_number) {
      return { ok: false, reason: "in_progress 前置：须先 bind_issue 归口" };
    }
    this.db.prepare("UPDATE signals SET triage_status = 'in_progress' WHERE id = ?").run(id);
    return { ok: true, record: this.findById(id) };
  }

  /** dismiss：status='dismissed' 终态 + triage_note 必写库（note 必填；幂等跳过） */
  private triageDismiss(
    id: number, existing: SignalRecord,
    opts: { note?: string }, now: string,
  ): { ok: boolean; reason?: string; record?: SignalRecord } {
    if (!opts.note || !opts.note.trim()) {
      return { ok: false, reason: "dismiss 的 note 必填——不处置必须是判断结论，不能是沉默" };
    }
    if (existing.status !== "open") {
      return { ok: true, reason: `幂等：已是终态 ${existing.status}`, record: existing };
    }
    this.db.prepare(`UPDATE signals SET
        status = 'dismissed', resolved_at = ?, triage_status = NULL, issue_number = NULL,
        triage_note = ?
      WHERE id = ? AND status = 'open'`)
      .run(now, opts.note.trim(), id);
    return { ok: true, record: this.findById(id) };
  }

  /** F20260917trig：按处置状态查询（list_rhi_signals 工具的 triageStatus 过滤数据源）。
   *  triageStatus='null' 或 'open' 时查未接单（triage_status IS NULL）。 */
  findByTriageStatus(triageStatus: string | null, status = "open"): SignalRecord[] {
    if (triageStatus === null || triageStatus === "open" || triageStatus === "null") {
      return this.db
        .prepare("SELECT * FROM signals WHERE status = ? AND triage_status IS NULL ORDER BY first_seen ASC")
        .all(status) as SignalRecord[];
    }
    return this.db
      .prepare("SELECT * FROM signals WHERE status = ? AND triage_status = ? ORDER BY triaged_at ASC")
      .all(status, triageStatus) as SignalRecord[];
  }

  findById(id: number): SignalRecord | undefined {
    return this.db.prepare("SELECT * FROM signals WHERE id = ?").get(id) as SignalRecord | undefined;
  }

  /** 已解决/已忽略信号保留 N 天后清除（数据保留策略） */
  purgeClosed(days: number): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.db
      .prepare("DELETE FROM signals WHERE status != 'open' AND COALESCE(resolved_at, '') < ?")
      .run(cutoff).changes;
  }
}
