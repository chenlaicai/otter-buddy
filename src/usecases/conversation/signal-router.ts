/**
 * F20260901sgpv（母方案 F20260901sgpx P1）：信号路由器。
 *
 * 职责：把「消息表里的信号」点火为 invoke——入口（web sendMessage / IM / resume
 * 补扫）的调度收敛点。路由动作由 DispatchChainEngine 承载（链引擎 hop 驱动的替代
 * 是 P2 的灰度战场），P1 的核心增量：
 * ① pending 真相源 = 派发台账（F20260902sgp2 S2 起）：未消费信号 = 已投递 ∧
 *    无 (message,target) attempt 记录。v1 的「收件箱 = 游标视图」判据已退役
 *    （09-02 事故根因：未读 ≠ 待行动，F20260902rbsg）——已读游标回归上下文注入
 *    本职，不参与点火决策；「消费」= 链引擎派发记账（点火即销账）
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

export type RouteAction =
  | "invoked"
  | "queued_busy"
  | "skipped_no_target"
  | "skipped_inactive"
  /** F20260903ihlt：用户中断停机中——信号保留（pending 不动），等用户显式恢复 */
  | "retry_gated"
  | "retry_invoked"
  | "skipped_halted"
  /** F20260903ihlt：会话限流熔断中——rate_limit healing 事件窗口内拒点火，信号保留 */
  | "skipped_rate_limited";

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
/** F20260903damp 阻尼#1：同 (message,target) 最小点火间隔（秒）。
 *  「无自动重试」的机制化：即使台账意外出现同信号可路由窗口（记账缺失/竞态），
 *  60s 内第二次点火被硬性拒绝——热循环的最坏频率被压到 1 次/分钟而非 15 次/秒。
 *  失败信号的重试语义不变：仅用户手动 retry（source='retry' 不受此限，走覆盖记账）。 */
const MIN_INVOKE_INTERVAL_SEC = 60;
/** F20260903ihlt 限流熔断窗口：会话内出现 rate_limit healing 事件后，暂停该会话全部
 *  pending 点火（429 是模型级故障——继续排空收件箱 = 逐条撞墙的机枪风暴，09-03 12:45 实证）。
 *  瞬时限流（SDK 重试耗尽）10 分钟；配额耗尽（exhausted）1 小时——窗口过后恢复点火，
 *  若限流仍在，第一发撞墙会再落一条事件、再熔断（最坏频率 1 次/窗口，哑火侧失效模式）。
 *  手动 retry 不经路由器（直连链），不受此闸影响。 */
const RATE_LIMIT_BLOCK_TRANSIENT_MS = 10 * 60_000;
const RATE_LIMIT_BLOCK_EXHAUSTED_MS = 60 * 60_000;

export class SignalRouter {
  /** 同 otter 串行：key = `${conversationId}:${otterId}`。invoke 进行中不重复点火，
   *  完成后经去抖重扫补路由——信号在消息表/busyQueue 持久，不因跳过而丢失。 */
  private readonly inFlight = new Set<string>();

  /**
   * F20260903ihlt：用户中断停机（会话级）。web「中断」按钮此前只 abort 单条消息的
   * SDK session——被中断 invoke 的 50ms 去抖重扫会立刻点火下一只 pending 獭
   * （09-03 现场：中断小獭 a 弹出小獭 b）。用户中断是最高优先级停机语义：
   * 置位后本会话 pending/busyQueue 全部冻结（信号保留不丢），直到用户显式恢复
   * （发新消息 / IM 发言 / 手动 retry 均视为恢复动作，由入口侧调 clearUserHalt）。
   * 内存态与 busyQueue 同生命周期（崩溃即丢，可接受——重启后无 halt 是安全侧：
   * 最坏回到无闸门现状）。HALT 信号档位（P3 物理停）与本机制正交：那是消息级
   * 停机请求，这是调度级用户停机。
   */
  private readonly userHalted = new Set<string>();

