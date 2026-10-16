/**
 * 獭回话入 chat 流（#1532 聊天回显·引擎半场）——自 room-service injectPendingChat 拆出
 * （room-service 顶着 max-lines 450）。纯函数：非空才发、座位/名字回查配置，失败静默由调用方守。
 */

import type { RoomBus } from "./room-types";
import type { PlayerConfig } from "../engine/types";

export function publishOtterChat(
  bus: RoomBus,
  roomId: string,
  players: readonly PlayerConfig[],
  otterId: string,
  reply: string,
): void {
  const text = reply.trim().slice(0, 300);
  if (!text) return;
  const seatIdx = players.findIndex((p) => p.otterId === otterId);
  const player = seatIdx >= 0 ? players[seatIdx] : undefined;
  if (!player) return;
  bus.publish(roomId, {
    type: "chat",
    roomId,
    seat: seatIdx as 0 | 1 | 2,
    name: player.name,
    from: "otter",
    text,
    at: new Date().toISOString(),
  });
}
