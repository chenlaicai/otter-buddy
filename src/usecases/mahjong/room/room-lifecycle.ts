/**
 * 牌局生命周期控制（#1564-5/#1564-6）：局终结算停驻 / 停局 / 真人离桌 runaway 界。
 * 自 room-service 拆出（控 max-lines）；room 内部态经结构化参数注入，定时器回调不入 class。
 */
import type { SanmaEngine } from "../engine/engine";

/** 生命周期控制所需的 room 内部态子集（RoomInternal 结构满足） */
export interface LifecycleRoom {
  roomId: string;
  engine: SanmaEngine;
  awaiting?: unknown;
  settleTimer?: ReturnType<typeof setTimeout>;
  settleResumed: boolean;
  humanIdleStrikes: number;
}

export type LifecycleResult = { ok: true } | { ok: false; reason: string };

/**
 * #1564-5：局终分流——有真人的房挂结算停驻定时器（"parked"，loop 让位等「继续」/超时）；
 * 纯獭代理房或已放行（继续按钮/超时置位）则 "advance"（放行位复位）。
 */
export function settleRoundEndFlow(
  room: LifecycleRoom,
  holdMs: number,
  onHoldExpired: () => void,
): "parked" | "advance" {
  const hasHuman = room.engine.state.round!.players.some((p) => p.kind === "human");
  if (!hasHuman || room.settleResumed) {
    room.settleResumed = false;
    return "advance";
  }
  if (!room.settleTimer) {
    room.settleTimer = setTimeout(() => {
      room.settleTimer = undefined;
      room.settleResumed = true;
      onHoldExpired();
    }, holdMs);
  }
  return "parked";
}

/** #1564-5：结算停驻放行（continue 接口）——校验后清停驻定时器、置放行位并 kick */
export function continueSettlement(room: LifecycleRoom | undefined, kick: () => void): LifecycleResult {
  if (!room) return { ok: false, reason: "room not found" };
  if (room.awaiting) return { ok: false, reason: "awaiting action" };
  if (!room.settleTimer) {
    if (room.engine.state.status !== "playing") return { ok: false, reason: "game already finished" };
    return { ok: false, reason: "not in settlement pause" };
  }
  clearTimeout(room.settleTimer);
  room.settleTimer = undefined;
  room.settleResumed = true;
  kick();
  return { ok: true };
}

/** #1564-6：停局（stop 接口）——通知 + 关房；未知房拒绝 */
export function stopRoomFlow(
  room: LifecycleRoom | undefined,
  notifyAndClose: () => void,
): LifecycleResult {
  if (!room) return { ok: false, reason: "room not found" };
  notifyAndClose();
  return { ok: true };
}

/** #1564-6：真人离桌 runaway 界——超时代打计数到限执行关房回调；返回 true = 已关房（调用方勿再 kick） */
export function guardHumanIdleStrike(
  room: LifecycleRoom,
  limit: number,
  closeRoom: () => void,
): boolean {
  room.humanIdleStrikes += 1;
  if (room.humanIdleStrikes < limit) return false;
  closeRoom();
  return true;
}
