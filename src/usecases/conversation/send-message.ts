import type { Attachment } from "@entities/conversation/conversation";
import { DomainError } from "@entities/errors";
import type {
  Message,
  MessageEvent,
  MessageEventType,
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
import { canAddMessageToTurn } from "@entities/conversation/conversation";
import type { ConversationRepository } from "./conversation-repository";
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
  attachments?: Attachment[];
}

/** Otter 开始流式消息输入 */
export interface StartMessageInput {
  conversationId: string;
  senderId: string;
  talkingStonePassedTo: string[];
  attachments?: Attachment[];
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
  attachments?: Attachment[];
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
    private readonly memoryIndex: MemoryIndexGateway,
    private readonly logger: Logger,
  ) {}

  /** 暴露 repo 给需要读取消息的场景（如发言链的未读消息查询） */
  get repo(): ConversationRepository { return this._repo; }

  /** 用户发送消息（立即 completed） */
  async send(input: SendMessageInput): Promise<Message> {
    const senderType = input.senderType ?? "user";

    /** UA-8: completed 消息必须传递发言石（system 豁免） */
    if (!isValidTalkingStonePass(input.talkingStonePassedTo, "completed", senderType)) {
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
      talkingStonePassedTo: input.talkingStonePassedTo,
      status: "completed",
      body: input.body,
      attachments: input.attachments ?? null,
      sequenceNum,
      contextTokens: null,
      contextTokensMax: null,
      createdAt: now,
      completedAt: now,
    };

    await this._repo.createCompletedMessage(message);

    /** B11: 索引消息内容到记忆系统 */
    await this.memoryIndex.indexMessage(message.id, message.conversationId, input.body);

    /** 尝试关闭 Turn */
    await tryCloseTurn(this.repo, turn.id);

    // 记录消息发送日志
    this.logger.info('Message sent', {
      conversationId: input.conversationId,
      messageId: message.id,
      senderId: input.senderId,
      messageLength: input.body.length,
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
      attachments: input.attachments ?? null,
      sequenceNum,
      contextTokens: null,
      contextTokensMax: null,
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
    const attachments = input?.attachments !== undefined ? input.attachments : message.attachments;
    const now = new Date().toISOString();

    await this._repo.completeMessage({
      messageId, body, talkingStonePassedTo, attachments, completedAt: now,
      contextTokens: input?.contextTokens, contextTokensMax: input?.contextTokensMax,
    });
    await this.memoryIndex.indexMessage(message.id, message.conversationId, body);
    const turnClose = await tryCloseTurn(this.repo, message.turnId);

    return {
      message: { ...message, status: "completed", body, talkingStonePassedTo, attachments, completedAt: now },
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
      throw new Error(`Message not found: ${messageId}`);
    }
    if (!canAbortMessage(message.status)) {
      throw new Error(`Cannot abort message with status: ${message.status}`);
    }
    if (!isValidCompletedMessageBody(input.body)) {
      throw new Error("body must be non-empty string");
    }
    if (!isValidTalkingStonePass(input.talkingStonePassedTo, "aborted", message.senderType)) {
      throw new Error("talkingStonePassedTo must be non-empty for aborted messages");
    }

    const now = new Date().toISOString();
    await this._repo.abortMessage(messageId, input.body, input.talkingStonePassedTo, now);

    /** B-4: 索引消息 body 到记忆系统（中断标记可识别） */
    await this.memoryIndex.indexMessage(message.id, message.conversationId, input.body);

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
      attachments: null,
      sequenceNum,
      contextTokens: null,
      contextTokensMax: null,
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
