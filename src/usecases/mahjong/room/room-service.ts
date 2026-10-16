/**
 * 牌局房间服务（方案模块三编排层）——引擎推进 + 节流阀 + 獭唤醒 + 真人等待/超时
 * + 落帧 + 房间粒度广播（SSE 上联在 http 层）。
 *
 * 推进语义：
 *   - 单房间单赛（roomId → 最近一场 game；重开房 = 新 gameId）
 *   - advance 循环串行化在 room.chain（防重入）；停驻仅两种：真人等待（parked）与对局终了
 *   - 节流阀（方案 S3 口径）：trivial 回合（无特殊动作且代理=摸切）直接代理执行，不唤醒 LLM
 *   - 真人：parked → HTTP 注入 injectHumanAction；超时 humanTimeoutMs 后广播 deadline，
 *     再 grace 宽限后仍未注入 → 规则代理自动摸切（战报可记 via=timeout-fallback）
 *   - 獭：wakeOtterForDecision（SDK 直调；重试 1 次；失败规则代理兜底）
 *   - 每步落地即落帧（appendFrame）并广播 {events, decision, frameSeq}
 *   - 断线重连：recover(roomId) = 最新帧 restoreEngine + 续推
 *
 * F20261015mjsg 收尾三钩（大獭裁决归引擎层）：
 *   - isSeated(otterId)：D2 精确谓词——入座且对局进行中，对话侧据此自动应答「打牌中」
 *   - addChat + 下局开局注入：真人回话入队（按 otter 座位分队），下局开局后经 gateway
 *     直调注入各 otter session（方案口径：不走运行中 reset/不走 systemPrompt）
 *   - onGameover 回调：局终一次性上报 GameoverReport（终局名次/役种亮点/獭发言/代理代打数），
 *     bootstrap 接 SendEntry 发战报卡（recover 已终局的牌局不补发——防跨重启重复播报）
 */

import { SanmaEngine, restoreEngine, notation } from "../engine/engine";
import { proxyChooseAction, isTrivialDecision } from "../engine/proxy";
import { buildChatInjectionPrompt } from "./otter-adapter";
import { publishOtterChat } from "./room-chat";
import type {
  DecisionPoint,
  EngineAction,
  EngineEvent,
  GameConfig,
  Seat,
} from "../engine/types";
import { wakeOtterForDecision, type WakeResult } from "./otter-adapter";
export type { ChatMessage, GameoverReport, RoomEvent, RoomEventListener, RoomServiceDeps, RoomView } from "./room-types";
export { RoomBus } from "./room-types";
import type { ChatMessage, GameoverReport, RoomEvent, RoomEventListener, RoomServiceDeps, RoomView } from "./room-types";

/** 房间粒度事件总线（RoomBus）与装配依赖（RoomServiceDeps）已拆至 room-types.ts（控 max-lines） */

interface AwaitingHuman {
  seat: Seat;
  deadlineTimer: ReturnType<typeof setTimeout>;
  forceTimer: ReturnType<typeof setTimeout>;
}

interface RoomInternal {
  roomId: string;
  gameId: string;
  engine: SanmaEngine;
  chain: Promise<void>;
  awaiting: AwaitingHuman | null;
  startedAt: number;
  /** 局终已上报（防重复：loop 顶只 fire 一次；recover 已终局也置位） */
  reportedOver: boolean;
  /** 终局宽限驱逐定时器（scheduleEvict；close/同房重开后由代际校验失效） */
  evictTimer?: ReturnType<typeof setTimeout>;
  /** 待注入聊天（按 otterId 分队；下局开局消费，成功即清、失败保留次局重试） */
  chatQueues: Map<string, ChatMessage[]>;
  /** 战报累积器（publishGame/step 单点采集；内部可变、上报时作 readonly 视图） */
  report: {
    ranking: GameoverReport["ranking"] | null;
    highlights: Array<GameoverReport["highlights"][number]>;
    speeches: Array<GameoverReport["speeches"][number]>;
    proxyFallbacks: number;
  };
}

export class RoomService {
  private readonly rooms = new Map<string, RoomInternal>();
  private readonly humanTimeoutMs: number;
  private readonly humanGraceMs: number;

  constructor(private readonly deps: RoomServiceDeps) {
    this.humanTimeoutMs = deps.humanTimeoutMs ?? 15_000;
    this.humanGraceMs = deps.humanGraceMs ?? 15_000;
    this.evictFinishedMs = deps.evictFinishedMs ?? 10 * 60_000;
  }

