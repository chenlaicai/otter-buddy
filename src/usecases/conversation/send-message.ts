import { DomainError } from "@entities/errors";
import type {
  Message,
  MessageEvent,
  MessageEventType,
  MessageMetadata,
  MessageSource,
} from "@entities/conversation/message";
import {
  canAppendEvent,
  canCompleteMessage,
  canFailMessage,
  canAbortMessage,
  canStartSpeaking,
  isValidCompletedMessageBody,
  isValidTalkingStonePass,
} from "@entities/conversation/message";
import { stripHtmlCardFences } from "@entities/conversation/message-body-projection";
import { canAddMessageToTurn } from "@entities/conversation/conversation";
import type { ConversationRepository } from "./conversation-repository";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import { tryCloseTurn } from "./turn-utils";
import type { TurnCloseResult } from "./turn-utils";
import type { MemoryIndexGateway } from "./memory-index-gateway";
import type { Logger } from "@usecases/ports/logger";

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
  body: string;
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

  /** 暴露 repo 给需要读取消息的场景（如发言链的未读消息查询） */
  get repo(): ConversationRepository { return this._repo; }

  /** 用户发送消息（立即 completed） */
  async send(input: SendMessageInput): Promise<Message> {
    const senderType = input.senderType ?? "user";
    const source = input.source ?? "web";

    /** 用户消息统一走目标解析：空目标按领域规则解析默认派发；
     *  显式目标（@ / 卡片回执路由）校验"在场 + otter 未解散"，不合法退默认派发（F20260728htar）。
     *  system 消息豁免校验（定时任务链：目标獭解散后任务消息不应被静默改派）。 */
    const talkingStonePassedTo = senderType === "user"
      ? await this.resolveUserTargets(input.conversationId, input.talkingStonePassedTo)
      : input.talkingStonePassedTo;

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
      body: input.body,
      sequenceNum,
      contextTokens: null,
      contextTokensMax: null,
      source,
      metadata: input.metadata ?? null,
      createdAt: now,
      completedAt: now,
    };

    await this._repo.createCompletedMessage(message);

    /** B11: 索引消息内容到记忆系统（html-card 剥离投影，与 FTS 一致） */
    await this.memoryIndex.indexMessage(message.id, message.conversationId, stripHtmlCardFences(input.body));

    /** 尝试关闭 Turn */
    await tryCloseTurn(this.repo, turn.id);

    // 记录消息发送日志
    this.logger.info('Message sent', {
      conversationId: input.conversationId,
      messageId: message.id,
      senderId: input.senderId,
      messageLength: input.body.length,
      source,
      action: 'send',
    });

    return message;
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
      body: null,
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

  /** 开始发言（speak 工具调用）：streaming → speaking，暂存 body + 发言石目标 */
  async startSpeaking(messageId: string, input: StartSpeakingInput): Promise<Message> {
    const message = await this._repo.getMessageById(messageId);
    if (!message) {
      throw new DomainError(`Message not found: ${messageId}`, "not_found");
    }
    if (!canStartSpeaking(message.status)) {
      throw new DomainError(`Cannot start speaking for message with status: ${message.status}`, "validation");
    }
    if (!isValidCompletedMessageBody(input.body)) {
      throw new DomainError("body must be non-empty string", "validation");
    }
    if (!isValidTalkingStonePass(input.talkingStonePassedTo, "speaking", message.senderType)) {
      throw new DomainError("talkingStonePassedTo must be non-empty for speaking messages", "validation");
    }

    await this._repo.startSpeaking(messageId, input.body, input.talkingStonePassedTo);

    return {
      ...message,
      status: "speaking",
      body: input.body,
      talkingStonePassedTo: input.talkingStonePassedTo,
    };
  }

  /** 完成消息：speaking → completed。body/targets 从 DB 读取（由 startSpeaking 暂存）。 */
  async complete(messageId: string, input?: Partial<CompleteMessageInput>): Promise<CompleteResult> {
    const message = await this._repo.getMessageById(messageId);
    if (!message) throw new DomainError(`Message not found: ${messageId}`, "not_found");
    if (!canCompleteMessage(message.status)) {
      throw new DomainError(`Cannot complete message with status: ${message.status}`, "validation");
    }

    const { body, talkingStonePassedTo } = this.resolveCompleteParams(message, input);
    const now = new Date().toISOString();

    await this._repo.completeMessage({
      messageId, body, talkingStonePassedTo, completedAt: now,
      contextTokens: input?.contextTokens, contextTokensMax: input?.contextTokensMax,
    });
    /** 索引记忆用剥离投影（html-card 源码不入索引，与 FTS 一致） */
    await this.memoryIndex.indexMessage(message.id, message.conversationId, stripHtmlCardFences(body));
    const turnClose = await tryCloseTurn(this.repo, message.turnId);

    return {
      message: { ...message, status: "completed", body, talkingStonePassedTo, completedAt: now },
      turnClose,
    };
  }

  /** 解析 complete 参数：从 input 或 DB 中读取 body/targets 并校验 */
  private resolveCompleteParams(
    message: Message,
    input?: Partial<CompleteMessageInput>,
  ): { body: string; talkingStonePassedTo: string[] } {
    const body = input?.body ?? message.body;
    const talkingStonePassedTo = input?.talkingStonePassedTo ?? message.talkingStonePassedTo;
    if (!body || !isValidCompletedMessageBody(body)) {
      throw new DomainError("body must be non-empty string", "validation");
    }
    if (!talkingStonePassedTo || !isValidTalkingStonePass(talkingStonePassedTo, "completed", message.senderType)) {
      throw new DomainError("talkingStonePassedTo must be non-empty for completed messages", "validation");
    }
    return { body, talkingStonePassedTo };
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
    await tryCloseTurn(this.repo, message.turnId);
  }

  /**
   * 中止流式消息（用户主动中断）。
   * 与 complete() 类似：设置 body、传递发言石、索引记忆、关闭 turn，但状态为 aborted。
   */
  async abort(messageId: string, input: AbortMessageInput): Promise<Message> {
    const message = await this._repo.getMessageById(messageId);
    if (!message) {
      throw new DomainError(`Message not found: ${messageId}`, "not_found");
    }
    if (!canAbortMessage(message.status)) {
      throw new DomainError(`Cannot abort message with status: ${message.status}`, "conflict");
    }
    if (!isValidCompletedMessageBody(input.body)) {
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
    await tryCloseTurn(this.repo, message.turnId);

    return {
      ...message,
      status: "aborted",
      body: input.body,
      talkingStonePassedTo: input.talkingStonePassedTo,
      completedAt: now,
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
      body,
      sequenceNum,
      contextTokens: null,
      contextTokensMax: null,
      source: null, // 系统消息不需要标记来源
      createdAt: now,
      completedAt: now,
    };

    await this._repo.createCompletedMessage(message);
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
   */
  private async resolveUserTargets(conversationId: string, explicit: string[]): Promise<string[]> {
    if (explicit.length === 0) {
      return this.resolveDefaultTargets(conversationId);
    }

    const participants = await this._repo.getActiveParticipants(conversationId);
    const activeOtterIds = new Set(participants.map((p) => p.otterId));

    const valid: string[] = [];
    for (const id of explicit) {
      if (!activeOtterIds.has(id)) continue;
      const otter = await this.otterRepo.getById(id);
      if (otter?.status === "active") {
        valid.push(id);
      }
    }

    if (valid.length === 0) {
      this.logger.info('显式发言石目标全部不可用（不在场或已解散），退默认派发', {
        conversationId, explicitTargets: explicit,
      });
      return this.resolveDefaultTargets(conversationId);
    }
    if (valid.length < explicit.length) {
      this.logger.info('部分显式发言石目标不可用（不在场或已解散），已过滤', {
        conversationId, explicitTargets: explicit, validTargets: valid,
      });
    }
    return valid;
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
