import type {
  ArtifactIndex,
  ArtifactStatus,
  LinkedResource,
} from "@entities/conversation/conversation";
import { canTransitionArtifactStatus } from "@entities/conversation/conversation";
import { DomainError } from "@entities/errors";
import type { ConversationRepository } from "./conversation-repository";
import type { MemoryIndexGateway } from "./memory-index-gateway";
import { redactSecrets, redactMetadataSecrets } from "@usecases/security/redact-secrets";

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
      // F20260821scrt: fact 本体表（linked_resources.content）写入前脱敏——记忆索引侧由 StoreMemory 覆盖，本体表此前是明文旁路
      content: input.content ? redactSecrets(input.content) : null,
      category: input.category ?? null,
      userFlagged: false,
      metadata: input.metadata ? redactMetadataSecrets(input.metadata) : null,
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
        throw new DomainError("fact 类型资源必须提供 content", "validation");
      }
      if (input.content.length > FACT_CONTENT_MAX_LENGTH) {
        throw new DomainError(FACT_CONTENT_TOO_LONG_MESSAGE, "validation");
      }
    }
    if (input.resourceType !== "fact" && !input.url) {
      throw new DomainError("非 fact 类型资源必须提供 url", "validation");
    }
  }

  /** 索引内容取自已脱敏的 resource（二轮审视#5：取 raw input 会让 fact 本体与 FTS 一致性依赖 StoreMemory 隐式脱敏） */
  private getIndexContent(resource: LinkedResource): string {
    return resource.resourceType === "fact"
      ? (resource.content ?? "")
      : (resource.url ?? "");
  }

  async linkResource(input: LinkedResourceInput, currentTurnNumber = 0): Promise<LinkedResource> {
    this.validateInput(input);
    const resource = this.buildResource(input, currentTurnNumber);
    await this.repo.linkResource(resource);
    await this.memoryIndex.indexLinkedResource(resource.id, resource.conversationId, this.getIndexContent(resource), resource.resourceType);
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
    if (!existing) throw new DomainError(`LinkedResource ${existingId} not found`, "not_found");
    if (!canTransitionArtifactStatus(existing.status, "superseded")) {
      throw new DomainError(`Cannot supersede resource in status '${existing.status}'`, "conflict");
    }

    const newResource = this.buildResource(newInput, currentTurnNumber, existing.groupId);
    await this.repo.supersedeLinkedResource(existingId, newResource, currentTurnNumber);
    await this.memoryIndex.indexLinkedResource(newResource.id, newResource.conversationId, this.getIndexContent(newResource), newResource.resourceType);
    return newResource;
  }

  /** 归档产物 */
  async archiveResource(id: string, _conversationId: string, currentTurnNumber: number): Promise<void> {
    const resource = await this.repo.getLinkedResourceById(id);
    if (!resource) throw new DomainError(`LinkedResource ${id} not found`, "not_found");
    if (!canTransitionArtifactStatus(resource.status, "archived")) {
      throw new DomainError(`Cannot archive resource in status '${resource.status}'`, "conflict");
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
    if (!resource) throw new DomainError(`LinkedResource ${id} not found`, "not_found");
    if (!canTransitionArtifactStatus(resource.status, status)) {
      throw new DomainError(`Cannot transition resource from '${resource.status}' to '${status}'`, "conflict");
    }
    if (status === "superseded" && !supersededBy) {
      throw new DomainError(`supersededBy is required when transitioning to 'superseded'`, "validation");
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
