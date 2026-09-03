/**
 * F20260901sgpv（母方案 F20260901sgpx P1）：信号路由器。
 *
 * 职责：把「消息表里的信号」点火为 invoke——入口（web sendMessage / IM / resume
 * 补扫）的调度收敛点。路由动作由 DispatchChainEngine 承载（链引擎 hop 驱动的替代
 * 是 P2 的灰度战场），P1 的核心增量：
 * ① 收件箱 = 游标视图（母方案 §1「存储」的落地）：未消费信号 = 目标獭未读视图内、
 *    指向该獭的 completed 消息；消费 = 链内 markBatchRead 推进游标（既有机制，
 *    路由器自身不写游标——读路径判别、写路径消费，职责分层）
 * ② 档位选通道（NORMAL / URGENT / HALT，见 routeTarget 的 P1 档位矩阵）
 * ③ 同 otter 串行：busy 目标入 busyQueue 保内容，invoke 完成后去抖重扫消化
 *    ——插话不再撞锁超时（P1 验收标准），内容不丢（见 busyQueue Why 注释）
 * ④ 消费失败可见：invoke 异常落 healing 台账（七刀之七——现状锁超时被 allSettled
 *    吞掉用户不可见，是「不可见的坏」）
 *
 * P1 边界（本 PR 不做，防调度双真相源竞态）：
 * - scheduler 入口仍走直连链（其信号为 system 发送者，路由器显式排除——system 信号
 *   入路由与 scheduler 直连并存会造成同一任务双重执行；scheduler 入口化在 P1 后续 PR）
 * - web retry 仍走直连链（需要 manualRetry/images 参数透传，与 scheduler 同批落地）
 * - URGENT 的 steer 直注入 / HALT 的 abort 物理停依赖打断决策协议，归 P3
 */
import type { Message } from "@entities/conversation/message";
import type { DispatchAttemptRepo, PendingSignalRow } from "@entities/conversation/dispatch-attempt";
import type { ConversationRepository } from "./conversation-repository";
import type { QueryMessage } from "./query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { DispatchChainEngine } from "./dispatch-chain-engine";
import type { Logger } from "@usecases/ports/logger";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { HealingErrorType, HealingEventStatus, HealingEvent, HealingSeverity } from "@entities/healing/healing-event";

/** invoke 函数签名（与 AgentInvoker.invokeConversation 对齐的最小面；装配处闭包捕获 agentInvoker） */
export type SignalRouterInvokeFn = (params: {
  otterId: string;
  conversationId: string;
  userMessageContent: string;
  senderId: string;
}) => Promise<{ messageId: string; aggregatedTargets?: string[] }>;

export type RouteAction = "invoked" | "queued_busy" | "skipped_no_target" | "skipped_inactive";

/** busyQueue 条目：busy 目标的待消化信号（内容保全，见 routeTarget 内 Why 注释） */
interface QueuedSignal {
  signalId: string;
  content: string;
  senderId: string;
  level: string;
}

/** 去抖重扫窗口：invoke 结束后等待迟到的信号写入事务提交（母方案 §2 竞态兜底，50ms 语义） */
const DEBOUNCE_MS = 50;
/** 活跃判定窗口：最新 streaming 消息 5min 内视为在干（P4 拆 turn 前的会话级近似）。
 *  F20260902sgp2 S2：仅用于 busy 判定（isOtterActive）——不再参与 pending/消费判定
 *  （那已全面切台账真相源）。 */
const ACTIVE_WINDOW_MS = 5 * 60_000;
/** 未读扫描上界：单次路由的候选消息数（信号风暴护栏；强制中断归 P3 梯度护栏） */
const SCAN_LIMIT = 200;

export class SignalRouter {
  /** 同 otter 串行：key = `${conversationId}:${otterId}`。invoke 进行中不重复点火，
   *  完成后经去抖重扫补路由——信号在消息表/busyQueue 持久，不因跳过而丢失。 */
  private readonly inFlight = new Set<string>();

