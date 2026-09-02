import type { ConversationRepository } from "./conversation-repository";
import type { QueryMessage } from "./query-message";
import type { DispatchAttemptRepo } from "@entities/conversation/dispatch-attempt";
import type { Logger } from "@usecases/ports/logger";
import type {
  SignalTrailItemDTO,
  SignalTrailResponseDTO,
} from "@contract/api/message";

/** 信号轨迹扫描窗口：与 SignalRouter.SCAN_LIMIT 同量级（信号风暴护栏，防止全表扫描） */
const SCAN_LIMIT = 200;

/**
 * 信号轨迹查询（F20260902u5tr → F20260902sgp2 S1b 判据切台账）。
 *
 * 职责：把「消息表里的投石信号」投影为「对目标 otter 的投递状态」，状态全部在
 * 服务端从持久层推导——前端零推导，重启前后 UI 一致。
 *
 * S1b 判据切换（§4.7）：状态真相源从「游标 + streaming 5min 窗」换为 dispatch_attempts
 * 台账（与 v2 路由器 pending 判据单一真相源，SqliteDispatchAttemptRepo.pendingClause）：
 *   无记录       → PENDING   排队待消化（排队=还没派发；游标滞后不再冒充 pending——
 *                            多獭会话「永远排队」徽标痊愈）
 *   in_progress  → CONSUMING 处理中（持久行，无墙钟窗，长链不再 ⚡→⏳ 状态倒退）
 *   completed    → CONSUMED  已处理
 *   failed/aborted → FAILED  处理失败（title 显 note——失败可见，用户决定是否 retry）
 *
 * Date.now() 已从判定路径消失：四态全部是持久层纯函数，「UI 状态 = f(持久层)」
 * 从 v1 的近似（5min 窗混入墙钟）变为严格成立。
 *
 * 信号判据（与路由器 queryCandidateSignals / 墓碑 backfill 同源）：
 *   status = 'completed' AND sender_type != 'system'
 *   AND talking_stone_passed_to 含至少一个 otter 目标（排除 'user'）
 */
export class QuerySignalTrail {
  constructor(private readonly deps: {
    conversationRepo: ConversationRepository;
    queryMessage: QueryMessage;
    /** S1b：台账（判据真相源）。可选注入——缺省时全部信号降级 PENDING（装配不完整时 UI 保守不撒谎） */
    dispatchAttemptRepo?: DispatchAttemptRepo;
    /** 可选：未知 attempt status 的降级告警（#735 审视建议 1） */
    logger?: Logger;
  }) {}

  async list(conversationId: string): Promise<SignalTrailResponseDTO> {
    const messages = await this.deps.queryMessage.getMessages(conversationId, { limit: SCAN_LIMIT });

    const signals = messages.filter(m =>
      m.status === "completed" && m.senderType !== "system"
      && (m.talkingStonePassedTo ?? []).some(t => t !== "user"),
    );

    // 台账批量拉取：一次查本会话全部 attempt（(message,target) 唯一键 → Map 直查，
    // 无逐信号 N+1）。S1b 前曾按游标+streaming 推导，含 Date.now() 墙钟窗
    const attempts = this.loadAttempts(conversationId);

    const items: SignalTrailItemDTO[] = [];
    for (const m of signals) {
      for (const targetId of (m.talkingStonePassedTo ?? []).filter(t => t !== "user")) {
        const attempt = attempts.get(`${m.id}:${targetId}`);
        items.push(this.toTrailItem(m, targetId, attempt));
      }
    }
    // 时序展示：旧→新（seq 升序；seq 由 sequence_num NOT NULL 保证存在）
    items.sort((a, b) => a.seq - b.seq);
    return { items };
  }

  /** 信号 × 目标 → 轨迹条目（state 只算一次——mimo 审视整洁建议） */
  private toTrailItem(
    m: { id: string; senderType: string; senderId: string; signalLevel?: string | null; createdAt: string; sequenceNum: number },
    targetId: string,
    attempt: { status: string; note: string | null } | undefined,
  ): SignalTrailItemDTO {
    const attemptStatus = attempt?.status;
    // 未知 status（内部枚举未来扩展）降级 PENDING 但留日志（#735 审视建议 1）——
    // 内部扩展不该让前端坏，但静默吞掉会让排查断线；
    // 第一道防线其实在 schema CHECK 约束（非法值进不了台账），这里是二道防线
    if (attemptStatus !== undefined && !KNOWN_ATTEMPT_STATUSES.has(attemptStatus)) {
      this.deps.logger?.warn("[signal-trail] 未知 attempt status，降级 PENDING", {
        attemptStatus, messageId: m.id, targetOtterId: targetId,
      });
    }
    const state = resolveTrailState(attemptStatus);
    return {
      messageId: m.id,
      fromType: m.senderType === "otter" ? "otter" : "user",
      fromId: m.senderId,
      targetOtterId: targetId,
      // 档位归一与 SignalRouter.routeTarget 一致：NULL 列值 = NORMAL（用户投石路径不写列）
      level: (m.signalLevel ?? "NORMAL").toUpperCase(),
      state,
      ts: m.createdAt,
      seq: m.sequenceNum,
      // FAILED 态带失败原因（含 retry 前情压缩——§8.2）；其余态不带
      note: state === "FAILED" ? (attempt?.note ?? null) : null,
    };
  }

  /** 本会话台账快照：key = `${messageId}:${targetOtterId}`（UNIQUE 键同构） */
  private loadAttempts(conversationId: string): Map<string, { status: string; note: string | null }> {
    const map = new Map<string, { status: string; note: string | null }>();
    if (!this.deps.dispatchAttemptRepo) return map;
    try {
      // 经 DispatchAttemptRepo.listAttemptsForConversation（S1b 新增，SQL 聚合在 repo 层，
      // 与 pendingClause 同文件同真相源）；失败降级空表——轨迹是增强信息，台账异常不阻塞消息流
      for (const a of this.deps.dispatchAttemptRepo.listAttemptsForConversation(conversationId)) {
        map.set(`${a.messageId}:${a.targetOtterId}`, { status: a.status, note: a.note });
      }
    } catch {
      // 降级：全部信号显示 PENDING（保守不撒谎——没读到账不能假装有账）
    }
    return map;
  }
}

/** attempt status → UI 四态（§4.7 映射表；failed/aborted 归并 FAILED） */
function resolveTrailState(attemptStatus: string | undefined): SignalTrailItemDTO["state"] {
  switch (attemptStatus) {
    case "in_progress": return "CONSUMING";
    case "completed": return "CONSUMED";
    case "failed":
    case "aborted": return "FAILED";
    default: return "PENDING"; // 无记录（含 repo 未注入/查询降级）= 排队待消化；未知值降级由调用方告警
  }
}

/** DispatchAttempt.status 已知值域（dispatch-attempt.ts 同款）；未知值降级 PENDING + warn */
const KNOWN_ATTEMPT_STATUSES = new Set(["in_progress", "completed", "failed", "aborted"]);
