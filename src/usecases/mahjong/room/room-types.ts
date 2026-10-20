/**
 * 房间事件与视图类型（自 room-service.ts 拆出——room-service 已逼近 max-lines 450）。
 * RoomService 侧 re-export，消费方仍可从 room-service 导入。
 */

import type { DecisionPoint, EngineEvent, Seat, Settlement } from "../engine/types";
import type { Logger } from "../../ports/logger";
import type { SqliteFrameStore } from "./frames";
import type { OtterGateway } from "./otter-adapter";

/** 真人回话（下局开局注入各 otter session；本条即时广播供聊天框回显） */
export interface ChatMessage {
  readonly seat: Seat;
  readonly name: string;
  readonly text: string;
  readonly at: string;
}

/** 局终战报原料（onGameover 一次性上报；bootstrap 侧渲染 html-card + 登记 linked_resource） */
export interface GameoverReport {
  readonly roomId: string;
  readonly gameId: string;
  readonly seed: string;
  readonly players: ReadonlyArray<{ seat: Seat; name: string; kind: string; otterId?: string }>;
  /** 终局名次（gameOver 事件携带；缺失时按末局点数回退推导） */
  readonly ranking: ReadonlyArray<{ seat: Seat; name: string; points: number }>;
  /** 每局和了/流局/流局满贯等结算（役种亮点数据源——跨局累积，engine.round.settlement 只留末局） */
  readonly highlights: ReadonlyArray<{ roundNo: number; settlement: Settlement }>;
  /** 獭桌上发言（wake speech 采集） */
  readonly speeches: ReadonlyArray<{ seat: Seat; name: string; text: string }>;
  /** 代理代打次数（唤醒失败 fallback + 真人超时 timeout-fallback——战报标注） */
  readonly proxyFallbacks: number;
  readonly startedAt: number;
  readonly endedAt: number;
}

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
  | { type: "chat"; roomId: string; seat: Seat; name: string; from: "human" | "otter"; text: string; at: string }
  | { type: "error"; roomId: string; message: string };

export type RoomEventListener = (event: RoomEvent) => void;

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

/** 房间粒度事件总线（SSE/WS 订阅点；自 room-service.ts 拆出） */
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
  /** F20261015mjsg 局终回调（战报卡数据口）——bootstrap 装配 SendEntry；失败仅告警不回滚牌局 */
  onGameover?: (report: GameoverReport) => void | Promise<void>;
  /** 失败路径留痕（回调/注入异常）；缺省静默降级 */
  logger?: Pick<Logger, "warn">;
  /** 检视发现3：终局房宽限出 Map 的毫秒数（≤0 = 立即驱逐；默认 10 分钟——宽限内 view/recover 可用） */
  evictFinishedMs?: number;
  /** #1564-5：局终结算停驻时长（有真人的房暂停等「继续」；默认 30 秒，到期自动继续） */
  settleHoldMs?: number;
  /** #1564-6：真人连续超时代打上限（到限自动停局防 runaway；默认 10） */
  humanIdleStrikeLimit?: number;
}
