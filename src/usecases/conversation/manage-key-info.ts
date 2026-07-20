import type {
  ArtifactIndex,
  ArtifactStatus,
  KeyFact,
  LinkedResource,
  KeyInfo,
} from "@entities/conversation/conversation";
import { canTransitionArtifactStatus } from "@entities/conversation/conversation";
import type { ConversationRepository } from "./conversation-repository";
import type { MemoryIndexGateway } from "./memory-index-gateway";

export interface KeyFactInput {
  conversationId: string;
  content: string;
  category?: string;
  createdBy: string;
  otterId?: string;
}

export interface LinkedResourceInput {
  conversationId: string;
  resourceType: string;
  url: string;
  title?: string;
  metadata?: Record<string, unknown>;
  linkedBy: string;
  otterId?: string;
  autoLinked: boolean;
  groupId?: string;
}

export class ManageKeyInfo {
  constructor(
    private readonly repo: ConversationRepository,
    private readonly memoryIndex: MemoryIndexGateway,
  ) {}

  async addKeyFact(input: KeyFactInput): Promise<KeyFact> {
    const keyFact: KeyFact = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      content: input.content,
      category: input.category ?? null,
      userFlagged: false,
      createdBy: input.createdBy,
      otterId: input.otterId ?? null,
      createdAt: new Date().toISOString(),
    };

    await this.repo.addKeyFact(keyFact);

    /** B13: 索引关键事实到记忆系统 */
    await this.memoryIndex.indexKeyFact(
      keyFact.id,
      keyFact.conversationId,
      keyFact.content,
    );

    return keyFact;
  }

  async linkResource(input: LinkedResourceInput, currentTurnNumber = 0): Promise<LinkedResource> {
    const resource: LinkedResource = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      resourceType: input.resourceType,
      url: input.url,
      title: input.title ?? null,
      metadata: input.metadata ?? null,
      linkedBy: input.linkedBy,
      otterId: input.otterId ?? null,
      autoLinked: input.autoLinked,
      createdAt: new Date().toISOString(),
      status: "active",
      linkedAtTurnNumber: currentTurnNumber,
      statusChangedAtTurnNumber: currentTurnNumber,
      groupId: input.groupId ?? null,
      supersededBy: null,
    };

    await this.repo.linkResource(resource);

    /** 索引链接资源到记忆系统 */
    await this.memoryIndex.indexLinkedResource(
      resource.id,
      resource.conversationId,
      resource.url,
    );

    return resource;
  }

  /** 替代旧产物：旧→superseded，创建新→active（原子操作） */
  async supersedeResource(
    existingId: string,
    newInput: LinkedResourceInput,
    currentTurnNumber: number,
  ): Promise<LinkedResource> {
    const existing = await this.repo.getLinkedResourceById(existingId);

    if (!existing) {
      throw new Error(`LinkedResource ${existingId} not found`);
    }

    if (!canTransitionArtifactStatus(existing.status, "superseded")) {
      throw new Error(`Cannot supersede resource in status '${existing.status}'`);
    }

    // 构建新资源（继承 groupId）
    const newResource: LinkedResource = {
      id: crypto.randomUUID(),
      conversationId: newInput.conversationId,
      resourceType: newInput.resourceType,
      url: newInput.url,
      title: newInput.title ?? null,
      metadata: newInput.metadata ?? null,
      linkedBy: newInput.linkedBy,
      otterId: newInput.otterId ?? null,
      autoLinked: newInput.autoLinked,
      createdAt: new Date().toISOString(),
      status: "active",
      linkedAtTurnNumber: currentTurnNumber,
      statusChangedAtTurnNumber: currentTurnNumber,
      groupId: newInput.groupId ?? existing.groupId ?? null,
      supersededBy: null,
    };

    // 原子操作：插入新资源 + 标记旧资源为 superseded
    await this.repo.supersedeLinkedResource(existingId, newResource, currentTurnNumber);

    // 索引到记忆系统
    await this.memoryIndex.indexLinkedResource(newResource.id, newResource.conversationId, newResource.url);

    return newResource;
  }

  /** 归档产物 */
  async archiveResource(id: string, _conversationId: string, currentTurnNumber: number): Promise<void> {
    const resource = await this.repo.getLinkedResourceById(id);

    if (!resource) {
      throw new Error(`LinkedResource ${id} not found`);
    }

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

    if (!resource) {
      throw new Error(`LinkedResource ${id} not found`);
    }

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

  async getKeyInfo(conversationId: string): Promise<KeyInfo> {
    const [keyFacts, linkedResources] = await Promise.all([
      this.repo.getKeyFacts(conversationId),
      this.repo.getLinkedResources(conversationId),
    ]);
    return { keyFacts, linkedResources };
  }

  async deleteKeyFact(id: string): Promise<void> {
    await this.repo.deleteKeyFact(id);
  }

  async flagKeyFact(id: string, flagged: boolean): Promise<void> {
    await this.repo.flagKeyFact(id, flagged);
  }

  async deleteLinkedResource(id: string): Promise<void> {
    await this.repo.deleteLinkedResource(id);
  }
}
