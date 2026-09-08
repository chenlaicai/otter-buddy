/**
 * 编排链滞留看门狗（#822）：任一中断类型（熔断/工具超时/重启）发生后，
 * 链悬置无告警的可见性缺口修复。
 *
 * 与 RHI chain_stall（detect-signals.ts，F 文档 PR 停滞检测，天级节拍）的分工：
 * 本看门狗盯「编排链最后一跳之后的会话尾部」——消息级、30min 阈值、进程内分钟级轮询。
 * 复用的是 RHI 的信号语义框架（signal-registry 注册 + signals 表 upsert + critical 级），
 * 检测器与节拍器独立实现（RhiScanWorker 1h 节拍不满足 30min 验收，见 issue #822 验收标准）。
 *
 * 判据（Why 不用 dispatch_attempts 台账 in_progress 行）：
 * 链引擎在中断后照常 settle attempt 行（invoke 正常返回即 completed——orchestrator 的
 * failTerminal 是 turn 内终态而非 invoke 抛错；进程重启时 markStaleInProgressFailed 落 failed）。
 * 台账行在两种中断形态下都不是「悬置」证据；真正的悬置特征 = 会话尾部是中断型终态消息
 * 且滞留超阈值无人接续——这正是 9/6 事故（20h 无消息）的 DB 形态。
 */

import type { Logger } from "@usecases/ports/logger";

/** 会话尾部行（检测器的最小输入面——repo 直查 SQL，避免接口膨胀） */
export interface TailRow {
  conversationId: string;
  messageId: string;
  senderType: "user" | "otter" | "system";
  senderId: string;
  status: string;
  createdAt: string;
  /** 消息最后 segment 的 body（中断声明恒为末段：failMessage 追加在半截内容之后；
   *  独立系统消息则本就是唯一 segment） */
  body: string;
}

/** 检测出的链滞留（一条 = 一个悬置会话） */
export interface ChainStallAlert {
  conversationId: string;
  messageId: string;
  /** 中断来源獭（otter 消息的 senderId；system 中断消息时为 null） */
  otterId: string | null;
  /** 滞留分钟数（向下取整，展示用） */
  stalledMinutes: number;
  /** 中断类型判定（人类可读，进入告警文案） */
  interruptionKind: string;
  /** 最后动作摘要（进入告警文案） */
  lastActionSummary: string;
}

/** 默认滞留阈值 30min（issue #822 建议值） */
export const CHAIN_STALL_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * 中断型终态的文案短语（封闭集）。文案由 retry-policy.ts / reconcile-orphans.ts 的
 * 纯函数生成（单一来源），不随 LLM 输出漂移。
 * Why includes 而非 startsWith：failMessage 路径的中断声明追加在消息末段——
 * 前面可能拼接半截 streaming 内容，完整拼接串的开头不是系统前缀。
 */
const INTERRUPTION_PHRASES = [
  "[系统保护] 检测到输出内容异常重复，已自动中断",
  "[系统保护] 生成过程超时，已自动中断",
  "[系统保护] 模型响应超时，已自动中断",
  "[系统保护] 单次工具调用超时，已自动中断",
  "[系统保护] 检测到工具调用异常循环，已自动中断",
  "[系统保护] 检测到针对主进程的不允许命令",
  "[系统保护] 输出异常，已自动中断",
  "[系统保护] 该獭连续输出退化且已达熔断上限，发言已中断。如需恢复请重启该獭。",
  "[服务重启，发言中断]",
  // #845 严重发现 1：429 限流终态尾部形态（orchestrator.handleApiError 先 sendSystem 告警
  // 后 failTerminal → 尾部恒为限流告警消息，不在封闭集内则永不告警）。#543 事故同型实证。
  "配额耗尽（429 限流终态），本轮发言已终止", // [系统告警] 配额耗尽（buildRateLimitSystemMsg）
];

