import type { ManageConnection } from "@usecases/im/manage-connection";
import type { ManageConversation } from "@usecases/conversation/manage-conversation";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { MemoryIndexGateway } from "@usecases/conversation/memory-index-gateway";
import type { Logger } from "@usecases/ports/logger";
import { fmtImTime } from "@usecases/im/time-format";

/**
 * F20260918imas / F20260920imax：IM 助理会话管理器。
 *
 * 助理态语义（F20260920imax 按搭档三条指令修订）：
 * - 一个 im 账号 = 一个对话（永续）：connection 按 fromUserId 锚定，重扫码回同一对话，
 *   不再翻篇——72h 软轮换（收篇翻篇新开对话）机制删除
 * - 8h 间隔 → 全新 session（重启獭生）：对话不动，新发言距上一条 entry 超 8h 时，
 *   该对话的 otter 走 restartSession（系统机械交接摘要，非 Pi 内置压缩算法），
 *   收篇摘要顺手沉淀记忆（跨 session 连续感由记忆承载）
 * - 助理对话建库时写 kind='assistant'（schema 字段取代 title 前缀约定）
 *
 * F20260924wast：maybeRestartIdleSession 从 private 暴露公开入口
 * checkIdleAndRestartSession——HTTP sendMessage 链（web 助理对话）在 precheck 后、
 * sendEntry 前调用（S1 修复：纯 web 使用场景 session 永不轮换的缺口）。并发防重：
 * restarting 集合按 conversationId 加进行中标记（双 tab 同 tick 触发时收敛为一次），
 * 完成/失败均清除标记（失败下次消息再试，与 IM 链失败语义一致）。
 *
 * 交接摘要 v1 为机械拼接（确定性可测，不经 LLM）——与 #1049 统一交接架构的
 * narrative-synthesis 引擎刻意区隔：8h 重启的交接原料是「对话静默期边界」，语义
 * 简单（用户隔天回来），机械摘要足够；水位触发的 LLM 叙事合成留给主链路。
 */
