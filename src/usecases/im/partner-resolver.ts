/**
 * F20260826fpbd：搭档身份静态判定。
 *
 * Why 独立类：搭档身份在两处消费（dispatch-chain-engine 的历史渲染/roster、
 * message-processor 的命令门禁），集中判定便于测试与未来扩展（白名单/访客模式）。
 *
 * Why 单一 isPartner() 入口而非 FromFeishu/FromWeb 双方法：门禁语义是
 * 「是否搭档」而非「是否飞书搭档」，按 senderId 形态内部分派，
 * 未来其他渠道（钉钉/Slack）接入时门禁无需改动。
 *
 * F20260928wxid：构造参数改 rest 收多渠道 ID——同一搭档在飞书是 open_id、
 * 在微信是 ilink_user_id，两者指向同一人。微信消息入站后海獭也要能认出
 * 「这是搭档本人」而非陌生人；旧单参构造兼容保留（旧调用处降级为单渠道判定）。
 */
export class PartnerResolver {
  /** 任一渠道 ID 已配置——未配置时消费方走降级路径（动态推断/不拦截） */
  readonly configured: boolean;

  private readonly partnerIds: Set<string>;

  constructor(...partnerIdList: Array<string | undefined>) {
    // trim 双保险：config 层已 trim，这里再守一道——空白串视为未配置，避免 yaml 留空格导致"已配置但无人能匹配"
    this.partnerIds = new Set(
      partnerIdList
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .map(id => id.trim()),
    );
    this.configured = this.partnerIds.size > 0;
  }

  isPartner(senderId: string): boolean {
    // Web 端 senderId 恒为 'user'（web/src 硬编码）——本机即搭档本人，恒真
    if (senderId === 'user') return true;
    if (!this.configured) return false;
    return this.partnerIds.has(senderId.trim());
  }
}
