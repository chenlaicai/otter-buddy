/**
 * F20260813mren Part 2: 文档 provenance 读取。
 *
 * 给定一个 memory entry id，若它是 feature/research 文档：
 * 1. 查 features/research.created_in_conversation_id（事实级 provenance）
 * 2. 若非空，返回该对话的消息（memory_entries WHERE content_type='message'）
 * 3. 不做"关键消息"预筛选（D8）——返回全部并附带 role/turn 元数据
 *
 * 用于 get_related 工具：遍历关系边后，若 entry 是文档，也返回催生它的对话消息。
 */
import type { MemoryRepository } from "./memory-repository";
import type { FeatureRepository } from "@usecases/document/feature-repository";
import type { ResearchRepository } from "@usecases/document/research-repository";
import type { MemoryEntry } from "@entities/memory/memory-entry";

export interface DocProvenanceResult {
  conversationId: string | null;
  messages: MemoryEntry[];
}

export class GetDocProvenance {
  constructor(
    private readonly memoryRepo: MemoryRepository,
    private readonly featureRepo: FeatureRepository,
    private readonly researchRepo: ResearchRepository,
  ) {}

  async execute(entryId: string): Promise<DocProvenanceResult> {
    const entry = await this.memoryRepo.getById(entryId);
    if (!entry) {
      return { conversationId: null, messages: [] };
    }

    // 只对 feature/research 文档查 provenance
    let conversationId: string | null = null;
    if (entry.contentType === "feature" && entry.sourceTable === "features") {
      conversationId = await this.featureRepo.getCreatedInConversationId(entry.sourceId);
    } else if (entry.contentType === "research" && entry.sourceTable === "research") {
      conversationId = await this.researchRepo.getCreatedInConversationId(entry.sourceId);
    }

    if (!conversationId) {
      return { conversationId: null, messages: [] };
    }

    // D8: 返回该对话全部消息 memory entries（不做"关键消息"预筛选）
    const messages = await this.memoryRepo.getEntriesByConversation(conversationId, {
      contentType: ["message"],
      limit: 50,
    });

    return { conversationId, messages };
  }
}
