import type {
  KeyFact,
  LinkedResource,
  KeyInfo,
} from "@entities/conversation/conversation";
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

  async linkResource(input: LinkedResourceInput): Promise<LinkedResource> {
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

  async deleteLinkedResource(id: string): Promise<void> {
    await this.repo.deleteLinkedResource(id);
  }
}