/**
 * 排除项（Why：有后续指引或链路仍活着的消息不是悬置终态——告警会淹没真正需要人的现场）：
 * - 「[搭档中断]」（buildUserAbortBody）：用户主动停，设计内行为；
 * - 熔断重启「自动继续执行中」：自动恢复路径，链路接管中；
 * - 重启自动恢复（buildRestartResumeMsg）：恢复服务会重新点火；
 * - 「自动重试」（buildAutoRetryMsg / buildYieldRetryMsg 注入的重试上下文）；
 * - 「自动回发」（guard bounce #731）；
 * - 「请手动重试」（熔断失败/恢复失败终态）：已有明确人工指引，非无主悬置；
 * - 「请人工介入」（guard bounce 超限升级）：同上，且已向用户显式呼救。
 */
const EXCLUDE_PATTERNS: RegExp[] = [
  /\[搭档中断\]/,
  /自动继续执行中/,
  /自动恢复/,
  /自动重试/,
  /自动回发/,
  /请手动重试/,
  /请人工介入/,
];

/**
 * 判定会话尾部消息是否为「中断型悬置终态」；是则返回中断类型描述，否则 null。
 * 输入约定：消息的**最后 segment** body（中断声明恒为末段，见 TailRow.body 注释）。
 */
export function classifyInterruption(body: string): string | null {
  for (const p of EXCLUDE_PATTERNS) {
    if (p.test(body)) return null;
  }
  for (const phrase of INTERRUPTION_PHRASES) {
    if (body.includes(phrase)) {
      const stripped = phrase.replace(/^\[[^\]]+\]\s*/, "");
      return stripped || phrase; // "[服务重启，发言中断]" 整体是标签时返回原文
    }
  }
  return null;
}

/**
 * 纯检测核心：尾部行集 → 滞留告警列表。
 * 输入约定：每个 conversationId 一行（SQL 已按会话聚合取尾行）。
 * 有进展（尾部是 user/otter 活跃消息或非中断 system 消息）→ 不告警；
 * 尾部是中断型消息但未超阈值 → 不告警。
 */
export function detectChainStallFromRows(
  rows: TailRow[],
  now: Date,
  thresholdMs: number = CHAIN_STALL_THRESHOLD_MS,
): ChainStallAlert[] {
  const alerts: ChainStallAlert[] = [];
  for (const row of rows) {
    const kind = classifyInterruption(row.body);
    if (!kind) continue;
    const t = Date.parse(row.createdAt.includes("T") ? row.createdAt : row.createdAt.replace(" ", "T") + "Z");
    if (!Number.isFinite(t)) continue; // 脏时间戳不告警（宁漏勿扰）
    const elapsed = now.getTime() - t;
    if (elapsed < thresholdMs) continue;
    alerts.push({
      conversationId: row.conversationId,
      messageId: row.messageId,
      otterId: row.senderType === "otter" ? row.senderId : null,
      stalledMinutes: Math.floor(elapsed / 60000),
      interruptionKind: kind,
      lastActionSummary: summarize(row.body),
    });
  }
  return alerts;
}

/** 最后动作摘要：去前缀标签、压空白、截 80 字符（告警文案一行可读） */
function summarize(body: string): string {
  const cleaned = body.replace(/^\[[^\]]+\]\s*/, "").replace(/\s+/g, " ").trim();
  return cleaned.length > 80 ? `${cleaned.slice(0, 80)}…` : cleaned;
}

/** 告警文案（对话内系统消息 + RHI evidence 共用单一来源） */
export function buildStallAlertBody(a: ChainStallAlert, chainLabel: string): string {
  return `[链滞留告警] 链 ${chainLabel} 已滞留 ${a.stalledMinutes} 分钟（中断类型：${a.interruptionKind}）。最后动作：${a.lastActionSummary}。请重新派工或向搭档报告（#822 看门狗）。`;
}

// ─────────────────────────────────────────────────────────────────────────────

import type Database from "better-sqlite3";
import type { SignalRepository } from "./signal-repository";
import type { DispatchAttemptRepo } from "@entities/conversation/dispatch-attempt";

/** 对话内系统消息端口（bootstrap 注入 uc.sendMessage.sendSystem；测试可注入桩） */
export type SystemMessageSink = (conversationId: string, body: string) => Promise<unknown>;