  /**
   * busyQueue：busy 目标的待消化信号（内存态，崩溃即丢——与现状崩溃等价，可接受）。
   * Why 必须保内容：busy 獭的链结束时 markBatchRead 会把游标推进到自己的 turn，
   * 同 turn 内中途到达的消息（插话主场景！）会被「消费但未注入」——只靠台账重扫
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

    // F20260903ihlt：调度闸门（用户停机 > 限流熔断 > 档位路由）——中断是最高优先级。
    // 扫描级求值一次：命中即整轮零点火，信号保留（pending 不动）等恢复窗口。
    const gate = await this.checkDispatchGates(conversationId);

    for (const [targetId, rows] of byTarget) {
      // 每目标取最新一条信号驱动路由决策（档位以最新为准；同批多条由同一次 invoke 的未读注入统一消化）
      const newest = rows[rows.length - 1];
      const signal = await this.loadSignalMessage(newest.messageId);
      if (!signal) {
        this.deps.logger.warn("[signal-router] pending 信号消息缺失，跳过", { conversationId, messageId: newest.messageId, targetId });
        continue;
      }
      if (gate) {
        results.push({ signal, action: gate });
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

  /** F20260903ihlt：用户中断停机置位（中断端点调用）。幂等。 */
  /**
   * F20260903ihlt 遗留漏洞修复（S3）：手动 retry 的调度入口——与自动点火同一套闸门与记账。
   *
   * Why 必须存在：retry 曾走直连链（executeChain 直调），绕过路由器的全部调度闸门——
   * 限流熔断期间手动 retry 照跑撞 429 → orchestrator 落新 rate_limit 事件 →
   * 熔断窗口被重置 → 自动点火继续冻结（09-03 搭档实锤的调度漏洞）。
   *
   * 语义：
   * - 过闸门（用户停机/限流熔断）：被挡时返回 retry_gated，调用方应向用户反馈
   *   「重试被调度闸门暂缓」而非静默失败——retry 是用户显式动作，不诚实反馈 = 体验黑洞
   * - 记账：source='retry' 覆盖同 (message,target) 槽位（§8.2 折中，前情压缩进 note）
   * - 点火：与 routeTarget 同路径（invokeTarget，含 busyQueue 排队语义）
   *
   * 与 clearUserHalt 的关系：调用方（message-controller）在 retry 前已解除用户停机
   * （显式恢复动作）；本方法内的限流熔断闸门**不受 clearUserHalt 影响**——
   * 「用户想重试」不能解除「模型配额还没恢复」的客观事实。
   */
  async retrySignal(conversationId: string, messageId: string, targetOtterId: string, signal: Message): Promise<"retry_invoked" | "retry_gated"> {
    // 闸门 1：用户停机——retry 是显式恢复动作，理论不会同时 halted；防御性兜底
    // （调用方已 clearUserHalt，此处 double-check 防竞态：halt 置位与 retry 并发）
    if (this.userHalted.has(conversationId)) return "retry_gated";
    // 闸门 2：限流熔断——用户显式 retry 不能重置熔断窗口（否则「点一下重试」=
    // 「把全会话恢复推后一小时」，09-03 实锤漏洞面）。被挡即如实反馈。
    if (await this.isRateLimited(conversationId)) return "retry_gated";

    const action = await this.routeTarget(conversationId, targetOtterId, signal, "retry");
    // invoked = 直接点火；queued_busy = 目标忙入队（受理成功，等消化）——两者都是 retry 成功受理
    return action === "invoked" || action === "queued_busy" ? "retry_invoked" : "retry_gated";
  }

  markUserHalt(conversationId: string): void {
    if (this.userHalted.has(conversationId)) return;
    this.userHalted.add(conversationId);
    this.deps.logger.warn("[signal-router] 用户中断停机：冻结本会话全部 pending 点火，直到用户发新消息/手动重试恢复", { conversationId });
  }

  /** F20260903ihlt：用户停机解除（用户发新消息 / IM 发言 / 手动 retry 时由入口侧调用）。 */
  clearUserHalt(conversationId: string): void {
    if (this.userHalted.delete(conversationId)) {
      this.deps.logger.info("[signal-router] 用户停机解除：恢复本会话信号点火", { conversationId });
    }
  }

