import type { ConversationRepository } from "./conversation-repository";
import type { QueryMessage } from "./query-message";
import type {
  SignalTrailItemDTO,
  SignalTrailResponseDTO,
} from "@contract/api/message";

/** 信号轨迹扫描窗口：与 SignalRouter.SCAN_LIMIT 同量级（信号风暴护栏，防止全表扫描） */
const SCAN_LIMIT = 200;
/** 目标活跃判定窗口：最新 streaming 消息 5min 内视为在消化（与 SignalRouter.ACTIVE_WINDOW_MS 同语义） */
const ACTIVE_WINDOW_MS = 5 * 60_000;

/** 参与者游标快照（轻量投影，一次拉取避免逐信号 N+1） */
interface CursorSnapshot {
  lastReadTurnNumber: number | null;
  /** 目标最新消息是否 streaming（CONSUMING 判定用） */
  streaming: boolean;
}

/**
 * 信号轨迹查询（F20260902u5tr，母方案 F20260901sgpx §7 展示语义的读路径）。
 *
 * 职责：把「消息表里的投石信号」投影为「对目标 otter 的投递状态」，状态全部在
 * 服务端从持久层推导——前端零推导，重启前后 UI 一致（这是与内存态 busyQueue 的
 * 本质区别：PENDING 显示的是「游标未消费」这一持久事实，而非内存队列位置）。
 *
 * 信号判据（与 SignalRouter.queryCandidateSignals 对齐——路由器怎么消费，轨迹就
 * 怎么展示，两个视图共用一个真相源）：
 *   status = 'completed' AND sender_type != 'system'
 *   AND talking_stone_passed_to 含至少一个 otter 目标（排除 'user'）
 *
 * 投递状态机（SignalTrailState）：
 *   CONSUMED   目标游标已越过信号所在 turn（turn_number < last_read_turn_number）。
 *              生产库实证：user 消息独占 turn、otter 回应独占下一 turn（ensureActiveTurn
 *              按 sender 分 turn），markBatchRead 推进到回应 turn 即覆盖信号 turn，判据干净。
 *   CONSUMING  目标最新消息 streaming 且在窗口内（invoke 进行中，游标尚未推进的窗口）
 *   PENDING    其余（排队待消化）。游标缺省（非活跃参与者）也归此——缺省不能假证已读。
 *              已知边界（busyQueue 注释同款竞态）：busy 獭链尾 markBatchRead 会把
 *              「消费但未注入」的插话标为 CONSUMED——内容已由 busyQueue 快照显式注入，
 *              显示「已处理」与实际语义一致，非说谎。
 */
export class QuerySignalTrail {
  constructor(private readonly deps: {
    conversationRepo: ConversationRepository;
    queryMessage: QueryMessage;
  }) {}

  async list(conversationId: string): Promise<SignalTrailResponseDTO> {
    const [messages, cursors] = await Promise.all([
      this.deps.queryMessage.getMessages(conversationId, { limit: SCAN_LIMIT }),
      this.loadCursors(conversationId),
    ]);

    const signals = messages.filter(m =>
      m.status === "completed" && m.senderType !== "system"
      && (m.talkingStonePassedTo ?? []).some(t => t !== "user"),
    );

    // 信号消息的 turnId 去重后逐个反查 turnNumber（每消息必有 turn_id NOT NULL；
    // 去重后查询数 = 涉及 turn 数，远小于信号数）
    const turnNumbers = new Map<string, number>();
    for (const turnId of [...new Set(signals.map(m => m.turnId))]) {
      const turn = await this.deps.conversationRepo.getTurnById(turnId);
      if (turn) turnNumbers.set(turnId, turn.turnNumber);
    }

    const items: SignalTrailItemDTO[] = [];
    for (const m of signals) {
      const turnNumber = turnNumbers.get(m.turnId) ?? 0;
      for (const targetId of (m.talkingStonePassedTo ?? []).filter(t => t !== "user")) {
        items.push({
          messageId: m.id,
          fromType: m.senderType === "otter" ? "otter" : "user",
          fromId: m.senderId,
          targetOtterId: targetId,
          // 档位归一与 SignalRouter.routeTarget 一致：NULL 列值 = NORMAL（用户投石路径不写列）
          level: (m.signalLevel ?? "NORMAL").toUpperCase(),
          state: this.resolveState(turnNumber, cursors.get(targetId)),
          ts: m.createdAt,
          seq: m.sequenceNum,
        });
      }
    }
    // 时序展示：旧→新（seq 升序；seq 由 sequence_num NOT NULL 保证存在）
    items.sort((a, b) => a.seq - b.seq);
    return { items };
  }

  /** 参与者游标 + streaming 判定，一次拉全 */
  private async loadCursors(conversationId: string): Promise<Map<string, CursorSnapshot>> {
    const participants = await this.deps.conversationRepo.getActiveParticipants(conversationId);
    const cursors = new Map<string, CursorSnapshot>();
    for (const p of participants) {
      const last = await this.deps.queryMessage.getLastMessageBySender(conversationId, p.otterId);
      const streaming = last?.status === "streaming"
        && Number.isFinite(Date.parse(last.createdAt))
        && Date.now() - Date.parse(last.createdAt) < ACTIVE_WINDOW_MS;
      cursors.set(p.otterId, { lastReadTurnNumber: p.lastReadTurnNumber ?? null, streaming });
    }
    return cursors;
  }

  private resolveState(
    signalTurnNumber: number,
    cursor: CursorSnapshot | undefined,
  ): SignalTrailItemDTO["state"] {
    if (!cursor) return "PENDING";
    if (cursor.streaming) return "CONSUMING";
    // 游标缺失（脏数据）不能假证已读：与缺省参与者同归 PENDING
    if (cursor.lastReadTurnNumber == null) return "PENDING";
    if (signalTurnNumber > 0 && signalTurnNumber < cursor.lastReadTurnNumber) return "CONSUMED";
    return "PENDING";
  }
}