export interface ChainStallWatchdogOptions {
  /** 轮询间隔（默认 60s——阈值 30min + 轮询 60s ⇒ 中断→告警最坏 31min 可见；
   *  SQL 是毫秒级索引查询，分钟级轮询代价可忽略） */
  pollMs?: number;
  /** 滞留阈值（默认 CHAIN_STALL_THRESHOLD_MS=30min；测试注入缩短） */
  thresholdMs?: number;
  /** 时钟端口（测试注入固定时间；缺省 new Date()） */
  now?: () => Date;
  /** 派发台账（可选注入——告警时给该会话 in_progress 行补账面备注，排查时台账可见） */
  dispatchAttemptRepo?: DispatchAttemptRepo;
}

/** 看门狗信号类型（signal-registry 单一真相源的镜像引用处见 SIGNAL_REGISTRY） */
export const CHAIN_STALL_WATCHDOG_SIGNAL_TYPE = "chain_stall_watchdog";

/**
 * 编排链滞留看门狗 Worker（#822 方案 1）。
 * 生命周期模式与 RhiScanWorker 一致：start/stop + inflightTick 防重入 + 单轮失败不抛出。
 *
 * 去重（Why 不建去重表）：
 * - 对话内告警消息发出后即成为该会话的新尾行（非中断型）→ 下一轮天然 skip——
 *   幂等是数据形态自带的，无需显式状态；
 * - signals 表 upsert 的同键（type + feature_id=conversationId）occurrences 累加即去重。
 * 信号生命周期（open→resolved）归本 worker 自管：本轮未复现的会话行主动 resolve——
 * signal-pipeline 的 auto-resolve 已排除本类型（两生产者不同键空间，见 pipeline 注释）。
 */
export class ChainStallWatchdogWorker {
  private timer: NodeJS.Timeout | null = null;
  private inflightTick: Promise<void> | null = null;
  private stopped = true;

