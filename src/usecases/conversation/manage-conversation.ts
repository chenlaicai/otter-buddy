import type { Conversation, ConversationParticipant } from "@entities/conversation/conversation";
import {
  canCompleteConversation,
  canArchiveConversation,
} from "@entities/conversation/conversation";
import type { ConversationRepository } from "./conversation-repository";

export interface CreateConversationInput {
  title: string;
  otterIds?: string[];
}

export class ManageConversation {
  constructor(private readonly repo: ConversationRepository) {}

  async create(params: CreateConversationInput): Promise<Conversation> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const conversation: Conversation = {
      id,
      title: params.title,
      status: "active",
      summary: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      archivedAt: null,
    };

    /** 单事务：conversations + conversation_otters（C5 修复） */
    await this.repo.create(conversation, params.otterIds);

    /** A6: 为每个 otterId 创建 ConversationParticipant 记录
     *  joinedAtTurnId=null, joinedAtTurnNumber=0 表示对话开始前已在场
     *  统一 getActiveParticipants() 查询路径
     *  批量创建保证原子性（UA-7：避免参与者记录不完整） */
    if (params.otterIds && params.otterIds.length > 0) {
      const participants: ConversationParticipant[] = params.otterIds.map((otterId) => ({
        id: crypto.randomUUID(),
        conversationId: id,
        otterId,
        joinedAtTurnId: null,
        joinedAtTurnNumber: 0,
        leftAtTurnId: null,
        leftAtTurnNumber: null,
        status: "active",
        createdAt: now,
        leftAt: null,
      }));
      await this.repo.createParticipants(participants);
    }

    return conversation;
  }

  async getById(id: string): Promise<Conversation | null> {
    return this.repo.getById(id);
  }

  async complete(id: string): Promise<void> {
    const conv = await this.repo.getById(id);
    if (!conv) {
      throw new Error(`Conversation not found: ${id}`);
    }
    if (!canCompleteConversation(conv.status)) {
      throw new Error(`Cannot complete conversation with status: ${conv.status}`);
    }
    await this.repo.updateStatus(id, "completed", new Date().toISOString());
  }

  async archive(id: string): Promise<void> {
    const conv = await this.repo.getById(id);
    if (!conv) {
      throw new Error(`Conversation not found: ${id}`);
    }
    if (!canArchiveConversation(conv.status)) {
      throw new Error(`Cannot archive conversation with status: ${conv.status}`);
    }
    await this.repo.updateStatus(id, "archived", new Date().toISOString());
  }

  /** 获取 otter 参与的所有对话 ID（供 ManageSession.archiveSession 使用，C3 修复） */
  async getIdsByOtterId(otterId: string): Promise<string[]> {
    return this.repo.getIdsByOtterId(otterId);
  }
}
