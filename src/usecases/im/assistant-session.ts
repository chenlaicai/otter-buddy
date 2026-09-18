import type { ManageConnection } from "@usecases/im/manage-connection";
import type { ManageConversation } from "@usecases/conversation/manage-conversation";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { MemoryIndexGateway } from "@usecases/conversation/memory-index-gateway";
import type { Logger } from "@usecases/ports/logger";

/**
 * F20260918imas：IM 助理会话管理器。
 *
 * 助理态语义：微信私聊 / 飞书 p2p 的入站消息不再要求 /in 显式绑定——
 * 首条消息自动创建专属助理对话并绑定 connection（免开户墙）；
 * 绑定存续期间按 last-entry 距离做软轮换（收篇 + 翻篇），连续性由记忆系统承载。
 *
 * 设计锚点（特性文档「软轮换 + 收篇摘要」节）：
 * - 触发锚 = 最后一条 entry 距今（活跃对话 last entry 持续刷新，天然不触发）
 * - 收篇摘要 v1 为机械摘要（最近 N 条 user/speak entry 拼接）——确定性可测；
 *   LLM 摘要是演进项，不阻塞本版（摘要核心用途是记忆连续性锚，
 *   新篇的检索由大獭的 search_memory 工具自然覆盖）
 * - 收篇失败不阻塞翻篇（丢摘要代价 < 丢消息代价）
 */
export class AssistantSessionManager {
  /** 收篇摘要取最近 N 条 entry（user + speak 各取一半额度，拼接后总量再截断） */
  private static readonly DIGEST_ENTRY_LIMIT = 30;
  /** 单条 entry 摘要截断 */
  private static readonly DIGEST_ENTRY_MAX_CHARS = 300;
  /** 收篇摘要总量截断（超长会稀释记忆信噪比） */
  private static readonly DIGEST_TOTAL_MAX_CHARS = 4000;

  constructor(
    private readonly deps: {
      manageConnection: ManageConnection;
      manageConversation: ManageConversation;
      conversationRepo: ConversationRepository;
      entryRepo: EntryRepository;
      /** 可选注入：未注入时收篇摘要仅落 conversation.summary，不进记忆 */
      memoryIndex?: MemoryIndexGateway;
      logger: Logger;
      /** 软轮换阈值（小时）；last-entry 距今超过即翻篇 */
      rotationHours: number;
    },
  ) {}

  /**
   * 确保该 connection 有可用的助理对话（入站主链唯一入口）：
   * - 无绑定 → 自动开户（建对话 + 绑定）
   * - 有绑定 → 检查轮换条件，满足则收篇翻篇（旧对话 complete + 新开）并返回新篇
   *
   * 返回 null 仅当开户失败（enterConversation 异常等）——调用方回退拒聊提示。
   */
  async ensureAssistantConversation(input: {
    connectionId: string;
    channel: "weixin" | "feishu";
    /** 助理对话标题中的对端显示名（微信好友 id 尾部 / 飞书姓名） */
    displayName: string;
  }): Promise<{ id: string; title: string } | null> {
    const current = await this.deps.manageConnection.getCurrentConversation(input.connectionId);
    if (!current) {
      return this.provision(input);
    }
    const rotated = await this.maybeRotate(current, input);
    return rotated ?? current;
  }

  /** 自动开户：建助理对话 + 绑定 connection（与 /in 同一事务入口，互斥语义复用） */
  private async provision(input: {
    connectionId: string;
    channel: "weixin" | "feishu";
    displayName: string;
  }): Promise<{ id: string; title: string } | null> {
    const prefix = input.channel === "weixin" ? "微信助理" : "飞书助理";
    const title = `${prefix} · ${input.displayName}`;

    try {
      const conversation = await this.deps.manageConversation.create({ title });
      await this.deps.manageConnection.enterConversation(input.connectionId, conversation.id);
      this.deps.logger.info("Assistant conversation provisioned", {
        connectionId: input.connectionId,
        conversationId: conversation.id,
        channel: input.channel,
      });
      return { id: conversation.id, title: conversation.title };
    } catch (err) {
      // 开户失败回退拒聊（消息不丢——用户会收到提示而非静默）
      this.deps.logger.error("Assistant conversation provisioning failed", err instanceof Error ? err : undefined, {
        connectionId: input.connectionId,
        channel: input.channel,
      });
      return null;
    }
  }