  /**
   * F20260903ihlt：会话限流熔断判定。数据源 = healing 台账 rate_limit 事件
   * （orchestrator #543 在 429 终态时落账，含 exhausted 分级）——路由器自身看不到
   * invoke 内部的 429，台账是既有的事实汇聚点，不新增真相源。
   * 会话级（非模型级）：otter 实体无 model 字段，模型映射不在路由器可及范围；
   * 宁可整会话停（哑火侧）也不要逐獭撞墙（危险侧）。判定失败按不熔断（降级=现状）。
   */
  private async isRateLimited(conversationId: string): Promise<boolean> {
    if (!this.deps.healingRepo) return false;
    try {
      const events = await this.deps.healingRepo.findByConversation(conversationId);
      const now = Date.now();
      return events.some(e => {
        if (e.errorType !== "rate_limit") return false;
        const exhausted = (e.context as { exhausted?: boolean } | null)?.exhausted === true;
        const windowMs = exhausted ? RATE_LIMIT_BLOCK_EXHAUSTED_MS : RATE_LIMIT_BLOCK_TRANSIENT_MS;
        const createdAt = Date.parse(e.createdAt);
        return Number.isFinite(createdAt) && now - createdAt < windowMs;
      });
    } catch {
      return false;
    }
  }

  /** F20260903ihlt：调度闸门——用户停机 / 限流熔断。命中返回跳过动作，放行返回 null。 */
  private async checkDispatchGates(conversationId: string): Promise<RouteAction | null> {
    if (this.userHalted.has(conversationId)) return "skipped_halted";
    if (await this.isRateLimited(conversationId)) return "skipped_rate_limited";
    return null;
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
  private async routeTarget(conversationId: string, targetId: string, signal: Message, source: "chain" | "retry" = "chain"): Promise<RouteAction> {
    const level = (signal.signalLevel ?? "NORMAL").toUpperCase();
    const otter = await this.deps.queryOtter.getById(targetId).catch(() => null);
    // F20260903damp：dissolved 目标不点火——getById 不过滤 status（sqlite-otter-repository
    // 全量 SELECT），过滤责任在此落地。09-03 事故：dissolved 检视獭被启动补扫点火 →
    // No session or config found × 50ms 重扫热循环（614 次/42s）。判据 SQL 已同步过滤，
    // 此处是 SQL 求值与 otters 状态变更之间的竞态兜底（双层独立成立）。
    if (!otter || otter.status !== "active") return "skipped_inactive"; // 目标已解散等：留箱静默，等人工处理

    if (await this.haltToSmallOtterGuard(conversationId, level, signal, targetId)) {
      return "skipped_no_target";
    }

    const key = `${conversationId}:${targetId}`;
    // F20260903damp 阻尼#1：同 (message,target) 最小点火间隔——重复信号/记账缺失/
    // 重扫竞态下的第二次点火在此硬性拒绝（失效模式落哑火侧，宁漏不燃）
    if (this.deps.dispatchAttemptRepo.shouldThrottle(signal.id, targetId, MIN_INVOKE_INTERVAL_SEC)) {
      this.deps.logger.warn("[signal-router] 阻尼：同信号最小点火间隔内拒绝重复点火", { conversationId, messageId: signal.id, targetId, intervalSec: MIN_INVOKE_INTERVAL_SEC });
      return "queued_busy"; // 归队语义：等下个触发窗口，不丢失
    }
    const busy = this.inFlight.has(key) || await this.isOtterActive(conversationId, targetId);
    if (!busy) {
      return this.invokeTarget(conversationId, targetId, "", signal.senderId, { triggerMessageId: signal.id, source });
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

  /** F20260903damp：HALT 投往小獭拦截（C2 权限绕过路径防线）。
   *  @returns true = 已拦截（调用方返回 skipped_no_target） */
  private async haltToSmallOtterGuard(conversationId: string, level: string, signal: Message, targetId: string): Promise<boolean> {
    if (level !== "HALT") return false;
    const otter = await this.deps.queryOtter.getById(targetId).catch(() => null);
    if (!otter || otter.type !== "small") return false;
    // P0 在 yield 写入层已拒绝小獭投 HALT；此处拦截绕过路径（历史遗留/直写库）
    await this.recordHealing({ conversationId, messageId: signal.id, otterId: targetId, level: signal.signalLevel ?? null, errorType: "permission_denied" as HealingErrorType, severity: "medium", description: `HALT 信号投往小獭 ${targetId}，路由器已丢弃（仅用户/大獭可投，F20260826mwrd C2）` });
    return true;
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
   * @param triggerMessageId 触发信号的消息 ID——F20260903damp：点火即记账的账面键。
   *        路由器在调链【前】先写 attempt 行（in_progress），不依赖链引擎可选参数到达：
   *        triggerMessageId 漏传 / 链前段抛错都会让账面空转 → pending 永生 →
   *        50ms 重扫热循环（09-03 事故 614 次/42s 的直接根因）。
   *        链引擎 recordStart 对同 (message,target) INSERT OR REPLACE 覆盖（幂等），
   *        settle 终态由链按 triggerMessageId 落；链整体抛错时由本方法 catch 兜底 failed。
   */
  private invokeTarget(conversationId: string, otterId: string, content: string, senderId: string, ledger?: { triggerMessageId: string; source: "chain" | "router" | "retry" }): "invoked" {
    const key = `${conversationId}:${otterId}`;
    if (this.inFlight.has(key)) return "invoked"; // 去抖窗口内的重复触发，静默合并

    this.inFlight.add(key);
    void (async () => {
      // 点火即记账（in_progress 即非 pending）：写入义务收敛在点火原点，
      // 不随链引擎参数传递的完整性而变。失败仅日志（台账不阻断链路，硬约束 1）。
      const triggerMessageId = ledger?.triggerMessageId;
      if (triggerMessageId) {
        try {
          this.deps.dispatchAttemptRepo.recordStart({
            id: crypto.randomUUID(),
            conversationId,
            messageId: triggerMessageId,
            targetOtterId: otterId,
            status: "in_progress",
            source: ledger.source,
            attemptStartedAt: new Date().toISOString(),
            note: null,
          });
          this.deps.logger.info('[signal-ledger] action=record', { conv: conversationId, msg: triggerMessageId, otter: otterId, status: 'in_progress', source: ledger.source });
        } catch (e) {
          this.deps.logger.warn('[signal-ledger] 路由器点火记账失败（不影响链路）', { conversationId, messageId: triggerMessageId, otterId, error: e instanceof Error ? e.message : String(e) });
        }
      }
      try {
        await this.deps.dispatchChainEngine.executeChain({
          conversationId,
          userMessageContent: content,
          senderId,
          initialTargets: [otterId],
          invokeFn: (params) => this.deps.invokeFn(params),
          triggerMessageId,
        });
      } catch (err) {
        // 消费失败可见性（七刀之七）：healing 留痕（消息终态由链/orchestrator 侧管理）
        this.deps.logger.error("SignalRouter 消费失败", err instanceof Error ? err : new Error(String(err)), {
          conversationId, otterId, contentPreview: content.substring(0, 100),
        });
        await this.recordHealing({ conversationId, messageId: "", otterId, level: "NORMAL", errorType: "other", severity: "high", description: `信号消费失败：${err instanceof Error ? err.message : String(err)}` });
        // 终态兜底：链在自身 settle 之前抛错（buildRoster 前置失败等）时由路由器销账，
        // 防该 (message,target) 以无账状态回到重扫视野（热循环回归防线）
        if (triggerMessageId) {
          try {
            const reason = err instanceof Error ? err.message : String(err);
            this.deps.dispatchAttemptRepo.recordFinish(triggerMessageId, otterId, "failed", `router catch: ${reason}`.slice(0, 300));
          } catch { /* 记账失败不阻断（硬约束 1） */ }
        }
      } finally {
        this.inFlight.delete(key);
        this.scheduleDebounceRescan(conversationId);
      }
    })();
    return "invoked";
  }

  /** 完成时检查（母方案 §2）：去抖窗口内先消化 busyQueue 快照（内容显式注入），
   *  再扫台账 pending（覆盖「检查后瞬间写入」竞态）。失败仅记日志——重扫自身幂等。 */
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
    // F20260903ihlt：停机/熔断期间不消化排队信号（内容已快照在队，不丢；恢复后接力）
    if (this.userHalted.has(conversationId)) return;
    if (await this.isRateLimited(conversationId)) return;
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
      this.invokeTarget(conversationId, otterId, item.content, item.senderId, { triggerMessageId: item.signalId, source: "router" });
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
