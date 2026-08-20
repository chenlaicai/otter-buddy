import { DomainError } from "@entities/errors";
import type {
  Message,
  MessageEvent,
  MessageEventType,
  MessageMetadata,
  MessageSegment,
  MessageSource,
} from "@entities/conversation/message";
import {
  canAppendEvent,
  canCompleteMessage,
  canFailMessage,
  canAbortMessage,
  canStartSpeaking,
  canPrepareForRetry,
  isValidCompletedMessage,
  isValidTalkingStonePass,
  aggregateBody,
} from "@entities/conversation/message";
import { stripHtmlCardFences } from "@entities/conversation/message-body-projection";
import { canAddMessageToTurn } from "@entities/conversation/conversation";
import type { ConversationRepository } from "./conversation-repository";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import { tryCloseTurn } from "./turn-utils";
import type { TurnCloseResult } from "./turn-utils";
import type { MemoryIndexGateway } from "./memory-index-gateway";
import type { Logger } from "@usecases/ports/logger";
import { parseMentionsFromText } from "./mention-parser";

/** 用户发送消息输入 */
export interface SendMessageInput {
  conversationId: string;
  senderType?: "user" | "system";  // 默认 "user"，定时任务场景传 "system"
  senderId: string;
  talkingStonePassedTo: string[];
  body: string;
  /** 用户消息来源（"web" | "feishu"），默认 "web"。agent/系统消息不需要此字段 */
  source?: MessageSource;
  /** F20260805rbrg：外部元数据（招聘桥接查重用，外部消息才填） */
  metadata?: MessageMetadata | null;
}

/** Otter 开始流式消息输入 */
export interface StartMessageInput {
  conversationId: string;
  senderId: string;
  talkingStonePassedTo: string[];
}

/** 流式事件输入 */
export interface MessageEventInput {
  messageId: string;
  eventType: MessageEventType;
  payload: Record<string, unknown>;
}

/** 完成消息输入 */
export interface CompleteMessageInput {
  body: string;
  talkingStonePassedTo: string[];
  contextTokens?: number;
  contextTokensMax?: number;
}

/** 开始发言输入 */
export interface StartSpeakingInput {
  /** 可选：随发言一并落库的内容（拆分后由 speak 的 appendSegment 负责，yield 调用时不传） */
  body?: string;
  talkingStonePassedTo: string[];
}

/** 中止消息输入（系统构造的合成中断声明） */
export interface AbortMessageInput {
  body: string;
  talkingStonePassedTo: string[];
}

/** 完成消息结果 */
export interface CompleteResult {
  message: Message;
  turnClose: TurnCloseResult;
}

export class SendMessage {
  constructor(
    private readonly _repo: ConversationRepository,
    private readonly otterRepo: OtterRepository,
    private readonly memoryIndex: MemoryIndexGateway,
    private readonly logger: Logger,
  ) {}

  /** 用户发送消息（立即 completed） */
  async send(input: SendMessageInput): Promise<Message & { mentionFeedback?: string }> {
    const senderType = input.senderType ?? "user";
    const source = input.source ?? "web";

    /** 用户消息统一走目标解析：空目标按领域规则解析默认派发；
     *  显式目标（@ / 卡片回执路由）校验"在场 + otter 未解散"，不合法退默认派发（F20260728htar）。
     *  system 消息豁免校验（定时任务链：目标獭解散后任务消息不应被静默改派）。
     *  F20260820i333：支持从文本解析 @提及 + 解析失败时返回 feedback。 */
    let mentionFeedback: string | undefined
    let talkingStonePassedTo: string[]
    if (senderType === "user") {
      const result = await this.resolveUserTargets(input.conversationId, input.talkingStonePassedTo, input.body)
      talkingStonePassedTo = result.targets
      mentionFeedback = result.feedback
    } else {
      talkingStonePassedTo = input.talkingStonePassedTo
    }

    /** UA-8: completed 消息必须传递发言石（system 豁免） */
    if (!isValidTalkingStonePass(talkingStonePassedTo, "completed", senderType)) {
      throw new DomainError("talkingStonePassedTo must be non-empty for completed messages", "validation");
    }

    /** 确保活跃 Turn 存在 */
    const turn = await this.ensureActiveTurn(input.conversationId);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const sequenceNum = (await this._repo.getMaxSequenceNum(input.conversationId)) + 1;

    const message: Message = {
      id,
      conversationId: input.conversationId,
      turnId: turn.id,
      senderType,
      senderId: input.senderId,
      talkingStonePassedTo,
      status: "completed",
      segments: [],
      sequenceNum,
      contextTokens: null,
      contextTokensMax: null,
      source,
      metadata: input.metadata ?? null,
      createdAt: now,
      completedAt: now,
    };

    await this._repo.createCompletedMessage(message);
    await this._repo.appendSegment(message.id, input.body);

    /** B11: 索引消息内容到记忆系统（html-card 剥离投影，与 FTS 一致） */
    await this.memoryIndex.indexMessage(message.id, message.conversationId, stripHtmlCardFences(input.body));

    /** 尝试关闭 Turn */
    await tryCloseTurn(this._repo, turn.id);

    // 记录消息发送日志
    this.logger.info('Message sent', {
      conversationId: input.conversationId,
      messageId: message.id,
      senderId: input.senderId,
      messageLength: input.body.length,
      source,
      action: 'send',
      ...(mentionFeedback ? { mentionFeedback } : {}),
    });

    return { ...message, mentionFeedback };
  }

