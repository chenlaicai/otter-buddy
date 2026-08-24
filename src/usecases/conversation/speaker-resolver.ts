import type { SenderType } from "@entities/conversation/message";

/**
 * 发送者显示名统一解析（层 2 收敛点）。
 * - otter：优先已解析名（持久化快照或查询结果），fallback 终点是 senderId
 * - user/system：返回 null（显示名是前端概念，交层 3）
 */
export function resolveSpeakerName(
  senderType: SenderType,
  senderId: string,
  otterName?: string | null,
): string | null {
  if (senderType !== "otter") return null;
  return (otterName ?? "").trim() || senderId;
}
