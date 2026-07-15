import type { ConversationParticipant } from "@entities/conversation/conversation";
import {
  canJoinConversation,
  canLeaveConversation,
  canAddMessageToTurn,
} from "@entities/conversation/conversation";
import type { Message } from "@entities/conversation/message";
import { isValidTalkingStonePass } from "@entities/conversation/message";
import type { ConversationRepository } from "./conversation-repository";

export class ManageParticipant {
  constructor(private readonly repo: ConversationRepository) {}

  /**
   * Otter 进场：创建参与记录 + 系统消息。
   * 前置条件：当前有活跃 Turn（后进场者必须有 Turn）。
   * 系统消息 body 由调用方传入（A1：ManageParticipant 不依赖 OtterRepository）。
   */
  async join(
    conversationId: string,
    otterId: string,
    systemMessageBody: string,
  ): Promise<{
    participant: ConversationParticipant;
    systemMessage: Message;
  }> {
    /** 1. UA-10: 无已有参与记录才可进场 */
    const existing = await this.repo.getParticipant(conversationId, otterId);
    if (!canJoinConversation(existing)) {
      throw new Error(`Otter ${otterId} already joined conversation ${conversationId}`);
    }

    /** 2. 进场需要活跃 Turn */
    const turn = await this.repo.getActiveTurn(conversationId);
    if (!turn) {
      throw new Error(`No active turn in conversation ${conversationId}`);
    }
    if (!canAddMessageToTurn(turn.status)) {
      throw new Error(`Turn ${turn.id} is not active`);
    }

    const now = new Date().toISOString();

    /** 3. 创建参与记录 */
    const participant: ConversationParticipant = {
      id: crypto.randomUUID(),
      conversationId,
      otterId,
      joinedAtTurnId: turn.id,
      joinedAtTurnNumber: turn.turnNumber,
      leftAtTurnId: null,
      leftAtTurnNumber: null,
      status: "active",
      createdAt: now,
      leftAt: null,
    };
    await this.repo.createParticipant(participant);

    /** 4. 创建系统消息（B18: senderType="system", 豁免发言石校验） */
    if (!isValidTalkingStonePass([], "completed", "system")) {
      throw new Error("System message talking stone validation failed");
    }

    const messageId = crypto.randomUUID();
    const sequenceNum = (await this.repo.getMaxSequenceNum(conversationId)) + 1;
    const systemMessage: Message = {
      id: messageId,
      conversationId,
      turnId: turn.id,
      senderType: "system",
      senderId: otterId,
      talkingStonePassedTo: [],
      status: "completed",
      body: systemMessageBody,
      attachments: null,
      sequenceNum,
      createdAt: now,
      completedAt: now,
    };
    await this.repo.createCompletedMessage(systemMessage);

    /** 5. 尝试关闭 Turn */
    await this.tryCloseTurn(conversationId, turn.id);

    return { participant, systemMessage };
  }

  /**
   * Otter 退场：更新参与记录 + 系统消息。
   * 前置条件：当前有活跃 Turn。
   */
  async leave(
    conversationId: string,
    otterId: string,
    systemMessageBody: string,
  ): Promise<{
    participant: ConversationParticipant;
    systemMessage: Message;
  }> {
    /** 1. 当前状态为 active 才可退场 */
    const participant = await this.repo.getParticipant(conversationId, otterId);
    if (!participant || !canLeaveConversation(participant)) {
      throw new Error(`Otter ${otterId} is not an active participant`);
    }

    /** 2. 退场需要活跃 Turn */
    const turn = await this.repo.getActiveTurn(conversationId);
    if (!turn) {
      throw new Error(`No active turn in conversation ${conversationId}`);
    }
    if (!canAddMessageToTurn(turn.status)) {
      throw new Error(`Turn ${turn.id} is not active`);
    }

    const now = new Date().toISOString();

    /** 3. 更新参与记录（B19: 记录退场 Turn） */
    await this.repo.updateParticipantLeave(
      participant.id,
      turn.id,
      turn.turnNumber,
      now,
    );

    /** 4. 创建系统消息 */
    const messageId = crypto.randomUUID();
    const sequenceNum = (await this.repo.getMaxSequenceNum(conversationId)) + 1;
    const systemMessage: Message = {
      id: messageId,
      conversationId,
      turnId: turn.id,
      senderType: "system",
      senderId: otterId,
      talkingStonePassedTo: [],
      status: "completed",
      body: systemMessageBody,
      attachments: null,
      sequenceNum,
      createdAt: now,
      completedAt: now,
    };
    await this.repo.createCompletedMessage(systemMessage);

    /** 5. 尝试关闭 Turn */
    await this.tryCloseTurn(conversationId, turn.id);

    return {
      participant: {
        ...participant,
        leftAtTurnId: turn.id,
        leftAtTurnNumber: turn.turnNumber,
        status: "left",
        leftAt: now,
      },
      systemMessage,
    };
  }

  /** 获取当前在场的所有 Otter（UA-7） */
  async getActiveParticipants(
    conversationId: string,
  ): Promise<ConversationParticipant[]> {
    return this.repo.getActiveParticipants(conversationId);
  }

  /** 尝试关闭 Turn */
  private async tryCloseTurn(
    conversationId: string,
    turnId: string,
  ): Promise<void> {
    const messages = await this.repo.getMessagesByTurnId(turnId);
    const allTerminal = messages.every((m) => m.status === "completed" || m.status === "failed");
    if (allTerminal) {
      await this.repo.closeTurn(turnId, new Date().toISOString());
    }
  }
}