  /** Otter 开始流式消息（status="streaming"） */
  async start(input: StartMessageInput): Promise<Message> {
    /** UA-8: streaming 期间可为空 */
    if (!isValidTalkingStonePass(input.talkingStonePassedTo, "streaming", "otter")) {
      throw new DomainError("Invalid talkingStonePassedTo for streaming message", "validation");
    }

    const turn = await this.ensureActiveTurn(input.conversationId);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const sequenceNum = (await this._repo.getMaxSequenceNum(input.conversationId)) + 1;

    const message: Message = {
      id,
      conversationId: input.conversationId,
      turnId: turn.id,
      senderType: "otter",
      senderId: input.senderId,
      talkingStonePassedTo: input.talkingStonePassedTo,
      status: "streaming",
      segments: [],
      sequenceNum,
      contextTokens: null,
      contextTokensMax: null,
      source: null, // agent 消息不需要标记来源，广播给所有已连接前端
      createdAt: now,
      completedAt: null,
    };

    await this._repo.createStreamingMessage(message);
    return message;
  }

  /** 追加流式事件（streaming/speaking 状态可追加） */
  async appendEvent(input: MessageEventInput): Promise<MessageEvent> {
    const message = await this._repo.getMessageById(input.messageId);
    if (!message) {
      throw new DomainError(`Message not found: ${input.messageId}`, "not_found");
    }
    if (!canAppendEvent(message.status)) {
      throw new DomainError(`Cannot append event to message with status: ${message.status}`, "validation");
    }

    const id = crypto.randomUUID();
    const sequenceNum = (await this._repo.getMaxEventSequenceNum(input.messageId)) + 1;
    const event: MessageEvent = {
      id,
      messageId: input.messageId,
      eventType: input.eventType,
      payload: input.payload,
      sequenceNum,
      createdAt: new Date().toISOString(),
    };

    await this._repo.appendEvent(event);
    return event;
  }

  /** 开始发言（yield 工具调用）：streaming → speaking，设置发言石目标；可选 body 时附带插入 segment（同一事务）。
   *  speak+yield 拆分后内容由 speak 的 appendSegment 落库，yield 调用时 body 为空——只设路由与状态。 */
  async startSpeaking(messageId: string, input: StartSpeakingInput): Promise<Message> {
    const message = await this._repo.getMessageById(messageId);
    if (!message) {
      throw new DomainError(`Message not found: ${messageId}`, "not_found");
    }
    if (!canStartSpeaking(message.status)) {
      throw new DomainError(`Cannot start speaking for message with status: ${message.status}`, "conflict");
    }
    if (input.body !== undefined && input.body.trim().length === 0) {
      throw new DomainError("body must be non-empty when provided", "validation");
    }
    if (!isValidTalkingStonePass(input.talkingStonePassedTo, "speaking", message.senderType)) {
      throw new DomainError("talkingStonePassedTo must be non-empty for speaking messages", "validation");
    }

    await this._repo.startSpeaking(messageId, input.body, input.talkingStonePassedTo);

    return {
      ...message,
      status: "speaking",
      talkingStonePassedTo: input.talkingStonePassedTo,
    };
  }

  /** 追加一条 speak 片段到消息 */
  async appendSegment(messageId: string, body: string): Promise<MessageSegment> {
    if (!body || body.trim().length === 0) {
      throw new DomainError("body must be non-empty string", "validation");
    }
    return this._repo.appendSegment(messageId, body);
  }

