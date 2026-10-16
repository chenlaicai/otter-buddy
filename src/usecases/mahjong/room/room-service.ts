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
 */

import { SanmaEngine, restoreEngine, notation } from "../engine/engine";
import { proxyChooseAction, isTrivialDecision } from "../engine/proxy";
import type {
  DecisionPoint,
  EngineAction,
  EngineEvent,
  GameConfig,
  Seat,
} from "../engine/types";
import type { SqliteFrameStore } from "./frames";
import { wakeOtterForDecision, type OtterGateway, type WakeResult } from "./otter-adapter";

export type RoomEvent =
  | {
      type: "game";
      roomId: string;
      gameId: string;
      events: readonly EngineEvent[];
      decision: DecisionPoint | null;
      frameSeq: number;
      wake?: { via: "trivial" | "proxy" | "otter" | "fallback" | "human" | "timeout-fallback"; speech?: string; fallbackReason?: string; attempts?: number };
    }
  | { type: "human-wait"; roomId: string; seat: Seat; deadline: string }
  | { type: "error"; roomId: string; message: string };

export type RoomEventListener = (event: RoomEvent) => void;

/** 房间粒度事件总线（SSE/WS 订阅点） */
export class RoomBus {
  private readonly subs = new Map<string, Set<RoomEventListener>>();

  subscribe(roomId: string, listener: RoomEventListener): () => void {
    let set = this.subs.get(roomId);
    if (!set) {
      set = new Set();
      this.subs.set(roomId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.subs.delete(roomId);
    };
  }

  publish(roomId: string, event: RoomEvent): void {
    const set = this.subs.get(roomId);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(event);
      } catch {
        /* 订阅者异常不阻塞牌局 */
      }
    }
  }
}

export interface RoomServiceDeps {
  store: SqliteFrameStore;
  gateway: OtterGateway;
  bus: RoomBus;
  /** 真人决策超时（默认 15000，方案口径） */
  humanTimeoutMs?: number;
  /** 超时后宽限（默认 15000，宽限内广播 deadline；到期代理自动摸切） */
  humanGraceMs?: number;
}

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
}

export interface RoomView {
  roomId: string;
  gameId: string;
  status: string;
  roundNo: number;
  honba: number;
  sticks: number;
  dealer: Seat;
  phase: string | null;
  seatWinds: string[];
  wallRemaining: number;
  doraIndicators: string[];
  players: Array<{
    seat: Seat;
    name: string;
    kind: string;
    points: number;
    hand: string[] | null;
    melds: Array<{ type: string; tiles: string[]; from?: string }>;
    kita: string[];
    discards: string[];
    riichi: boolean;
    riichiTurn: number;
    ippatsu: boolean;
  }>;
  decision: DecisionPoint | null;
  awaitingHuman: { seat: Seat; deadline: string } | null;
  settlement: unknown;
}

export class RoomService {
  private readonly rooms = new Map<string, RoomInternal>();
  private readonly humanTimeoutMs: number;
  private readonly humanGraceMs: number;

  constructor(private readonly deps: RoomServiceDeps) {
    this.humanTimeoutMs = deps.humanTimeoutMs ?? 15_000;
    this.humanGraceMs = deps.humanGraceMs ?? 15_000;
  }

  // ── 生命周期 ──

  /** 建房开局：配牌 + 首帧 + 广播，推进异步起跑 */
  createRoom(roomId: string, config: GameConfig): { gameId: string } {
    if (this.rooms.has(roomId)) throw new Error(`room already exists: ${roomId}`);
    const gameId = `${roomId}-${Date.now().toString(36)}`;
    const engine = new SanmaEngine(config);
    const events = engine.startRound();
    this.deps.store.createGame(gameId, roomId, config);
    this.deps.store.appendFrame(gameId, engine.state, null);
    const room: RoomInternal = { roomId, gameId, engine, chain: Promise.resolve(), awaiting: null };
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
    const room: RoomInternal = { roomId, gameId: game.id, engine, chain: Promise.resolve(), awaiting: null };
    this.rooms.set(roomId, room);
    if (engine.state.status !== "playing") return { gameId: game.id };
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
      if (engine.state.status !== "playing") return;
      const dp = engine.decisionPoint();
      if (!dp) {
        const events = engine.nextRound();
        const seq = this.storeFrame(room, null);
        this.publishGame(room, events, engine.decisionPoint(), seq);
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
}
