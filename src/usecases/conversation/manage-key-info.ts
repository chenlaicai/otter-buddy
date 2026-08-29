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

/** F20260829gvid（#580）：强制带 groupId 的资源类型。
 *  这些类型是「一次特性交付」的组成产物（PR/worktree/分支），漏传 groupId 会让
 *  list_artifacts 按组检索落空——gssf/ptun 两次都是检视抓到才补。fact/url/file 可独立
 * 存在（散点事实/外部链接/临时文件），维持可选。 */
export const GROUP_ID_REQUIRED_TYPES = new Set(["pr", "worktree", "branch"]);

export const GROUP_ID_REQUIRED_MESSAGE_PREFIX = "pr/worktree/branch 类型资源必须提供 groupId（特性文档编号，如 F20260829xxxx）";

export function validateGroupIdRequired(resourceType: string, groupId: string | undefined | null): DomainError | null {
  if (!GROUP_ID_REQUIRED_TYPES.has(resourceType)) return null;
  if (groupId && groupId.trim().length > 0) return null;
  return new DomainError(
    `${GROUP_ID_REQUIRED_MESSAGE_PREFIX}。漏传会让 list_artifacts 按组检索落空（gssf/ptun 两次案例，#580）`,
    "validation",
  );
}

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
    // F20260829gvid（#580）：直接创建 pr/worktree/branch 时 groupId 必填。supersede 路径不走
    // 这里（走 supersedeResource，允许继承旧组）——两条路径分开校验。
    const groupIdErr = validateGroupIdRequired(input.resourceType, input.groupId);
    if (groupIdErr) throw groupIdErr;
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

    // F20260829gvid（#580）：supersede 校验 effective groupId（新输入优先，缺省继承旧组）。
    // 「无 groupId 重建 + supersede」是漏传的既定补救路径（ptun 案例实际用过），此处不能一刀切。
    const groupIdErr = validateGroupIdRequired(newInput.resourceType, newInput.groupId ?? existing.groupId);
    if (groupIdErr) throw groupIdErr;

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