  /** 完成消息：speaking → completed。segments 从 DB 读取（由 startSpeaking 追加）。 */
  async complete(messageId: string, input?: Partial<CompleteMessageInput>): Promise<CompleteResult> {
    const message = await this._repo.getMessageById(messageId);
    if (!message) throw new DomainError(`Message not found: ${messageId}`, "not_found");
    if (!canCompleteMessage(message.status)) {
      throw new DomainError(`Cannot complete message with status: ${message.status}`, "validation");
    }

    const { talkingStonePassedTo } = this.resolveCompleteParams(message, input);
    const now = new Date().toISOString();

    await this._repo.completeMessage({
      messageId, talkingStonePassedTo, completedAt: now,
      contextTokens: input?.contextTokens, contextTokensMax: input?.contextTokensMax,
    });

    /** 索引记忆用剥离投影（html-card 源码不入索引，与 FTS 一致） */
    const segments = message.segments.length > 0
      ? message.segments
      : await this._repo.getSegments(messageId);
    const body = aggregateBody(segments);
    await this.memoryIndex.indexMessage(message.id, message.conversationId, stripHtmlCardFences(body));
    const turnClose = await tryCloseTurn(this._repo, message.turnId);

    return {
      message: { ...message, status: "completed", segments, talkingStonePassedTo, completedAt: now },
      turnClose,
    };
  }

  /** 解析 complete 参数：从 input 或 DB 中读取 talkingStonePassedTo 并校验 */
  private resolveCompleteParams(
    message: Message,
    input?: Partial<CompleteMessageInput>,
  ): { talkingStonePassedTo: string[] } {
    const talkingStonePassedTo = input?.talkingStonePassedTo ?? message.talkingStonePassedTo;
    if (!talkingStonePassedTo || !isValidTalkingStonePass(talkingStonePassedTo, "completed", message.senderType)) {
      throw new DomainError("talkingStonePassedTo must be non-empty for completed messages", "validation");
    }
    if (!isValidCompletedMessage(message.segments)) {
      throw new DomainError("message must have non-empty segments to complete", "validation");
    }
    return { talkingStonePassedTo };
  }

  /** 标记消息失败（可选 body 存错误信息，可选 talkingStonePassedTo 写入发言石） */
  async fail(messageId: string, body?: string, talkingStonePassedTo?: string[]): Promise<void> {
    const message = await this._repo.getMessageById(messageId);
    if (!message) {
      throw new DomainError(`Message not found: ${messageId}`, "not_found");
    }
    if (!canFailMessage(message.status)) {
      throw new DomainError(`Cannot fail message with status: ${message.status}`, "validation");
    }

    const now = new Date().toISOString();
    await this._repo.failMessage(messageId, now, body, talkingStonePassedTo);

    /** 尝试关闭 Turn */
    await tryCloseTurn(this._repo, message.turnId);
  }

  /**
   * 中止流式消息（用户主动中断）。
   * 与 complete() 类似：追加 segment、传递发言石、索引记忆、关闭 turn，但状态为 aborted。
   */
  async abort(messageId: string, input: AbortMessageInput): Promise<Message> {
    const message = await this._repo.getMessageById(messageId);
    if (!message) {
      throw new DomainError(`Message not found: ${messageId}`, "not_found");
    }
    if (!canAbortMessage(message.status)) {
      throw new DomainError(`Cannot abort message with status: ${message.status}`, "conflict");
    }
    if (!input.body || input.body.trim().length === 0) {
      throw new DomainError("body must be non-empty string", "validation");
    }
    if (!isValidTalkingStonePass(input.talkingStonePassedTo, "aborted", message.senderType)) {
      throw new DomainError("talkingStonePassedTo must be non-empty for aborted messages", "validation");
    }

    const now = new Date().toISOString();
    await this._repo.abortMessage(messageId, input.body, input.talkingStonePassedTo, now);

    /** B-4: 索引消息 body 到记忆系统（中断标记可识别；html-card 剥离投影，与 FTS 一致） */
    await this.memoryIndex.indexMessage(message.id, message.conversationId, stripHtmlCardFences(input.body));

    /** 尝试关闭 Turn */
    await tryCloseTurn(this._repo, message.turnId);

    return {
      ...message,
      status: "aborted",
      talkingStonePassedTo: input.talkingStonePassedTo,
      completedAt: now,
    };
  }