  constructor(
    private readonly db: Database.Database,
    private readonly signalRepo: SignalRepository,
    private readonly sendSystem: SystemMessageSink,
    private readonly logger: Logger,
    private readonly options: ChainStallWatchdogOptions = {},
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const interval = this.options.pollMs ?? 60_000;
    this.timer = setInterval(() => {
      this.inflightTick = this.tickSafely();
    }, interval);
    this.timer?.unref?.(); // #460 同款：不阻止进程自然退出
    this.logger.info("Chain stall watchdog started", { action: "chain_watchdog_start", pollMs: interval });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inflightTick) await this.inflightTick;
    this.logger.info("Chain stall watchdog stopped", { action: "chain_watchdog_stop" });
  }

  /** 单轮扫描（可独立调用，测试用）：检测滞留 → 逐条告警（sendSystem + RHI 信号 + 台账备注） */
  async scanOnce(): Promise<{ alerts: number }> {
    const now = this.options.now ? this.options.now() : new Date();
    const rows = this.fetchTailRows();
    const alerts = detectChainStallFromRows(rows, now, this.options.thresholdMs ?? CHAIN_STALL_THRESHOLD_MS);
    const notifyFailed = new Set<string>();
    for (const a of alerts) {
      if (!(await this.raiseAlert(a, now))) notifyFailed.add(a.conversationId);
    }
    this.reconcileWatchdogSignals(alerts, notifyFailed);
    return { alerts: alerts.length };
  }

  /** 活跃会话的尾行（每会话一行；最后 segment body——中断声明恒为末段） */
  private fetchTailRows(): TailRow[] {
    return this.db.prepare(`
      SELECT m.conversation_id AS conversationId, m.id AS messageId,
             m.sender_type AS senderType, m.sender_id AS senderId,
             m.status AS status, m.created_at AS createdAt,
             (SELECT s.body FROM message_segments s
               WHERE s.message_id = m.id ORDER BY s.sequence_num DESC LIMIT 1) AS body
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id AND c.status = 'active'
      WHERE m.sequence_num = (SELECT MAX(m2.sequence_num) FROM messages m2
                               WHERE m2.conversation_id = m.conversation_id)
    `).all() as unknown as TailRow[];
  }

  /** 单条告警：对话内系统消息 + RHI critical 信号 + 台账 in_progress 行备注。
   *  三路各自 try/catch（传感器分离）：任一路失败不影响其余两路，单轮失败不停摆。
   *  返回 false = sendSystem 失败（对话内去重依赖告警消息成为新尾行——注入失败时
   *  尾行仍是中断型，下轮会重复检出，reconcile 必须跳过该会话防信号翻转，#845 建议发现 1）。 */
  private async raiseAlert(a: ChainStallAlert, now: Date): Promise<boolean> {
    const chainLabel = a.conversationId.slice(0, 8);
    const body = buildStallAlertBody(a, chainLabel);

    let notifyOk = true;
    try {
      await this.sendSystem(a.conversationId, body);
    } catch (e) {
      notifyOk = false;
      this.logger.warn("[chain-watchdog] 告警系统消息注入失败（其余通路继续）", {
        action: "chain_watchdog_notify_error", conversationId: a.conversationId,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    try {
      // Why feature_id 承载 conversationId：watchdog 专用约定（非 F 文档 ID）——
      // signals upsert 键 = type + feature_id，按会话分行让 occurrences 各自累计、
      // auto-resolve 按会话独立判定；面板上该类型信号展示会话粒度现场
      this.signalRepo.upsert({
        signalType: CHAIN_STALL_WATCHDOG_SIGNAL_TYPE,
        severity: "critical",
        featureId: a.conversationId,
        filePath: null,
        evidence: `${chainLabel} 中断后滞留 ${a.stalledMinutes} 分钟无人接续（${a.interruptionKind}）`,
        suggestedAction: "检查该会话中断原因，重新派工或人工接管",
      }, now);
    } catch (e) {
      this.logger.warn("[chain-watchdog] RHI 信号落库失败（其余通路继续）", {
        action: "chain_watchdog_signal_error", conversationId: a.conversationId,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    const repo = this.options.dispatchAttemptRepo;
    if (!repo) return notifyOk;
    try {
      const rows = this.db.prepare(
        "SELECT message_id AS messageId, target_otter_id AS targetOtterId FROM dispatch_attempts WHERE status = 'in_progress' AND conversation_id = ?",
      ).all(a.conversationId) as Array<{ messageId: string; targetOtterId: string }>;
      for (const r of rows) {
        repo.appendNote(r.messageId, r.targetOtterId, `链滞留告警（${a.stalledMinutes}min，${a.interruptionKind}）`);
      }
    } catch (e) {
      this.logger.warn("[chain-watchdog] 台账备注失败（纯观测面，继续）", {
        action: "chain_watchdog_ledger_note_error", conversationId: a.conversationId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return notifyOk;
  }

  /** 本轮未复现的会话 → resolve 其 open 信号（watchdog 信号生命周期自管，
   *  与 SignalPipeline.auto-resolve 同语义但键空间独立，见 pipeline 的排除注释）。
   *  notifyFailed：本轮 sendSystem 失败的会话不参与 reconcile——对话内去重未生效，
   *  会话下轮必然重复检出，此时 resolve 只会造成 open/resolved 每 60s 翻转（#845）。 */
  private reconcileWatchdogSignals(alerts: ChainStallAlert[], notifyFailed: ReadonlySet<string>): void {
    try {
      const detected = new Set(alerts.map(a => a.conversationId));
      const open = this.signalRepo.findOpen().filter(s => s.signal_type === CHAIN_STALL_WATCHDOG_SIGNAL_TYPE);
      for (const s of open) {
        if (s.feature_id && (detected.has(s.feature_id) || notifyFailed.has(s.feature_id))) continue;
        this.signalRepo.resolve(s.id);
      }
    } catch (e) {
      this.logger.warn("[chain-watchdog] 信号 reconcile 失败（不停摆）", {
        action: "chain_watchdog_reconcile_error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async tickSafely(): Promise<void> {
    try {
      const result = await this.scanOnce();
      if (result.alerts > 0) {
        this.logger.warn("[chain-watchdog] 链滞留告警已发出", {
          action: "chain_watchdog_alerted", alerts: result.alerts,
        });
      }
    } catch (err) {
      this.logger.error("[chain-watchdog] 扫描轮失败，等下一轮", err instanceof Error ? err : undefined, {
        action: "chain_watchdog_tick_error",
      });
    }
  }
}