  /**
   * 软轮换检查：last-entry 距今超过阈值 → 收篇（摘要落 summary + 记忆）
   * + 翻篇（旧对话 complete + 新开户）。
   * 空对话（无 entry）不轮换——避免「开户即翻篇」循环。
   */
  private async maybeRotate(
    current: { id: string; title: string },
    input: { connectionId: string; channel: "weixin" | "feishu"; displayName: string },
  ): Promise<{ id: string; title: string } | null> {
    const latest = await this.deps.entryRepo.getEntries(current.id, { limit: 1 });
    if (latest.length === 0) return null;

    const lastAt = new Date(latest[0].createdAt).getTime();
    const thresholdMs = this.deps.rotationHours * 60 * 60 * 1000;
    if (Number.isNaN(lastAt) || Date.now() - lastAt < thresholdMs) return null;

    this.deps.logger.info("Assistant conversation rotation triggered", {
      connectionId: input.connectionId,
      conversationId: current.id,
      lastEntryAt: latest[0].createdAt,
      rotationHours: this.deps.rotationHours,
    });

    // 收篇：失败不阻塞翻篇（丢摘要代价 < 丢消息代价——方案「失败降级」节）
    try {
      await this.writeDigest(current);
    } catch (err) {
      this.deps.logger.error("Assistant digest failed (rotation continues)", err instanceof Error ? err : undefined, {
        conversationId: current.id,
      });
    }

    // 翻篇：旧对话收档（complete 后 /list 不再列出，噪音自然衰减）
    try {
      await this.deps.manageConversation.complete(current.id);
    } catch (err) {
      // complete 失败仅影响旧篇状态（如已完成），不阻断新篇开户
      this.deps.logger.error("Assistant rotation complete failed (continuing)", err instanceof Error ? err : undefined, {
        conversationId: current.id,
      });
    }

    // 轮换后返回新篇（provision 失败时返回 null——调用方回退拒聊，不让消息进已 complete 的旧篇）
    const rotated = await this.provision(input);
    return rotated;
  }

  /** 收篇摘要：机械拼接最近 user/speak entry → conversation.summary + 记忆条目 */
  private async writeDigest(current: { id: string; title: string }): Promise<void> {
    const [speaks, users] = await Promise.all([
      this.deps.entryRepo.getEntries(current.id, { entryType: "speak", limit: AssistantSessionManager.DIGEST_ENTRY_LIMIT }),
      this.deps.entryRepo.getEntries(current.id, { entryType: "user", limit: AssistantSessionManager.DIGEST_ENTRY_LIMIT }),
    ]);
    // getEntries 返回 sequence_num DESC（最新在前）——按时间序归位后拼接
    const chronological = [...speaks, ...users]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.sequenceNum - b.sequenceNum))
      .slice(-AssistantSessionManager.DIGEST_ENTRY_LIMIT);

    const lines = chronological.map(e => {
      const role = e.entryType === "user" ? "用户" : "水獭";
      const time = new Date(e.createdAt).toISOString().slice(0, 16).replace("T", " ");
      const body = (e.body ?? "").replace(/\s+/g, " ").trim().slice(0, AssistantSessionManager.DIGEST_ENTRY_MAX_CHARS);
      return `[${time}] ${role}: ${body}`;
    });

    const digest = `【助理对话收篇 · ${current.title}】\n${lines.join("\n")}`.slice(0, AssistantSessionManager.DIGEST_TOTAL_MAX_CHARS);

    await this.deps.conversationRepo.updateSummary(current.id, digest);

    if (this.deps.memoryIndex) {
      // fact 类记忆条目，conversationId 关联——新篇大獭经 search_memory 自然召回（连续性承载）
      await this.deps.memoryIndex.indexAssistantDigest(`digest-${current.id}`, current.id, digest);
    }
  }
}
