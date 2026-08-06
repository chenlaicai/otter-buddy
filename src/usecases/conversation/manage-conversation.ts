import type { Conversation, ConversationParticipant } from "@entities/conversation/conversation";
import {
  canCompleteConversation,
  canArchiveConversation,
} from "@entities/conversation/conversation";
import { DomainError } from "@entities/errors";
import type { ConversationRepository } from "./conversation-repository";
import type { CreateOtter } from "@usecases/otter/create-otter";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";

export interface CreateConversationInput {
  title: string;
}

export class ManageConversation {
  constructor(
    private readonly repo: ConversationRepository,
    private readonly createOtter: CreateOtter,
    private readonly workspaceGateway?: WorkspaceGateway,
  ) {}

  async create(params: CreateConversationInput): Promise<Conversation> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    /** 为每个对话创建独立的大獭 */
    const bigOtter = await this.createOtter.execute({
      name: "大獭",
      type: "big",
    });
    const otterIds = [bigOtter.id];

    const workspaceDir = this.workspaceGateway ? `workspaces/${id}` : null;

    const conversation: Conversation = {
      id,
      title: params.title,
      status: "active",
      summary: null,
      pinned: false,
      workspaceDir,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      archivedAt: null,
    };

    /** 单事务：conversations + conversation_otters（C5 修复） */
    await this.repo.create(conversation, otterIds);

    /** 创建对话工作区目录 */
    if (this.workspaceGateway) {
      await this.workspaceGateway.ensureWorkspace(id);
    }

    /** A6: 为每个 otterId 创建 ConversationParticipant 记录
     *  joinedAtTurnId=null, joinedAtTurnNumber=0 表示对话开始前已在场
     *  统一 getActiveParticipants() 查询路径
     *  批量创建保证原子性（UA-7：避免参与者记录不完整） */
    const participants: ConversationParticipant[] = otterIds.map((otterId) => ({
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
      lastReadTurnNumber: 0,
    }));
    await this.repo.createParticipants(participants);

    return conversation;
  }

  async getById(id: string): Promise<Conversation | null> {
    return this.repo.getById(id);
  }

  async complete(id: string): Promise<void> {
    const conv = await this.repo.getById(id);
    if (!conv) {
      throw new DomainError(`Conversation not found: ${id}`, "not_found");
    }
    if (!canCompleteConversation(conv.status)) {
      throw new DomainError(`Cannot complete conversation with status: ${conv.status}`, "validation");
    }
    await this.repo.updateStatus(id, "completed", new Date().toISOString());
  }

  async archive(id: string): Promise<void> {
    const conv = await this.repo.getById(id);
    if (!conv) {
      throw new DomainError(`Conversation not found: ${id}`, "not_found");
    }
    if (!canArchiveConversation(conv.status)) {
      throw new DomainError(`Cannot archive conversation with status: ${conv.status}`, "validation");
    }
    await this.repo.updateStatus(id, "archived", new Date().toISOString());

    /** 清理对话工作区目录 */
    if (this.workspaceGateway && conv.workspaceDir) {
      try {
        await this.workspaceGateway.removeWorkspace(id);
      } catch {
        /** 清理失败不阻断 archive 操作（workspace 目录可手动清理） */
      }
    }
  }

  /** 获取 otter 参与的所有对话 ID（供 ManageSession.archiveSession 使用，C3 修复） */
  async getIdsByOtterId(otterId: string): Promise<string[]> {
    return this.repo.getIdsByOtterId(otterId);
  }

  /** 获取当前活跃 Turn 的编号（无活跃 Turn 时返回 0） */
  async getActiveTurnNumber(conversationId: string): Promise<number> {
    const turn = await this.repo.getActiveTurn(conversationId);
    return turn?.turnNumber ?? 0;
  }

  /** 获取所有对话 ID（分页） */
  async getAllIds(options?: { limit?: number; offset?: number }): Promise<string[]> {
    return this.repo.getAllIds(options);
  }

  /** 批量查询会话列表（含未读计数 + last_message，一条 SQL JOIN 替代 N+1） */
  async listWithMeta(
    userId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<Array<Conversation & {
    otterIds: string[];
    unreadCount: number;
    lastMessagePreview: string | null;
    lastMessageTs: string | null;
    /** 实时活动状态（派生字段） */
    activityStatus: 'processing' | 'awaiting_user' | 'idle';
  }>> {
    return this.repo.listConversationsWithMeta(userId, options);
  }

  /** 置顶对话（幂等） */
  async pin(id: string): Promise<void> {
    const conv = await this.repo.getById(id);
    if (!conv) {
      throw new DomainError(`Conversation not found: ${id}`, "not_found");
    }
    await this.repo.updatePinned(id, true);
  }

  /** 取消置顶对话（幂等，保护检查在 controller 层） */
  async unpin(id: string): Promise<void> {
    const conv = await this.repo.getById(id);
    if (!conv) {
      throw new DomainError(`Conversation not found: ${id}`, "not_found");
    }
    await this.repo.updatePinned(id, false);
  }

}