  /** 终局房宽限出 Map（检视发现3）：宽限内 view/recover 可用（页面终局展示），到期驱逐防 rooms Map 无界 */
  private readonly evictFinishedMs: number;

  // ── 生命周期 ──

  /** 建房开局：配牌 + 首帧 + 广播，推进异步起跑 */
  createRoom(roomId: string, config: GameConfig): { gameId: string } {
    const existing = this.rooms.get(roomId);
    if (existing) {
      // 检视发现3：终局旧房占位曾致同 roomId 永久 409——单房间单赛（头部口径），
      // 终局即换局：旧房出 Map（旧宽限定时器由代际校验自失效），重开 = 新 gameId
      if (existing.engine.state.status === "playing") throw new Error(`room already exists: ${roomId}`);
      this.close(roomId);
    }
    const gameId = `${roomId}-${Date.now().toString(36)}`;
    const engine = new SanmaEngine(config);
    const events = engine.startRound();
    this.deps.store.createGame(gameId, roomId, config);
    this.deps.store.appendFrame(gameId, engine.state, null);
    const room = this.newRoom(roomId, gameId, engine);
    this.rooms.set(roomId, room);
    this.publishGame(room, events, engine.decisionPoint(), 0);
    this.kick(roomId);
    return { gameId };
  }

  /**
   * 断线重连/进程重启恢复：按房间找最近一场，最新帧还原并续推。
   * 返回 null = 无可恢复牌局。
   */
  recover(roomId: string): { gameId: string } | null {
    if (this.rooms.has(roomId)) return { gameId: this.rooms.get(roomId)!.gameId };
    const game = this.deps.store.findGameByRoom(roomId);
    if (!game) return null;
    const frame = this.deps.store.latestFrame(game.id);
    if (!frame) return null;
    const engine = restoreEngine(frame.state);
    const room = this.newRoom(roomId, game.id, engine);
    this.rooms.set(roomId, room);
    if (engine.state.status !== "playing") {
      // 恢复到已终局：不进推进链且 reportedOver 置位（战报不重复 fire）；status 幂等补写——
      // 覆盖「终局后进程即崩、updateGameStatus 未及落库」的窗口（检视发现3）
      room.reportedOver = true;
      try {
        this.deps.store.updateGameStatus(game.id, "finished");
      } catch (e) {
        this.deps.logger?.warn("mahjong recover updateGameStatus failed", {
          gameId: game.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      this.scheduleEvict(room);
      return { gameId: game.id };
    }
    this.kick(roomId);
    return { gameId: game.id };
  }

  /** 释放房间（清定时器；测试/停局用） */
  close(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (room.awaiting) {
      clearTimeout(room.awaiting.deadlineTimer);
      clearTimeout(room.awaiting.forceTimer);
      room.awaiting = null;
    }
    this.rooms.delete(roomId);
  }

  /** 等待当前推进链静止（parked/终了/空闲）——测试与轮询用 */
  settled(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    return room ? room.chain : Promise.resolve();
  }

  getGameId(roomId: string): string | null {
    return this.rooms.get(roomId)?.gameId ?? null;
  }

  subscribe(roomId: string, listener: RoomEventListener): () => void {
    return this.deps.bus.subscribe(roomId, listener);
  }

  /**
   * D2 精确谓词：该 otter 当前入座于**进行中**的牌局（终局房间不算——对局已了不再防护）。
   * 对话派发点据此自动应答「打牌中」，不进 LLM 推理（不触发水位换世）。
   */
  isSeated(otterId: string): boolean {
    for (const room of this.rooms.values()) {
      if (room.engine.state.status !== "playing") continue;
      if (room.engine.state.config.players.some((p) => p.kind === "otter" && p.otterId === otterId)) {
        return true;
      }
    }
    return false;
  }

  // ── 真人回话 ──

  /** 真人回话入队（按 otter 座位分队；广播 chat 事件供实时回显） */
  addChat(roomId: string, seat: Seat, text: string): { ok: true } | { ok: false; reason: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, reason: "room not found" };
    if (room.engine.state.status !== "playing") return { ok: false, reason: "game already finished" };
    const player = room.engine.state.config.players[seat];
    if (!player) return { ok: false, reason: `invalid seat ${seat}` };
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, reason: "text empty" };
    if (trimmed.length > 500) return { ok: false, reason: "text too long (max 500)" };
    const msg: ChatMessage = { seat, name: player.name, text: trimmed, at: new Date().toISOString() };
    for (const p of room.engine.state.config.players) {
      if (p.kind === "otter" && p.otterId) {
        const q = room.chatQueues.get(p.otterId) ?? [];
        q.push(msg);
        room.chatQueues.set(p.otterId, q);
      }
    }
    this.deps.bus.publish(roomId, { type: "chat", roomId, seat, name: player.name, from: "human", text: trimmed, at: msg.at });
    return { ok: true };
  }

  // ── 真人注入 ──

  injectHumanAction(
    roomId: string,
    seat: Seat,
    action: EngineAction,
  ): { ok: true } | { ok: false; reason: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, reason: "room not found" };
    if (!room.awaiting) return { ok: false, reason: "not awaiting human action" };
    if (room.awaiting.seat !== seat) return { ok: false, reason: `awaiting seat ${room.awaiting.seat}` };
    clearTimeout(room.awaiting.deadlineTimer);
    clearTimeout(room.awaiting.forceTimer);
    room.awaiting = null;
    try {
      this.step(room, seat, action, "human");
    } catch (e) {
      // 检视发现2：异常路径曾冻结（awaiting 已清、无人续推，非法动作永久死房）——
      // 重挂推进链让 loop 重新 park。安全前提：engine.apply 合法性检查先于一切状态变更
      //（IllegalActionError 在 submit/do* 之前抛），引擎状态未动，同一决策位重新开窗；
      // 若抛错来自落帧等已变更之后的环节，kick 同样能续推（loop 按当前状态重新 park/推进）。
      this.kick(roomId);
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    this.kick(roomId);
    return { ok: true };
  }

  // ── 视图 ──

  view(roomId: string, viewer: Seat | null): RoomView | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const { engine } = room;
    const r = engine.state.round;
    if (!r) return null;
    const dp = engine.decisionPoint();
    return {
      roomId,
      gameId: room.gameId,
      status: engine.state.status,
      roundNo: engine.state.roundNo,
      honba: engine.state.honba,
      sticks: engine.state.sticks,
      dealer: engine.dealerSeat(),
      phase: r.phase,
      seatWinds: [0, 1, 2].map((s) => engine.seatWind(s as Seat)),
      wallRemaining: r.wall.tiles.length - r.wall.drawIdx,
      doraIndicators: r.wall.deadWall.slice(4, 4 + r.wall.doraRevealed).map(notation),
      players: r.players.map((p) => ({
        seat: p.seat,
        name: p.name,
        kind: p.kind,
        points: p.points,
        hand: viewer === null || viewer === p.seat ? p.hand.map(notation) : null,
        melds: p.melds.map((m) => ({
          type: m.type,
          tiles: m.tiles.map(notation),
          ...(m.from ? { from: m.from } : {}),
        })),
        kita: p.kitaTiles.map(notation),
        discards: p.discards.map(notation),
        riichi: p.riichi,
        riichiTurn: p.riichiTurn,
        ippatsu: p.ippatsu,
      })),
      decision: dp,
      awaitingHuman: room.awaiting
        ? { seat: room.awaiting.seat, deadline: new Date(Date.now() + this.humanTimeoutMs).toISOString() }
        : null,
      settlement: r.settlement ?? null,
    };
  }

