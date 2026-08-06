import type { PinoLogger } from "@frameworks/logger";
import type { MemoryIndexGateway } from "@usecases/conversation/memory-index-gateway";
import type { MemoryEntryInput } from "@usecases/memory/store-memory";
import { StoreMemory } from "@usecases/memory/store-memory";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { ChunkData } from "@usecases/conversation/memory-index-gateway";
import { cleanMarkdownForFts } from "@usecases/document/markdown-noise-cleaner";
import { SyncDocuments } from "@usecases/document/sync-documents";
import type { SyncResult } from "@usecases/document/sync-documents";
import { NodeFileSystem } from "@frameworks/file-system/node-file-system";
import type { Repositories } from "./types";

export class MemoryIndexAdapter implements MemoryIndexGateway {
  constructor(private readonly storeMemory: StoreMemory) {}

  async indexMessage(messageId: string, conversationId: string, content: string): Promise<void> {
    await this.storeMemory.execute({
      layer: "working", contentType: "message",
      sourceId: messageId, sourceTable: "messages",
      conversationId, granularity: "fine", content,
    });
  }

  async indexLinkedResource(resourceId: string, conversationId: string, content: string, resourceType?: string): Promise<void> {
    await this.storeMemory.execute({
      layer: "working",
      contentType: resourceType === "fact" ? "fact" : "linked_resource",
      sourceId: resourceId, sourceTable: "linked_resources",
      conversationId, granularity: "coarse", content,
    });
  }

  async indexFeature(id: string, summary: string, metadata: Record<string, unknown>): Promise<void> {
    await this.storeMemory.replaceBySource({
      layer: "document",
      contentType: "feature",
      sourceId: id,
      sourceTable: "features",
      conversationId: undefined,
      granularity: "coarse",
      content: summary,
      metadata,
    });
  }

  async indexResearch(id: string, summary: string, metadata: Record<string, unknown>): Promise<void> {
    await this.storeMemory.replaceBySource({
      layer: "document",
      contentType: "research",
      sourceId: id,
      sourceTable: "research",
      conversationId: undefined,
      granularity: "coarse",
      content: summary,
      metadata,
    });
  }

  async indexFeatureChunks(id: string, chunks: ChunkData[], metadata: Record<string, unknown>): Promise<void> {
    if (chunks.length === 0) {
      await this.storeMemory.deleteChunksBySource("features", id, "feature_chunk");
      return;
    }
    const { title, ...metaRest } = metadata;
    const inputs: MemoryEntryInput[] = chunks.map((c, i) => ({
      layer: "document",
      contentType: "feature_chunk",
      sourceId: id,
      sourceTable: "features",
      conversationId: undefined,
      granularity: "fine",
      content: cleanMarkdownForFts(c.content),
      metadata: {
        ...metaRest,
        doc_title: title,
        part: "chunk",
        chunk_index: i,
        chunk_total: chunks.length,
        heading_path: c.headingPath,
        char_count: c.charCount,
      },
    }));
    await this.storeMemory.replaceChunksBySource(inputs);
  }

  async indexResearchChunks(id: string, chunks: ChunkData[], metadata: Record<string, unknown>): Promise<void> {
    if (chunks.length === 0) {
      await this.storeMemory.deleteChunksBySource("research", id, "research_chunk");
      return;
    }
    const { title, ...metaRest } = metadata;
    const inputs: MemoryEntryInput[] = chunks.map((c, i) => ({
      layer: "document",
      contentType: "research_chunk",
      sourceId: id,
      sourceTable: "research",
      conversationId: undefined,
      granularity: "fine",
      content: cleanMarkdownForFts(c.content),
      metadata: {
        ...metaRest,
        doc_title: title,
        part: "chunk",
        chunk_index: i,
        chunk_total: chunks.length,
        heading_path: c.headingPath,
        char_count: c.charCount,
      },
    }));
    await this.storeMemory.replaceChunksBySource(inputs);
  }
}

export function createMemoryIndex(repos: Repositories, embeddingService: EmbeddingGateway, logger: PinoLogger): MemoryIndexGateway {
  return new MemoryIndexAdapter(new StoreMemory(repos.memory, embeddingService, logger));
}

export async function syncDocuments(repos: Repositories, memoryIndex: MemoryIndexGateway, logger: PinoLogger, cwd: string): Promise<SyncResult> {
  const fileSystem = new NodeFileSystem();
  const syncDocs = new SyncDocuments(
    fileSystem,
    repos.feature,
    repos.research,
    memoryIndex,
    logger,
  );
  return syncDocs.execute(cwd);
}
