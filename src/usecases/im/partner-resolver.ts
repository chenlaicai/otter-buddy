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
 * 「这是搭档本人」而非陌生人。
 * F20261113wxplo：拆 forGate（单渠道锚，门禁）/ forIdentity（多渠道，身份标注）
 * 双入口，构造器私有——误用（把跨渠道 ID 塞进门禁）编译期可查。
 *
 * F20260928fsqr：addPartnerId 运行时写入——飞书扫码首个 ownerOpenId 先写先得
 * （对齐微信 ensureWeixinConfig 幂等语义）；仅渲染链全局实例用（每线命令门禁
 * resolver 独立构造，不调用本方法）。configured 定为 getter：动态写入后
 * 后续判定能看到新锚（构造期快照会固住 false）。
 */
export class PartnerResolver {
  /** 任一渠道 ID 已配置——未配置时消费方走降级路径（动态推断/不拦截） */
  get configured(): boolean {
    return this.partnerIds.size > 0;
  }

  private readonly partnerIds: Set<string>;

  /**
   * 门禁语义单入口（单渠道锚）：「配置了本渠道搭档锚才拦截」——
   * 只应传同一渠道的 ID（如微信线 owner / 飞书线 owner+首号），
   * 混入跨渠道 ID 会让 configured 误翻 true，锁死另一渠道命令。
   */
  static forGate(...partnerIdList: Array<string | undefined>): PartnerResolver {
    return new PartnerResolver(partnerIdList);
  }

  /**
   * 身份标注语义入口（多渠道）：同一搭档跨渠道 ID（飞书 open_id、微信 ilink_user_id）
   * 一起传入，任一命中即认作本人。仅供渲染链（dispatch-chain-engine）装配处，
   * 不用于命令门禁。
   */
  static forIdentity(...partnerIdList: Array<string | undefined>): PartnerResolver {
    return new PartnerResolver(partnerIdList);
  }

  private constructor(partnerIdList: Array<string | undefined>) {
    // trim 双保险：config 层已 trim，这里再守一道——空白串视为未配置，避免 yaml 留空格导致"已配置但无人能匹配"
    this.partnerIds = new Set(
      partnerIdList
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .map(id => id.trim()),
    );
    // F20260928fsqr：configured 是 getter（动态反映 addPartnerId 运行时写入），构造期不再赋值
  }

  isPartner(senderId: string): boolean {
    // Web 端 senderId 恒为 'user'（web/src 硬编码）——本机即搭档本人，恒真
    if (senderId === 'user') return true;
    if (!this.configured) return false;
    return this.partnerIds.has(senderId.trim());
  }

  /** F20260928fsqr：运行时追加搭档 ID（幂等；空白串忽略）。
   * 仅供渲染链全局实例——首个飞书扫码人先写先得；DELETE 不回收（记特性文档遗留） */
  addPartnerId(id: string | undefined): void {
    if (typeof id !== 'string') return;
    const trimmed = id.trim();
    if (!trimmed) return;
    this.partnerIds.add(trimmed);
  }
}
