/**
 * F20260826fpbd：搭档身份静态判定。
 *
 * Why 独立类：搭档身份在两处消费（dispatch-chain-engine 的历史渲染/roster、
 * message-processor 的命令门禁），集中判定便于测试与未来扩展（白名单/访客模式）。
 *
 * Why 单一 isPartner() 入口而非 FromFeishu/FromWeb 双方法：门禁语义是
 * 「是否搭档」而非「是否飞书搭档」，按 senderId 形态内部分派，
 * 未来其他渠道（钉钉/Slack）接入时门禁无需改动。
 */
export class PartnerResolver {
  /** partnerOpenId 是否已配置——未配置时消费方走降级路径（动态推断/不拦截） */
  readonly configured: boolean;

  constructor(private readonly partnerOpenId: string | undefined) {
    // trim 双保险：config 层已 trim，这里再守一道——空白串视为未配置，避免 yaml 留空格导致"已配置但无人能匹配"
    this.configured = typeof partnerOpenId === 'string' && partnerOpenId.trim().length > 0;
  }

  isPartner(senderId: string): boolean {
    // Web 端 senderId 恒为 'user'（web/src 硬编码）——本机即搭档本人，恒真
    if (senderId === 'user') return true;
    if (!this.configured) return false;
    return senderId === this.partnerOpenId!.trim();
  }
}
