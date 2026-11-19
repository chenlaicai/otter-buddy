/**
 * F20261119extsg：外部接入对话（CoLink 等）的身份中性化单一实现。
 *
 * Why：外部对话的 user message 由三个独立面拼装——信号台账（signal-router）、在场名册
 * （buildRoster）、最终消息组装（resolveUserEntryLabel）。任一面回退到搭档显示名，
 * 攻击者文本就与内部身份同处一个 prompt（泄漏 + 可冒充「搭档在场」）。
 * 三面共用本文件，避免各自维护「外部判定 + 尾号规则」而漏掉一条路径。
 */

/** 外部发送者 senderId 前缀（适配器写入：`external:<actorId>`）。 */
export const EXTERNAL_SENDER_PREFIX = "external:";

/** 外部对话里对「人」的中性称呼——不含搭档名、不含仓库/身份线索。 */
export const NEUTRAL_EXTERNAL_USER_LABEL = "外部用户";

export function isExternalSenderId(senderId: string | null | undefined): boolean {
  return typeof senderId === "string" && senderId.startsWith(EXTERNAL_SENDER_PREFIX);
}

/**
 * 外部发送者的展示标签：优先自报称呼，否则「外部用户 <尾4>」。
 * 尾号只作去重/指代用（同一对话内区分不同外部用户），不携带平台身份信息。
 */
export function externalSenderLabel(senderId: string, senderName?: string | null): string {
  const name = senderName?.trim();
  if (name) return name;
  const tail = senderId.slice(EXTERNAL_SENDER_PREFIX.length).replace(/[^\w]/g, "").slice(-4);
  return tail ? `${NEUTRAL_EXTERNAL_USER_LABEL} ${tail}` : NEUTRAL_EXTERNAL_USER_LABEL;
}