  // ── 推进内核 ──

  /** 房间内部对象工厂（createRoom/recover 共用——新字段单点初始化） */
  private newRoom(roomId: string, gameId: string, engine: SanmaEngine): RoomInternal {
    return {
      roomId,
      gameId,
      engine,
      chain: Promise.resolve(),
      awaiting: null,
      startedAt: Date.now(),
      reportedOver: false,
      chatQueues: new Map(),
      report: { ranking: null, highlights: [], speeches: [], proxyFallbacks: 0 },
    };
  }

  private kick(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.chain = room.chain.then(() => this.loop(room)).catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.bus.publish(room.roomId, { type: "error", roomId: room.roomId, message });
    });
  }

  private async loop(room: RoomInternal): Promise<void> {
    // 防重入/park 占位：有人在等或已有链在跑则交由现有链
    let guard = 0;
    while (room.awaiting === null) {
      guard += 1;
      if (guard > 10_000) throw new Error("advance loop exceeded step guard");
      const engine = room.engine;
      if (engine.state.status !== "playing") {
        await this.fireGameover(room);
        return;
      }
      const dp = engine.decisionPoint();
      if (!dp) {
        await this.advanceRound(room);
        continue;
      }
      // ① 真人 → park（等 HTTP 注入；超时链广播 deadline → 宽限后代理）
      const player = engine.state.round!.players[dp.seat];
      if (player.kind === "human") {
        this.parkHuman(room, dp);
        return;
      }
      // ①.5 proxy 座位（非真人非獭）：规则代理直接执行（不走唤醒）
      if (player.kind !== "otter") {
        this.step(room, dp.seat, proxyChooseAction(engine, dp), isTrivialDecision(engine, dp) ? "trivial" : "proxy");
        continue;
      }
      // ② 节流阀：trivial 直接代理
      if (isTrivialDecision(engine, dp)) {
        this.step(room, dp.seat, proxyChooseAction(engine, dp), "trivial");
        continue;
      }
      // ③ 獭唤醒（SDK 直调；失败兜底）
      const wake: WakeResult = await wakeOtterForDecision({ gateway: this.deps.gateway, engine }, dp);
      this.step(room, dp.seat, wake.action, wake.via === "otter" ? "otter" : "fallback", wake);
    }
  }

  /** 单步：apply + 落帧 + 广播（动作非法在此抛出，由调用方处置） */
  private step(
    room: RoomInternal,
    seat: Seat,
    action: EngineAction,
    via: NonNullable<Extract<RoomEvent, { type: "game" }>["wake"]>["via"],
    wake?: WakeResult,
  ): void {
    const events = room.engine.apply(seat, action).events;
    this.collectStepReport(room, seat, via, wake);
    const seq = this.storeFrame(room, action);
    const dp = room.engine.decisionPoint();
    const wakeField =
      wake && wake.via === "otter"
        ? {
            via: "otter" as const,
            ...(wake.speech !== undefined ? { speech: wake.speech } : {}),
            ...(wake.attempts !== undefined ? { attempts: wake.attempts } : {}),
          }
        : wake && wake.via === "fallback"
          ? {
              via: "fallback" as const,
              ...(wake.fallbackReason !== undefined ? { fallbackReason: wake.fallbackReason } : {}),
              ...(wake.attempts !== undefined ? { attempts: wake.attempts } : {}),
            }
          : ({ via } as { via: NonNullable<Extract<RoomEvent, { type: "game" }>["wake"]>["via"] });
    this.publishGame(room, events, dp, seq, wakeField);
  }

  private parkHuman(room: RoomInternal, dp: DecisionPoint): void {
    const deadlineMs = this.humanTimeoutMs;
    const deadline = new Date(Date.now() + deadlineMs).toISOString();
    const deadlineTimer = setTimeout(() => {
      this.deps.bus.publish(room.roomId, {
        type: "human-wait",
        roomId: room.roomId,
        seat: dp.seat,
        deadline,
      });
    }, deadlineMs);
    const forceTimer = setTimeout(() => {
      if (!room.awaiting) return;
      room.awaiting = null;
      try {
        this.step(room, dp.seat, proxyChooseAction(room.engine, dp), "timeout-fallback");
      } catch (e) {
        this.deps.bus.publish(room.roomId, {
          type: "error",
          roomId: room.roomId,
          message: e instanceof Error ? e.message : String(e),
        });
        return;
      }
      this.kick(room.roomId);
    }, deadlineMs + this.humanGraceMs);
    room.awaiting = { seat: dp.seat, deadlineTimer, forceTimer };
    this.deps.bus.publish(room.roomId, { type: "human-wait", roomId: room.roomId, seat: dp.seat, deadline });
  }

  private storeFrame(room: RoomInternal, action: EngineAction | null): number {
    const frame = this.deps.store.appendFrame(room.gameId, room.engine.state, action);
    return frame.seq;
  }

  private publishGame(
    room: RoomInternal,
    events: readonly EngineEvent[],
    decision: DecisionPoint | null,
    frameSeq: number,
    wake?: Extract<RoomEvent, { type: "game" }>["wake"],
  ): void {
    // 战报累积：每局结算（役种亮点）+ 终局名次——engine.round.settlement 只留末局，跨局在此聚合
    const roundNo = room.engine.state.roundNo;
    for (const ev of events) {
      if (ev.type === "win" || ev.type === "drawEnd" || ev.type === "abortive") {
        room.report.highlights.push({ roundNo, settlement: ev.settlement });
      } else if (ev.type === "gameOver") {
        room.report.ranking = ev.ranking;
      }
    }
    this.deps.bus.publish(room.roomId, {
      type: "game",
      roomId: room.roomId,
      gameId: room.gameId,
      events,
      decision,
      frameSeq,
      ...(wake ? { wake } : {}),
    });
  }

  /** 结算停驻→推进下局：落帧+广播+聊天注入（自 loop 拆出——控 loop 语句数） */
  private async advanceRound(room: RoomInternal): Promise<void> {
    const events = room.engine.nextRound();
    const seq = this.storeFrame(room, null);
    this.publishGame(room, events, room.engine.decisionPoint(), seq);
    // 下局开局注入：真人回话作为首段 user 消息进各 otter session（方案口径）
    await this.injectPendingChat(room);
  }

  /** 战报累积（自 step 拆出——控 step 复杂度）：獭发言 + 代理代打（trivial/human/proxy 按设计不算代打） */
  private collectStepReport(
    room: RoomInternal,
    seat: Seat,
    via: "trivial" | "proxy" | "otter" | "fallback" | "human" | "timeout-fallback",
    wake?: WakeResult,
  ): void {
    if (wake && wake.via === "otter" && wake.speech !== undefined) {
      const p = room.engine.state.round?.players[seat];
      room.report.speeches.push({ seat, name: p?.name ?? String(seat), text: wake.speech });
    }
    if (via === "fallback" || via === "timeout-fallback") room.report.proxyFallbacks += 1;
  }

  /** 下局开局聊天注入：各 otter 并行直调（per-otter 锁由端口自带）；成功清队、失败留次局重试 */
  private async injectPendingChat(room: RoomInternal): Promise<void> {
    if (room.chatQueues.size === 0) return;
    // 终局轮过渡（东4 结束→gameOver）不注入——牌局已了，队随房间释放
    if (room.engine.state.status !== "playing") return;
    const roundNo = room.engine.state.roundNo;
    await Promise.all(
      [...room.chatQueues.entries()].map(async ([otterId, msgs]) => {
        if (msgs.length === 0) return;
        try {
          const reply = await this.deps.gateway.invoke(otterId, buildChatInjectionPrompt(msgs, roundNo));
          room.chatQueues.set(otterId, []);
          // #1532：獭回应广播进 chat 流（页面回显/观战同流）；空白不发泡（room-chat.ts）
          publishOtterChat(this.deps.bus, room.roomId, room.engine.state.config.players, otterId, reply);
        } catch (e) {
          this.deps.logger?.warn("mahjong chat injection failed, kept for next round", {
            roomId: room.roomId,
            otterId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }),
    );
  }

  /** 终局房宽限驱逐（检视发现3）：到期出 Map；代际校验（gameId）防误删同 roomId 重开的新局 */
  private scheduleEvict(room: RoomInternal): void {
    if (room.evictTimer) clearTimeout(room.evictTimer);
    const ms = this.evictFinishedMs;
    if (ms <= 0) {
      this.close(room.roomId);
      return;
    }
    const timer = setTimeout(() => {
      const cur = this.rooms.get(room.roomId);
      if (cur && cur.gameId === room.gameId) this.close(room.roomId);
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    room.evictTimer = timer;
  }

  /** 局终一次性上报（loop 顶触发；回调异常仅告警——牌局状态不回滚） */
  private async fireGameover(room: RoomInternal): Promise<void> {
    if (room.reportedOver) return;
    room.reportedOver = true;
    // 检视发现3/6：状态落库（updateGameStatus 死代码复活——findGameByRoom 优先 playing 的语义钥匙，
    // 同 roomId 重开后恢复优先选活局）+ 宽限驱逐（防 rooms Map 无界）；与战报回调解耦（无 onGameover 也治理）
    try {
      this.deps.store.updateGameStatus(room.gameId, "finished");
    } catch (e) {
      this.deps.logger?.warn("mahjong updateGameStatus failed", {
        gameId: room.gameId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    this.scheduleEvict(room);
    const cb = this.deps.onGameover;
    if (!cb) return;
    const cfg = room.engine.state.config;
    // 名次：gameOver 事件优先（nextRound 产生，已在 publishGame 采集）；缺失回退末局点数
    const finalPlayers = room.engine.state.round?.players;
    const ranking = room.report.ranking
      ?? (finalPlayers
        ? [...finalPlayers]
            .map((p) => ({ seat: p.seat, name: p.name, points: p.points }))
            .sort((a, b) => b.points - a.points)
        : []);
    const report: GameoverReport = {
      roomId: room.roomId,
      gameId: room.gameId,
      seed: cfg.seed,
      players: cfg.players.map((p, i) => ({
        seat: i as Seat,
        name: p.name,
        kind: p.kind,
        ...(p.otterId ? { otterId: p.otterId } : {}),
      })),
      ranking,
      highlights: room.report.highlights,
      speeches: room.report.speeches,
      proxyFallbacks: room.report.proxyFallbacks,
      startedAt: room.startedAt,
      endedAt: Date.now(),
    };
    try {
      await cb(report);
    } catch (e) {
      this.deps.logger?.warn("mahjong onGameover callback failed", {
        roomId: room.roomId,
        gameId: room.gameId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