  /**
   * 重置 failed 消息为 streaming（yield 重试专用）。
   * Why: 重试时复用同一消息 ID，避免创建新消息导致用户看到 3 条消息（失败 + 系统提醒 + 新消息）。
   * 操作：清空 body、创建新 Turn 并关联消息、更新 FTS 索引。
   *
   * 设计决策：失败期间的 message_events 保留不删——包含两次尝试的完整
   * 工具调用链，有调试价值。FTS 索引清空以避免搜索命中旧 fail body。
   */
  async prepareForRetry(messageId: string): Promise<Message> {
    const message = await this._repo.getMessageById(messageId);
    if (!message) {
      throw new DomainError(`Message not found: ${messageId}`, "not_found");
    }
    if (!canPrepareForRetry(message.status)) {
      throw new DomainError(`Cannot prepare for retry: status=${message.status}`, "conflict");
    }

    // 创建新 Turn（旧 Turn 已被 fail() 关闭）
    const turn = await this.ensureActiveTurn(message.conversationId);

    // 重置消息状态（含状态守卫 + FTS 清空）
    await this._repo.resetForStreaming(messageId, turn.id);

    return {
      ...message,
      status: "streaming",
      segments: [],
      turnId: turn.id,
      talkingStonePassedTo: null,
    };
  }

  /** 发送系统消息（senderType = "system"，立即 completed，豁免发言石校验） */
  async sendSystem(conversationId: string, body: string): Promise<Message> {
    const turn = await this.ensureActiveTurn(conversationId);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const sequenceNum = (await this._repo.getMaxSequenceNum(conversationId)) + 1;

    const message: Message = {
      id,
      conversationId,
      turnId: turn.id,
      senderType: "system",
      senderId: "system",
      talkingStonePassedTo: [],
      status: "completed",
      segments: [],
      sequenceNum,
      contextTokens: null,
      contextTokensMax: null,
      source: null, // 系统消息不需要标记来源
      createdAt: now,
      completedAt: now,
    };

    await this._repo.createCompletedMessage(message);
    const seg = await this._repo.appendSegment(message.id, body);
    message.segments = [seg];
    return message;
  }

  /** 更新消息的 token 使用量（agent invoke 完成后补充写入） */
  async updateTokenUsage(messageId: string, contextTokens: number, contextTokensMax: number): Promise<void> {
    await this._repo.updateTokenUsage(messageId, contextTokens, contextTokensMax);
  }

  /**
   * 解析用户未指定目标时的默认派发对象：
   * 1. 最后发言的 otter（任何状态的消息都算发言，含 failed/aborted），且仍在场、未解散
   * 2. 兜底：在场且未解散的大獭（type=big）
   * 两者都找不到说明对话参与者构成异常，抛出错误而不是退化为全员广播
   *
   * 注意：
   * - 不回溯：最后发言者不可用时直接兜底大獭，不往前找倒数第二位发言者（按需求定义的两级优先级）
   * - participant 的 active 不代表 otter 可派发（DissolveOtter 不会级联标记 participant 退场），
   *   因此两个分支都必须校验 otter 实体状态
   */
  private async resolveDefaultTargets(conversationId: string): Promise<string[]> {
    const participants = await this._repo.getActiveParticipants(conversationId);
    const activeOtterIds = new Set(participants.map((p) => p.otterId));

    const [lastOtterMsg] = await this._repo.getMessages(conversationId, {
      senderType: "otter",
      limit: 1,
    });
    if (lastOtterMsg && activeOtterIds.has(lastOtterMsg.senderId)) {
      const lastSpeaker = await this.otterRepo.getById(lastOtterMsg.senderId);
      if (lastSpeaker?.status === "active") {
        return [lastSpeaker.id];
      }
    }

    for (const p of participants) {
      const otter = await this.otterRepo.getById(p.otterId);
      if (otter?.type === "big" && otter.status === "active") {
        return [otter.id];
      }
    }

    throw new DomainError(
      "Cannot resolve default dispatch target: no last speaker and no big otter among participants",
      "validation",
    );
  }