  /**
   * busyQueue：busy 目标的待消化信号（内存态，崩溃即丢——与现状崩溃等价，可接受）。
   * Why 必须保内容：busy 獭的链结束时 markBatchRead 会把游标推进到自己的 turn，
   * 同 turn 内中途到达的消息（插话主场景！）会被「消费但未注入」——只靠未读视图重扫
   * 拿不回内容。入队时快照内容，消化时作为「当前任务」显式注入（与现状第二条链的
   * userMessageContent 传参同语义），插话语义从「锁超时报错」升级为「排队必达」。
   */
  private readonly busyQueue = new Map<string, QueuedSignal[]>();

  constructor(
    private readonly deps: {
      conversationRepo: ConversationRepository;
      queryMessage: QueryMessage;
      queryOtter: QueryOtter;
      dispatchChainEngine: DispatchChainEngine;
      invokeFn: SignalRouterInvokeFn;
      logger: Logger;
      healingRepo?: HealingEventRepository;
      /** F20260902sgp2 S2：派发台账——pending 真相源（已投递 ∧ 无派发记录）。
       *  必注入：路由器无台账不构成 v2 语义（装配层保证）。 */
      dispatchAttemptRepo: DispatchAttemptRepo;
    },
  ) {}

  /**
   * 路由一个会话内的未消费信号。
   *
   * 触发时机（F20260901sgpv）：
   * - web sendMessage：user 消息落库后（信号 = talkingStonePassedTo 指向的每个獭）
   * - IM（飞书）：消息入库后经 AgentDispatchService 调用（隐式目标查询随之退役）
   * - resume：启动补扫（崩溃窗口兜底——写路径回调没能执行的信号在此补路由）
   *
   * 幂等性（F20260902sgp2 S2）：消费判定 = 派发台账（pending := 已投递 ∧
   * 无 (message,target) 记录）——不再依赖游标视图。链引擎每次派发即销账
   * （recordStart），重复调用最坏代价是空扫描。
   *
   * @param filter.otterId 仅路由发往该 otter 的信号（单目标场景）
   * @returns 各信号的路由结果（记日志/测试断言用，不用于流程控制）
   */
  async routePendingSignals(
    conversationId: string,
    filter?: { otterId?: string },
  ): Promise<Array<{ signal: Message; action: RouteAction }>> {
    // S2：一次台账查询取全部 pending (message,target) 对，按目标分组——
    // 替代 v1 的「先候选后逐目标未读视图」两段式（游标判据已退役）
    const pendingRows = await this.deps.dispatchAttemptRepo.listPendingSignals(conversationId, SCAN_LIMIT);
    const byTarget = new Map<string, PendingSignalRow[]>();
    for (const row of pendingRows) {
      if (filter?.otterId && row.targetOtterId !== filter.otterId) continue;
      const list = byTarget.get(row.targetOtterId) ?? [];
      list.push(row);
      byTarget.set(row.targetOtterId, list);
    }
    const results: Array<{ signal: Message; action: RouteAction }> = [];

    for (const [targetId, rows] of byTarget) {
      // 每目标取最新一条信号驱动路由决策（档位以最新为准；同批多条由同一次 invoke 的未读注入统一消化）
      const newest = rows[rows.length - 1];
      const signal = await this.loadSignalMessage(newest.messageId);
      if (!signal) {
        this.deps.logger.warn("[signal-router] pending 信号消息缺失，跳过", { conversationId, messageId: newest.messageId, targetId });
        continue;
      }
      const action = await this.routeTarget(conversationId, targetId, signal);
      results.push({ signal, action });
    }
    return results;
  }

  /** 按 ID 加载信号消息原文（台账行只有 ID；档位/内容/发送者需要完整实体）。 */
  private async loadSignalMessage(messageId: string): Promise<Message | null> {
    try {
      const msg = await this.deps.queryMessage.getMessageById(messageId);
      return msg ?? null;
    } catch {
      return null;
    }
  }