export class AssistantSessionManager {
  /** 交接摘要取最近 N 条 entry（user + speak 各取一半额度，拼接后总量再截断） */
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
      /** F20260920imax：session 管理（8h 静默 → restartSession 换新 session） */
      manageSession?: { restartSession(otterId: string, summary?: string, modelAlias?: string, reason?: "restart" | "compaction"): Promise<unknown> };
      /** 对话→otter 解析（assistant 对话恒有一只大獭，见 ManageConversation.create） */
      getOtterIds?(conversationId: string): Promise<string[]>;
      logger: Logger;
      /** 8h 静默阈值（小时，config im.assistant.sessionIdleHours，默认 8） */
      sessionIdleHours: number;
    },
  ) {}

  /** F20260924wast（D1）：restart 进行中标记（conversationId 集合）——双 tab 同 tick
   *  对同一对话并发触发 restart 时的防重闸；完成/失败均清除（失败下次消息再试） */
  private readonly restarting = new Set<string>();

  /**
   * 确保该 connection 有可用的助理对话（入站主链唯一入口）：
   * - 无绑定 → 自动开户（建对话 + 绑定，kind=assistant）
   * - 有绑定 → 永续复用（不翻篇）；8h 静默检查换 session（对话不动）
   *
   * 并发边界（F20260918imas 检视发现 3 留痕）：getCurrentConversation→provision 非原子——
   * 同窗口毫秒级并发两条消息时，enterConversation 事务互斥使第二个 provision 抛
   * already occupied → 回退拒聊提示；副作用是多建一个孤儿 active 对话（/list 噪音，
   * 无数据损坏）。依赖「入站主链单窗口串行」假设，低概率低危害不加盖。
   *
   * 返回 null 仅当开户失败（enterConversation 异常等）——调用方回退拒聊提示。
   */
  async ensureAssistantConversation(input: {
    connectionId: string;
    channel: "weixin" | "feishu";
    /** 助理对话标题中的对端显示名（微信好友 id 尾部 / 飞书姓名） */
    displayName: string;
    /** F20260920imax：助理线模型（透传给 ManageConversation.create → CreateOtter；缺省全局 default） */
    modelAlias?: string;
  }): Promise<{ id: string; title: string } | null> {
    const current = await this.deps.manageConnection.getCurrentConversation(input.connectionId);
    if (!current) {
      return this.provision(input);
    }
    // F20260920imax：对话永续——不轮换不翻篇；仅做 session 静默检查
    await this.maybeRestartIdleSession(current.id);
    return current;
  }

  /** F20260924wast（S1）：HTTP sendMessage 链公开入口——web 助理对话的 8h 静默
   *  session 重启检查。语义与 IM 入站链 ensureAssistantConversation 内联检查完全
   *  一致（同一 maybeRestartIdleSession 实现）；调用方（message-controller）负责
   *  严格限定 kind=web-assistant 对话（IM 助理对话由 IM 入站链保证，不重复触发）。 */
  async checkIdleAndRestartSession(conversationId: string): Promise<void> {
    await this.maybeRestartIdleSession(conversationId);
  }

  /** 自动开户：建助理对话（kind=assistant，title = 搭档起的名）+ 绑定 connection（与 /in 同一事务入口，互斥语义复用）。
   *  F20260920imax：title 不再拼接通道前缀（微信线名字在扫码时由搭档必填；
   *  飞书专线默认「飞书助理」）——前缀约定已随 kind 字段退役 */
  private async provision(input: {
    connectionId: string;
    channel: "weixin" | "feishu";
    displayName: string;
    modelAlias?: string;
  }): Promise<{ id: string; title: string } | null> {
    const title = input.displayName;

    try {
      const conversation = await this.deps.manageConversation.create({ title, kind: "assistant", ...(input.modelAlias && { modelAlias: input.modelAlias }) });
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
   * F20260920imax：8h 静默 → session 重启（重启獭生，非 Pi 内置压缩）。
   * 触发锚 = 对话最后一条 entry 距今超过 sessionIdleHours（活跃对话持续刷新天然不触发）。
   * 交接摘要 = 机械拼接（writeDigest），作为 restartSession 的 summary 注入新 session 前世上下文。
   * 摘要落 summary + 记忆照旧（连续性锚）。失败不阻塞消息处理（丢摘要代价 < 丢消息代价）。
   * F20260924wast（D1）：进行中标记防重——同对话并发触发（双 tab 同 tick）时后续调用
   *  直接跳过（首个完成的 restart 已换新 session，后续消息落新 session 天然正确）。
   */
  private async maybeRestartIdleSession(conversationId: string): Promise<void> {
    if (!this.deps.manageSession || !this.deps.getOtterIds) return;
    if (this.restarting.has(conversationId)) return; // 并发防重：同对话 restart 进行中
    this.restarting.add(conversationId);
    try {
      const latest = await this.deps.entryRepo.getEntries(conversationId, { limit: 1 });
      if (latest.length === 0) return; // 空对话（异常态，如孤儿）不处理

      const lastAt = new Date(latest[0].createdAt).getTime();
      const thresholdMs = this.deps.sessionIdleHours * 60 * 60 * 1000;
      if (Number.isNaN(lastAt) || Date.now() - lastAt < thresholdMs) return;

      const otterIds = await this.deps.getOtterIds(conversationId);
      const assistantOtter = otterIds[0];
      if (!assistantOtter) return;

      this.deps.logger.info("Assistant session idle restart triggered", {
        conversationId,
        otterId: assistantOtter,
        lastEntryAt: latest[0].createdAt,
        sessionIdleHours: this.deps.sessionIdleHours,
      });

      // 交接摘要：机械拼接（不经 LLM），构建一次全链共用（检视发现 1 处置——原双重
      // buildDigest 曾把空标题摘要发给 restartSession）；先落库再重启（发现 4——
      // 先 writeDigest 后 restartSession，消除新 session 立即产生 entry 混入摘要的竞态窗口）
      const title = await this.resolveTitle(conversationId);
      const digest = await this.buildDigest({ id: conversationId, title });
      await this.deps.conversationRepo.updateSummary(conversationId, digest);
      if (this.deps.memoryIndex) {
        // fact 类记忆条目，conversationId 关联——新 session 大獭经 search_memory 自然召回
        await this.deps.memoryIndex.indexAssistantDigest(`digest-${conversationId}`, conversationId, digest);
      }
      await this.deps.manageSession.restartSession(assistantOtter, digest, undefined, "restart");
    } catch (err) {
      // 失败不阻塞入站消息（下次消息再试）
      this.deps.logger.error("Assistant session idle restart failed (message continues)", err instanceof Error ? err : undefined, {
        conversationId,
      });
    } finally {
      // F20260924wast（D1）：防重标记在成功/失败/提前返回路径统一清除
      this.restarting.delete(conversationId);
    }
  }

  private async resolveTitle(conversationId: string): Promise<string> {
    const conv = await this.deps.conversationRepo.getById(conversationId);
    return conv?.title ?? conversationId;
  }

  /** 摘要落库：conversation.summary + 记忆条目（F20260920imax 检视发现 1/4 处置后仅
   *  非重启路径使用；重启路径在 maybeRestartIdleSession 内联同语义逻辑——构建一次全链共用） */
  private async writeDigest(current: { id: string; title: string }): Promise<void> {
    const digest = await this.buildDigest(current);
    await this.deps.conversationRepo.updateSummary(current.id, digest);

    if (this.deps.memoryIndex) {
      // fact 类记忆条目，conversationId 关联——新 session 大獭经 search_memory 自然召回（连续性承载）
      await this.deps.memoryIndex.indexAssistantDigest(`digest-${current.id}`, current.id, digest);
    }
  }

  /** 机械拼接摘要（确定性，不经 LLM）——session 重启交接与记忆沉淀共用同一原料 */
  private async buildDigest(current: { id: string; title: string }): Promise<string> {
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
      const time = fmtImTime(e.createdAt);
      const body = (e.body ?? "").replace(/\s+/g, " ").trim().slice(0, AssistantSessionManager.DIGEST_ENTRY_MAX_CHARS);
      return `[${time}] ${role}: ${body}`;
    });

    return `【助理对话交接 · ${current.title}】\n${lines.join("\n")}`.slice(0, AssistantSessionManager.DIGEST_TOTAL_MAX_CHARS);
  }
}