  /**
   * 解析用户消息的发言石目标（F20260728htar）：
   * - 空目标：按领域规则解析默认派发（resolveDefaultTargets）
   * - 显式目标（@ 提及 / 卡片回执路由到卡片作者）：校验"在场 + otter.status==='active'"
   *   （与 resolveDefaultTargets 同款判据）。全部不合法退默认派发；部分不合法过滤掉。
   *   顺带修复存量洞：用户 @ 此前无校验，会复活已解散的獭。
   *
   * F20260820i333 增强：
   * - 支持从文本解析 @提及（feishu 通道 + 前端未传 target 时的兜底）
   * - 解析失败时返回 feedback 消息（不再静默降级） */
  private async resolveUserTargets(
    conversationId: string,
    explicit: string[],
    body?: string,
  ): Promise<{ targets: string[]; feedback?: string }> {
    /** 有显式目标或无消息体时直接走校验/默认，不查参与者名册 */
    if (explicit.length > 0) {
      const participants = await this._repo.getActiveParticipants(conversationId);
      const participantNames = await this.fetchParticipantNames(participants)
      return this.validateTargets(conversationId, explicit, participants, participantNames)
    }
    /** 空显式时：先检查文本是否含 @，无 @ 则跳过名册查询（避免 N+1） */
    if (!body || !body.includes('@')) {
      return { targets: await this.resolveDefaultTargets(conversationId) }
    }
    const participants = await this._repo.getActiveParticipants(conversationId);
    const participantNames = await this.fetchParticipantNames(participants)
    const { resolvedIds, invalidNames } = parseMentionsFromText(body, participantNames)
    if (resolvedIds.length === 0 && invalidNames.length === 0) {
      return { targets: await this.resolveDefaultTargets(conversationId) }
    }
    if (invalidNames.length > 0) this.logger.info('从文本解析到无效 @提及', { conversationId, invalidNames })
    return this.validateTargets(conversationId, resolvedIds, participants, participantNames)
  }

  /** 获取参与者对应 otter 名字 */
  private async fetchParticipantNames(
    participants: Array<{ otterId: string }> ,
  ): Promise<Array<{ otterId: string; otterName: string }>> {
    const names: Array<{ otterId: string; otterName: string }> = []
    for (const p of participants) {
      const otter = await this.otterRepo.getById(p.otterId)
      if (otter) names.push({ otterId: p.otterId, otterName: otter.name })
    }
    return names
  }

  /** 校验显式目标 + 构建 feedback（F20260820i333） */
  private async validateTargets(
    conversationId: string,
    effectiveExplicit: string[],
    participants: Array<{ otterId: string }>,
    participantNames: Array<{ otterId: string; otterName: string }>,
  ): Promise<{ targets: string[]; feedback?: string }> {
    const participantIds = new Set(participants.map((p) => p.otterId))
    const otterNameMap = new Map<string, string>()
    for (const n of participantNames) otterNameMap.set(n.otterId, n.otterName)
    const valid: string[] = []
    const invalidIds: string[] = []
    for (const id of effectiveExplicit) {
      if (!participantIds.has(id)) { invalidIds.push(id); continue }
      const otter = await this.otterRepo.getById(id)
      if (otter?.status === 'active') valid.push(id)
      else invalidIds.push(id)
    }
    if (valid.length > 0) {
      if (invalidIds.length > 0) {
        this.logger.info('部分显式发言石目标不可用，已过滤', { conversationId, explicitTargets: effectiveExplicit, validTargets: valid })
        return { targets: valid, feedback: `@提及的目标不可用：${invalidIds.map(id => otterNameMap.get(id) ?? id).join('、')}（可能已退场或解散）` }
      }
      return { targets: valid }
    }
    this.logger.warn('显式发言石目标全部不可用，退默认派发', { conversationId, explicitTargets: effectiveExplicit })
    const defaultTargets = await this.resolveDefaultTargets(conversationId)
    const feedback = `@提及的目标不可用：${invalidIds.map(id => otterNameMap.get(id) ?? id).join('、')}（可能已退场或解散），已派给 ${otterNameMap.get(defaultTargets[0]) ?? '大獭'}`
    return { targets: defaultTargets, feedback }
  }

  /** 确保活跃 Turn 存在，无则创建新 Turn */
  private async ensureActiveTurn(conversationId: string) {
    const existing = await this._repo.getActiveTurn(conversationId);
    if (existing) {
      if (canAddMessageToTurn(existing.status)) {
        return existing;
      }
      /** Turn 已关闭，创建新 Turn */
    }

    const turnNumber = (await this._repo.getMaxTurnNumber(conversationId)) + 1;
    const turn = {
      id: crypto.randomUUID(),
      conversationId,
      turnNumber,
      status: "open" as const,
      createdAt: new Date().toISOString(),
      closedAt: null,
    };
    await this._repo.createTurn(turn);
    return turn;
  }

}
