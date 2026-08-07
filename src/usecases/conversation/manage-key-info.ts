import type {
  ArtifactIndex,
  ArtifactStatus,
  LinkedResource,
} from "@entities/conversation/conversation";
import { canTransitionArtifactStatus } from "@entities/conversation/conversation";
import type { ConversationRepository } from "./conversation-repository";
import type { MemoryIndexGateway } from "./memory-index-gateway";

export interface LinkedResourceInput {
  conversationId: string;
  resourceType: string;
  url?: string;
  title?: string;
  content?: string;
  category?: string;
  metadata?: Record<string, unknown>;
  linkedBy: string;
  otterId?: string;
  autoLinked: boolean;
  groupId?: string;
}

/**
 * F20260807factlim: fact content 长度上限（JS UTF-16 code unit 计：中文 1:1，emoji 1:2）。
 * 工具层（tool-factory）与业务层共用同一常量，保证双层校验口径与消息一致（设计决策 D2）。
 */
export const FACT_CONTENT_MAX_LENGTH = 500;
export const FACT_CONTENT_TOO_LONG_MESSAGE =
  "fact 类型资源的 content 不能超过 500 字符。长内容（方案、设计文档等）请先用 write 工具写入文件，再创建 resourceType='file' 的资源指向文件路径。";

export class ManageKeyInfo {
  constructor(
    private readonly repo: ConversationRepository,
    private readonly memoryIndex: MemoryIndexGateway,
  ) {}

  private buildResource(input: LinkedResourceInput, currentTurnNumber: number, fallbackGroupId?: string | null): LinkedResource {
    return {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      resourceType: input.resourceType,
      url: input.url ?? null,
      title: input.title ?? null,
      content: input.content ?? null,
      category: input.category ?? null,
      userFlagged: false,
      metadata: input.metadata ?? null,
      linkedBy: input.linkedBy,
      otterId: input.otterId ?? null,
      autoLinked: input.autoLinked,
      createdAt: new Date().toISOString(),
      status: "active",
      linkedAtTurnNumber: currentTurnNumber,
      statusChangedAtTurnNumber: currentTurnNumber,
      groupId: input.groupId ?? fallbackGroupId ?? null,
      supersededBy: null,
    };
  }

  private validateInput(input: LinkedResourceInput): void {
    if (input.resourceType === "fact") {
      if (!input.content || input.content.trim().length === 0) {
        throw new Error("fact 类型资源必须提供 content");
      }
      if (input.content.length > FACT_CONTENT_MAX_LENGTH) {
        throw new Error(FACT_CONTENT_TOO_LONG_MESSAGE);
      }
    }
    if (input.resourceType !== "fact" && !input.url) {
      throw new Error("非 fact 类型资源必须提供 url");
    }
  }

  private getIndexContent(input: LinkedResourceInput): string {
    return input.resourceType === "fact"
      ? (input.content ?? "")
      : (input.url ?? "");
  }

  async linkResource(input: LinkedResourceInput, currentTurnNumber = 0): Promise<LinkedResource> {
    this.validateInput(input);
    const resource = this.buildResource(input, currentTurnNumber);
    await this.repo.linkResource(resource);
    await this.memoryIndex.indexLinkedResource(resource.id, resource.conversationId, this.getIndexContent(input), input.resourceType);
    return resource;
  }

  /** 替代旧产物：旧→superseded，创建新→active（原子操作） */
  async supersedeResource(
    existingId: string,
    newInput: LinkedResourceInput,
    currentTurnNumber: number,
  ): Promise<LinkedResource> {
    this.validateInput(newInput);
    const existing = await this.repo.getLinkedResourceById(existingId);
    if (!existing) throw new Error(`LinkedResource ${existingId} not found`);
    if (!canTransitionArtifactStatus(existing.status, "superseded")) {
      throw new Error(`Cannot supersede resource in status '${existing.status}'`);
    }

    const newResource = this.buildResource(newInput, currentTurnNumber, existing.groupId);
    await this.repo.supersedeLinkedResource(existingId, newResource, currentTurnNumber);
    await this.memoryIndex.indexLinkedResource(newResource.id, newResource.conversationId, this.getIndexContent(newInput), newInput.resourceType);
    return newResource;
  }

  /** 归档产物 */
  async archiveResource(id: string, _conversationId: string, currentTurnNumber: number): Promise<void> {
    const resource = await this.repo.getLinkedResourceById(id);
    if (!resource) throw new Error(`LinkedResource ${id} not found`);
    if (!canTransitionArtifactStatus(resource.status, "archived")) {
      throw new Error(`Cannot archive resource in status '${resource.status}'`);
    }
    await this.repo.updateResourceStatus(id, "archived", currentTurnNumber);
  }

  /** 查询链接资源（支持 status/resourceType 过滤） */
  async getLinkedResources(conversationId: string, filters?: { status?: ArtifactStatus; resourceType?: string }): Promise<LinkedResource[]> {
    return this.repo.getLinkedResources(conversationId, filters);
  }

  /** 按 groupId 查询链接资源 */
  async getLinkedResourcesByGroup(conversationId: string, groupId: string): Promise<LinkedResource[]> {
    return this.repo.getLinkedResourcesByGroup(conversationId, groupId);
  }

  /** 更新资源状态（含领域守卫校验） */
  async updateResourceStatus(id: string, status: ArtifactStatus, statusChangedAtTurnNumber: number, supersededBy?: string): Promise<void> {
    const resource = await this.repo.getLinkedResourceById(id);
    if (!resource) throw new Error(`LinkedResource ${id} not found`);
    if (!canTransitionArtifactStatus(resource.status, status)) {
      throw new Error(`Cannot transition resource from '${resource.status}' to '${status}'`);
    }
    if (status === "superseded" && !supersededBy) {
      throw new Error(`supersededBy is required when transitioning to 'superseded'`);
    }
    await this.repo.updateResourceStatus(id, status, statusChangedAtTurnNumber, supersededBy);
  }

  /** 产物总览：按 groupId 分组 */
  async getArtifactIndex(conversationId: string): Promise<ArtifactIndex> {
    const resources = await this.repo.getLinkedResources(conversationId);
    const ungrouped: LinkedResource[] = [];
    const groupMap = new Map<string, LinkedResource[]>();

    for (const r of resources) {
      if (r.groupId === null) {
        ungrouped.push(r);
      } else {
        const group = groupMap.get(r.groupId) ?? [];
        group.push(r);
        groupMap.set(r.groupId, group);
      }
    }

    const groups = Array.from(groupMap.entries()).map(([groupId, groupResources]) => ({
      groupId,
      resources: groupResources,
      latestActive: groupResources.filter(r => r.status === "active").at(-1) ?? null,
    }));

    return { ungrouped, groups };
  }

  async deleteLinkedResource(id: string): Promise<void> {
    await this.repo.deleteLinkedResource(id);
  }

  async flagResource(id: string, flagged: boolean): Promise<void> {
    await this.repo.flagResource(id, flagged);
  }
}