  /** 路由全部会话的未消费信号（启动补扫专用，RIS 调用）。
   *  Why 全会话扫描而非记录式队列：崩溃前哪些会话有待消费信号不可知（内存态丢失），
   *  扫描是唯一可靠真相源；每会话独立 catch——单个会话异常不阻塞其余。
   *  status 过滤不在此做：非 active 会话的信号点火后 invoke 层自会拒绝
   *  （复用 scheduler claimAndValidateTask 的同型守卫语义） */
  async routeAllPending(): Promise<void> {
    const conversationIds = await this.deps.conversationRepo.getAllIds({ limit: 200 });
    for (const conversationId of conversationIds) {
      await this.routePendingSignals(conversationId).catch(err => {
        this.deps.logger.warn("routeAllPending 单会话失败，继续其余", {
          conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * P1 档位矩阵（母方案 §1 三档频谱的 P1 落地面；steer/abort 物理通道归 P3）：
   *
   * | 档位    | 目标 idle                | 目标 busy                        |
   * |---------|--------------------------|----------------------------------|
   * | NORMAL  | 点火 invoke（未读注入）  | 入 busyQueue（完成时消化，内容保全） |
   * | URGENT  | 点火 invoke              | 入 busyQueue（同上；steer 归 P3） |
   * | HALT    | 点火 invoke（处理停机请求）| 大獭：入 busyQueue 优先消化；小獭：丢弃 + healing 留痕 |
   */
  private async routeTarget(conversationId: string, targetId: string, signal: Message): Promise<RouteAction> {
    const level = (signal.signalLevel ?? "NORMAL").toUpperCase();
    const otter = await this.deps.queryOtter.getById(targetId).catch(() => null);
    if (!otter) return "skipped_inactive"; // 目标已解散等：留箱静默，等人工处理

    if (level === "HALT" && otter.type === "small") {
      // P0 在 yield 写入层已拒绝小獭投 HALT；此处拦截绕过路径（历史遗留/直写库）
      await this.recordHealing({ conversationId, messageId: signal.id, otterId: targetId, level: signal.signalLevel ?? null, errorType: "permission_denied" as HealingErrorType, severity: "medium", description: `HALT 信号投往小獭 ${targetId}，路由器已丢弃（仅用户/大獭可投，F20260826mwrd C2）` });
      return "skipped_no_target";
    }

    const key = `${conversationId}:${targetId}`;
    const busy = this.inFlight.has(key) || await this.isOtterActive(conversationId, targetId);
    if (!busy) {
      return this.invokeTarget(conversationId, targetId, "", signal.senderId);
    }

    // busy：入队保内容（HALT 到 busy 大獭置队首——停机请求优先于普通排队信号消化）
    const queued: QueuedSignal = {
      signalId: signal.id,
      content: this.signalContent(signal),
      senderId: signal.senderId,
      level,
    };    const queue = this.busyQueue.get(key) ?? [];
    if (level === "HALT") {
      queue.unshift(queued);
    } else {
      queue.push(queued);
    }
    this.busyQueue.set(key, queue);
    return "queued_busy";
  }

  /** 信号内容快照：segments 聚合（入 busyQueue 时调用——游标推进后原文将不可再得） */
  private signalContent(signal: Message): string {
    try {
      return signal.segments.map(s => s.body).join("\n").trim();
    } catch {
      return "";
    }
  }

  /**
   * 点火一次 invoke（链引擎承载，消费 aggregatedTargets 续跑发言链——#332 语义）。
   * fire-and-forget：入口（HTTP 请求 / scheduler tick / resume）不被 invoke 时长阻塞。
   * @param content busyQueue 消化路径传入快照内容（显式「当前任务」）；未读路径传空
   *                （链内 buildMessageWithContext 注入完整未读）
   */
  private invokeTarget(conversationId: string, otterId: string, content: string, senderId: string): "invoked" {
    const key = `${conversationId}:${otterId}`;
    if (this.inFlight.has(key)) return "invoked"; // 去抖窗口内的重复触发，静默合并

    this.inFlight.add(key);
    void (async () => {
      try {
        await this.deps.dispatchChainEngine.executeChain({
          conversationId,
          userMessageContent: content,
          senderId,
          initialTargets: [otterId],
          invokeFn: (params) => this.deps.invokeFn(params),
        });
      } catch (err) {
        // 消费失败可见性（七刀之七）：healing 留痕（消息终态由链/orchestrator 侧管理）
        this.deps.logger.error("SignalRouter 消费失败", err instanceof Error ? err : new Error(String(err)), {
          conversationId, otterId, contentPreview: content.substring(0, 100),
        });
        await this.recordHealing({ conversationId, messageId: "", otterId, level: "NORMAL", errorType: "other", severity: "high", description: `信号消费失败：${err instanceof Error ? err.message : String(err)}` });
      } finally {
        this.inFlight.delete(key);
        this.scheduleDebounceRescan(conversationId);
      }
    })();
    return "invoked";
  }

  /** 完成时检查（母方案 §2）：去抖窗口内先消化 busyQueue 快照（内容显式注入），
   *  再扫未读视图（覆盖「检查后瞬间写入」竞态）。失败仅记日志——重扫自身幂等。 */
  private scheduleDebounceRescan(conversationId: string): void {
    setTimeout(() => {
      void this.drainBusyQueue(conversationId).then(() => this.routePendingSignals(conversationId)).catch(e => {
        this.deps.logger.error("SignalRouter debounce rescan failed", e instanceof Error ? e : new Error(String(e)), { conversationId });
      });
    }, DEBOUNCE_MS).unref?.();
  }

  /** 消化 busyQueue：每会话取队首一条点火（一信号一 invoke，保持对话粒度；
   *  后续条目由该 invoke 的完成重扫接力；中途 HALT 可插队——routeTarget 置队首）。
   *  目标仍 busy（外部路径在跑，如 P1 期 scheduler 直连链）则留队等下次触发。 */
  private async drainBusyQueue(conversationId: string): Promise<void> {
    for (const [key, queue] of this.busyQueue) {
      if (!key.startsWith(`${conversationId}:`)) continue;
      const item = queue.shift();
      if (!item) {
        this.busyQueue.delete(key);
        continue;
      }
      // key 结构 `${conversationId}:${otterId}`——UUID 不含冒号，split 安全
      const otterId = key.split(":")[1];
      if (this.inFlight.has(key) || await this.isOtterActive(conversationId, otterId)) {
        queue.unshift(item); // 放回队首，保序
        continue; // 该目标仍 busy（外部路径在跑）：跳过，不终止——同会话其他 idle 目标的队列不被饿死
      }
      this.invokeTarget(conversationId, otterId, item.content, item.senderId);
      return; // 单条点火即止，接力交给完成重扫
    }
  }

  /**
   * 獭活跃判定：该獭最新消息为 streaming 且在窗口内（按 sender 精确查询，
   * 会话级近似——P4 游标换 seq 粒度后此判定随之精确化）。
   * Why 近似可接受：误判 busy = 信号入队等下次触发（延迟一拍）；误判 idle =
   * 同獭第二个链并发，底层 per-otter 锁仍串行化写路径（I1 不变量未动）——
   * P1 阶段信号排队是软层、锁是既有硬层，双层防护。
   */
  private async isOtterActive(conversationId: string, otterId: string): Promise<boolean> {
    try {
      const last = await this.deps.queryMessage.getLastMessageBySender(conversationId, otterId);
      if (!last || last.status !== "streaming") return false;
      return Date.now() - Date.parse(last.createdAt) < ACTIVE_WINDOW_MS;
    } catch {
      return false; // 判定失败按 idle：宁可多点火（幂等兜底），不可让信号滞留
    }
  }

  private async recordHealing(input: {
    conversationId: string;
    messageId: string;
    otterId: string;
    level: string | null;
    errorType: HealingErrorType;
    severity: HealingSeverity;
    description: string;
  }): Promise<void> {
    if (!this.deps.healingRepo) return;
    const event: HealingEvent = {
      id: crypto.randomUUID(),
      messageId: input.messageId,
      conversationId: input.conversationId,
      otterId: input.otterId,
      errorType: input.errorType,
      severity: input.severity,
      description: input.description,
      suggestion: "检查信号投递路径（档位/目标）；消费失败请查 invoke 日志与消息终态",
      context: { signalLevel: input.level },
      status: "open" as HealingEventStatus,
      resolution: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    await this.deps.healingRepo.create(event).catch(err => {
      this.deps.logger.warn("SignalRouter healing 落账失败", { error: err instanceof Error ? err.message : String(err) });
    });
  }
}
