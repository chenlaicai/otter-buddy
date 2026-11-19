import type { Conversation, ConversationParticipant, ConversationKind } from "@entities/conversation/conversation";
import {
  canArchiveConversation,
} from "@entities/conversation/conversation";
import { DomainError } from "@entities/errors";
import type {
  ConversationListResult,
  ConversationRepository,
  ListConversationsFilter,
} from "./conversation-repository";
import type { CreateOtter } from "@usecases/otter/create-otter";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";

export interface CreateConversationInput {
  title: string;
  /** 新建对话时大獭的模型自选（透传给 CreateOtter，缺省 = 默认模型） */
  modelAlias?: string;
  /** 对话类别（assistant = IM 助理自动开户；缺省 normal）。
   * web-assistant = web 浮动獭全局唯一对话（首唤开户，HTTP create 链）；
   * external = 外部接入对话（CoLink 等适配器建立）——该类别下**任何来源**的
   * invoke 都强制 restricts 受限档（见 agent-invoker 演算闸） */
  kind?: ConversationKind;
}

export class ManageConversation {
  constructor(
    private readonly repo: ConversationRepository,
    private readonly createOtter: CreateOtter,
    private readonly workspaceGateway?: WorkspaceGateway,
  ) {}

  async create(params: CreateConversationInput): Promise<Conversation> {
    // 对抗null body 经 safeJsonBody 兜底 {} 后 title 为 undefined，
    // 无校验落库会撞 DB NOT NULL 约束 → 500 且回显表结构（conversations.title）
    if (typeof params.title !== "string" || params.title.trim().length === 0) {
      throw new DomainError("title 必填且为非空字符串", "validation");
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    /** 为每个对话创建独立的大獭 */
    const bigOtter = await this.createOtter.execute({
      name: "大獭",
      type: "big",
      modelAlias: params.modelAlias,
    });
    const otterIds = [bigOtter.id];

    const workspaceDir = this.workspaceGateway ? `workspaces/${id}` : null;

    const conversation: Conversation = {
      id,
      title: params.title,
      status: "active",
      summary: null,
      pinned: false,
      kind: params.kind ?? "normal",
      workspaceDir,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      archivedAt: null,
    };

    /** 单事务：conversations + conversation_otters（修复） */
    await this.repo.create(conversation, otterIds);

    /** 创建对话工作区目录 */
    if (this.workspaceGateway) {
      await this.workspaceGateway.ensureWorkspace(id);
    }

    /** 为每个 otterId 创建 ConversationParticipant 记录
     *  统一 getActiveParticipants() 查询路径
     *  批量创建保证原子性（UA-7：避免参与者记录不完整） */
    const participants: ConversationParticipant[] = otterIds.map((otterId) => ({
      id: crypto.randomUUID(),
      conversationId: id,
      otterId,
      status: "active",
      createdAt: now,
      leftAt: null,
    }));
    await this.repo.createParticipants(participants);

    return conversation;
  }

  async getById(id: string): Promise<Conversation | null> {
    return this.repo.getById(id);
  }

  /**
   * 把存量对话单向升档为 external（外部接入适配器的懒迁移入口）。
   * Why：适配器只在「新建」时声明 kind；上线前已存在的 CoLink 绑定仍是 normal，
   * 搭档从 web 在这些旧外部对话发言时不会获得对话级受限保护。
   * 只允许 normal→external（升档），其他类别 fail-closed 拒绝——降档会静默撤销隔离。
   */
  async promoteToExternal(id: string): Promise<Conversation> {
    const conv = await this.repo.getById(id);
    if (!conv) throw new DomainError(`Conversation not found: ${id}`, "not_found");
    if (conv.kind === "external") return conv;
    if (conv.kind !== "normal") {
      throw new DomainError(`Cannot promote conversation of kind=${conv.kind} to external`, "validation");
    }
    await this.repo.updateKind(id, "external", new Date().toISOString());
    return (await this.repo.getById(id)) ?? { ...conv, kind: "external" };
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

    /** 清理对话工作区目录（removeWorkspace 幂等，目录不存在时无副作用） */
    if (this.workspaceGateway) {
      try {
        await this.workspaceGateway.removeWorkspace(id);
      } catch {
        /** 清理失败不阻断 archive 操作（workspace 目录可手动清理） */
      }
    }
  }

  /** 获取 otter 参与的所有对话 ID（供 ManageSession.archiveSession 使用，修复） */
  async getIdsByOtterId(otterId: string): Promise<string[]> {
    return this.repo.getIdsByOtterId(otterId);
  }

  /** 获取所有对话 ID（分页） */
  async getAllIds(options?: { limit?: number; offset?: number }): Promise<string[]> {
    return this.repo.getAllIds(options);
  }

  /** 批量查询会话列表（含未读计数 + last_message，一条 SQL JOIN 替代 N+1）
   * 返回 { items, total }——total 供前端分组分页页码跳转 */
  async listWithMeta(
    userId: string,
    options?: ListConversationsFilter,
  ): Promise<ConversationListResult> {
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
