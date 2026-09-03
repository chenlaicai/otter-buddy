/** Self-Healing 模块共享常量 */
export const HEALING_CONVERSATION_KEY = '__self_healing_conversation_id__';
export const HEALING_BIG_OTTER_ID_KEY = '__self_healing_big_otter_id__';

/**
 * #751：健康探针哨兵标识——探针事件的 id/messageId/conversationId/otterId 均用此字面量。
 * 写入侧（CircuitBreakSupport.probeHealingRepo）与消费侧（healing query 过滤）共用，
 * 防两侧字面量漂移导致过滤失配。
 */
export const HEALING_PROBE_SENTINEL = 'probe-test';

/** #751：判断事件是否为健康探针（messageId/conversationId/otterId 任一命中哨兵） */
export function isHealingProbeEvent(event: { messageId: string; conversationId: string; otterId: string }): boolean {
  return event.messageId === HEALING_PROBE_SENTINEL
    || event.conversationId === HEALING_PROBE_SENTINEL
    || event.otterId === HEALING_PROBE_SENTINEL;
}
