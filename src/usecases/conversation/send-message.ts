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
  isValidCompletedMessageBody,
  isValidTalkingStonePass,
} from "@entities/conversation/message";
import { canAddMessageToTurn } from "@entities/conversation/conversation";
import type { ConversationRepository } from "./conversation-repository";
import { tryCloseTurn } from "./turn-utils";
import type { MemoryIndexGateway } from "./memory-index-gateway";

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

/** 中止消息输入（系统构造的合成中断声明） */
export interface AbortMessageInput {
  body: string;
  talkingStonePassedTo: string[];
}

export class SendMessage {
  constructor(
    private readonly repo: ConversationRepository,
    private readonly memoryIndex: MemoryIndexGateway,
  ) {}

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
    const sequenceNum = (await this.repo.getMaxSequenceNum(input.conversationId)) + 1;

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

    await this.repo.createCompletedMessage(message);

    /** B11: 索引消息内容到记忆系统 */
    await this.memoryIndex.indexMessage(message.id, message.conversationId, input.body);

    /** 尝试关闭 Turn */
    await tryCloseTurn(this.repo, turn.id);

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
    const sequenceNum = (await this.repo.getMaxSequenceNum(input.conversationId)) + 1;

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

    await this.repo.createStreamingMessage(message);
    return message;
  }

  /** 追加流式事件（仅 streaming 状态可追加） */
  async appendEvent(input: MessageEventInput): Promise<MessageEvent> {
    const message = await this.repo.getMessageById(input.messageId);
    if (!message) {
      throw new DomainError(`Message not found: ${input.messageId}`, "not_found");
    }
    if (!canAppendEvent(message.status)) {
      throw new DomainError(`Cannot append event to message with status: ${message.status}`, "validation");
    }

    const id = crypto.randomUUID();
    const sequenceNum = (await this.repo.getMaxEventSequenceNum(input.messageId)) + 1;
    const event: MessageEvent = {
      id,
      messageId: input.messageId,
      eventType: input.eventType,
      payload: input.payload,
      sequenceNum,
      createdAt: new Date().toISOString(),
    };

    await this.repo.appendEvent(event);
    return event;
  }

  /** 完成流式消息（body 必须非空，talkingStonePassedTo 必须非空 UA-8） */
  async complete(messageId: string, input: CompleteMessageInput): Promise<Message> {
    const message = await this.repo.getMessageById(messageId);
    if (!message) {
      throw new DomainError(`Message not found: ${messageId}`, "not_found");
    }
    if (!canCompleteMessage(message.status)) {
      throw new DomainError(`Cannot complete message with status: ${message.status}`, "validation");
    }
    if (!isValidCompletedMessageBody(input.body)) {
      throw new DomainError("body must be non-empty string", "validation");
    }
    /** UA-8: completed 时必须传递发言石（system 豁免） */
    if (!isValidTalkingStonePass(input.talkingStonePassedTo, "completed", message.senderType)) {
      throw new DomainError("talkingStonePassedTo must be non-empty for completed messages", "validation");
    }

    /** attachments 缺省时保留 startMessage 时的值 */
    const attachments = input.attachments !== undefined ? input.attachments : message.attachments;
    const now = new Date().toISOString();

    await this.repo.completeMessage({
      messageId,
      body: input.body,
      talkingStonePassedTo: input.talkingStonePassedTo,
      attachments,
      completedAt: now,
      contextTokens: input.contextTokens,
      contextTokensMax: input.contextTokensMax,
    });

    /** B12: 索引消息 body 到记忆系统 */
    await this.memoryIndex.indexMessage(message.id, message.conversationId, input.body);

    /** 尝试关闭 Turn */
    await tryCloseTurn(this.repo, message.turnId);

    return {
      ...message,
      status: "completed",
      body: input.body,
      talkingStonePassedTo: input.talkingStonePassedTo,
      attachments,
      completedAt: now,
    };
  }

  /** 标记消息失败（可选 body 存错误信息） */
  async fail(messageId: string, body?: string): Promise<void> {
    const message = await this.repo.getMessageById(messageId);
    if (!message) {
      throw new DomainError(`Message not found: ${messageId}`, "not_found");
    }
    if (!canFailMessage(message.status)) {
      throw new DomainError(`Cannot fail message with status: ${message.status}`, "validation");
    }

    const now = new Date().toISOString();
    await this.repo.failMessage(messageId, now, body);

    /** 尝试关闭 Turn */
    await tryCloseTurn(this.repo, message.turnId);
  }

  /**
   * 中止流式消息（用户主动中断）。
   * 与 complete() 类似：设置 body、传递发言石、索引记忆、关闭 turn，但状态为 aborted。
   */
  async abort(messageId: string, input: AbortMessageInput): Promise<Message> {
    const message = await this.repo.getMessageById(messageId);
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
    await this.repo.abortMessage(messageId, input.body, input.talkingStonePassedTo, now);

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

  /** 确保活跃 Turn 存在，无则创建新 Turn */
  private async ensureActiveTurn(conversationId: string) {
    const existing = await this.repo.getActiveTurn(conversationId);
    if (existing) {
      if (canAddMessageToTurn(existing.status)) {
        return existing;
      }
      /** Turn 已关闭，创建新 Turn */
    }

    const turnNumber = (await this.repo.getMaxTurnNumber(conversationId)) + 1;
    const turn = {
      id: crypto.randomUUID(),
      conversationId,
      turnNumber,
      status: "open" as const,
      createdAt: new Date().toISOString(),
      closedAt: null,
    };
    await this.repo.createTurn(turn);
    return turn;
  }

}
