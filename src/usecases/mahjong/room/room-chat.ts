/**
 * 牌桌聊天流（#1532）——獭注入回应广播 + 下局开局注入编排（自 room-service 拆出控 max-lines）。
 *
 * 竞态口径（检视发现2，本 PR 修复）：**先同步段原子快照换队、再并发注入**——
 * 注入窗口（LLM 秒级调用）内 `addChat` 只会 push 进新队，不落入任何已拍快照；
 * 失败时把本次快照合并回**队首**（时序：旧消息在前、窗口内新消息在后），保「失败留次局重试」语义。
 */

import { buildChatInjectionPrompt } from "./otter-adapter";
import type { ChatMessage, RoomBus } from "./room-types";
import type { PlayerConfig } from "../engine/types";

/** 注入所需依赖（结构性收窄——RoomService 把 deps 递进来，本文件不反向依赖 room-service 防环） */
export interface ChatInjectDeps {
  gateway: { invoke(otterId: string, message: string): Promise<string> };
  bus: RoomBus;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

/** 房间所需视图（RoomInternal 结构性满足） */
export interface ChatInjectRoom {
  roomId: string;
  chatQueues: Map<string, ChatMessage[]>;
  engine: {
    state: {
      roundNo: number;
      status: string;
      config: { players: readonly PlayerConfig[] };
    };
  };
}

/** 獺回应入 chat 流：trim 非空才发（≤300 字）、座位/名字按 otterId 回查配置，空白不发泡 */
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

/** 下局开局聊天注入（advanceRound 调用；成功清队、失败合并回队首留次局重试；终局轮不注入） */
export async function injectPendingChat(deps: ChatInjectDeps, room: ChatInjectRoom): Promise<void> {
  if (room.chatQueues.size === 0) return;
  // 终局轮过渡（东4 结束→gameOver）不注入——牌局已了，队随房间释放
  if (room.engine.state.status !== "playing") return;
  const roundNo = room.engine.state.roundNo;
  // 同步段原子换队：全部 snapshot+置空完成后才进 await——窗口内 addChat 只进新队（检视发现2）
  const pending: Array<{ otterId: string; snapshot: ChatMessage[] }> = [];
  for (const [otterId, queue] of room.chatQueues) {
    if (queue.length === 0) continue;
    pending.push({ otterId, snapshot: [...queue] });
    room.chatQueues.set(otterId, []);
  }
  if (pending.length === 0) return;
  const players = room.engine.state.config.players;
  await Promise.all(
    pending.map(async ({ otterId, snapshot }) => {
      try {
        const reply = await deps.gateway.invoke(otterId, buildChatInjectionPrompt(snapshot, roundNo));
        publishOtterChat(deps.bus, room.roomId, players, otterId, reply);
      } catch (e) {
        // 失败合并回队首（时序：本次快照在前、窗口内新消息在后）——留次局重试
        const live = room.chatQueues.get(otterId) ?? [];
        room.chatQueues.set(otterId, [...snapshot, ...live]);
        deps.logger?.warn("mahjong chat injection failed, kept for next round", {
          roomId: room.roomId,
          otterId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }),
  );
}
