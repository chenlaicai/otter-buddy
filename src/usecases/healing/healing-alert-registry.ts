/**
 * Healing 高危路由登记表（F20260826mwrd C3，母方案 Part 4）。
 *
 * 现状：severity:high 事件写入后仅 logger.warn——大獭要等每日批处理才知道。
 * 增强：high 事件写入时在此登记，大獭下一次 invoke 的 buildDynamicContext 消费
 * （拼进 DynamicContext.healingAlerts 注入 reminder）——送达时点由「下一个 invoke
 * 边界」保证：大獭空闲时几乎即时；大獭 invoke 中途 enqueue 的事件顺延到下下轮
 * （本轮 invoke 的 DynamicContext 已构建完成）。无需轮询。
 *
 * 内存态而非落库：这是「未送达的提醒」队列，送达即删；healing_events 主台账
 * 仍是持久化真相源（本模块不重复持久化）。进程重启丢队列的代价 = 大獭错过一次
 * 提醒，但台账数据完整、每日健康检查兜底——接受。
 *
 * 键为 conversationId（非 bigOtterId）：intercept 时 ctx 没有 otter 类型信息，
 * 解析「谁是大獭」是消费侧（agent-invoker）的职责——它查得到参与者与类型。
 *
 * 进程级单例（同 haltRegistry 模式）：interceptHealingReport 写、
 * agent-invoker buildDynamicContext 读，同进程无跨进程需求。
 */

/** 一条待提醒的高危 healing 事件 */
export interface HealingAlert {
  /** healing_events 落账 id（大獭跟进时可用 manage_healing_events 查详情） */
  eventId: string;
  conversationId: string;
  otterId: string;
  errorType: string;
  description: string;
  createdAt: string;
}

class HealingAlertRegistry {
  /** 对话 → 待提醒队列（键为 conversationId：消费侧按对话取全部，大獭不在场则滞留到下一轮） */
  private pending = new Map<string, HealingAlert[]>();
  /** 单对话积压上限：防滥用/防爆炸——超限丢弃最旧的（台账里仍有全量） */
  private static readonly MAX_PENDING_PER_CONVERSATION = 20;

  /**
   * 登记一条高危事件（对话粒度）。
   * @param conversationId 提醒队列键（消费侧按对话取）
   */
  enqueue(conversationId: string, alert: HealingAlert): void {
    const list = this.pending.get(conversationId) ?? [];
    list.push(alert);
    if (list.length > HealingAlertRegistry.MAX_PENDING_PER_CONVERSATION) {
      list.splice(0, list.length - HealingAlertRegistry.MAX_PENDING_PER_CONVERSATION);
    }
    this.pending.set(conversationId, list);
  }

  /** 下一次该对话内大獭 invoke 时消费：取走全部待提醒（送达即删，不重复提醒） */
  takeAll(conversationId: string): HealingAlert[] {
    const list = this.pending.get(conversationId);
    if (!list || list.length === 0) return [];
    this.pending.delete(conversationId);
    return list;
  }

  /** 非破坏性查看（测试用） */
  peek(conversationId: string): HealingAlert[] {
    return [...(this.pending.get(conversationId) ?? [])];
  }

  /** 测试隔离：清空全部状态 */
  resetForTest(): void {
    this.pending.clear();
  }
}

/** 进程级单例（跨模块共享：interceptHealingReport 写、agent-invoker 读） */
export const healingAlertRegistry = new HealingAlertRegistry();

/**
 * 渲染提醒文本（agent-invoker 消费时调用）。
 * 与台账（manage_healing_events）的分工：这里是「有事件待处置」的即时提醒，
 * 详情查询走台账工具——不在此重复全量信息。
 */
export function renderHealingAlerts(alerts: HealingAlert[]): string {
  const lines = alerts.map(a =>
    `- [${a.createdAt}] ${a.errorType}：${a.description.length > 120 ? a.description.slice(0, 120) + '…' : a.description}`
    + `（发起獭：${a.otterId}）`,
  );
  return `## ⚠️ 高危 healing 事件提醒（小獭上报，需你处置）\n以下 ${alerts.length} 条 severity:high 事件已落台账待处置，请当场裁决或确认已知后继续。\n详情与处置用 manage_healing_events(action=query) 查。\n${lines.join('\n')}`;
}
