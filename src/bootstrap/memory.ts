import type { Logger } from "@usecases/ports/logger";
import type { MemoryIndexGateway } from "@usecases/conversation/memory-index-gateway";
import type { MemoryEntryInput } from "@usecases/memory/store-memory";
import { StoreMemory } from "@usecases/memory/store-memory";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { ChunkData } from "@usecases/conversation/memory-index-gateway";
import { cleanMarkdownForFts } from "@usecases/document/markdown-noise-cleaner";
import { SyncDocuments } from "@usecases/document/sync-documents";
import type { SyncResult } from "@usecases/document/sync-documents";
import { NodeFileSystem } from "@frameworks/file-system/node-file-system";
import { EmbeddingRetryWorker } from "@usecases/memory/embedding-retry-worker";
import type { EmbeddingRetryWorker as EmbeddingRetryWorkerType } from "@usecases/memory/embedding-retry-worker";
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

export function createMemoryIndex(repos: Repositories, embeddingService: EmbeddingGateway, logger: Logger): MemoryIndexGateway {
  return new MemoryIndexAdapter(new StoreMemory(repos.memory, embeddingService, logger));
}

export async function syncDocuments(repos: Repositories, memoryIndex: MemoryIndexGateway, logger: Logger, cwd: string): Promise<SyncResult> {
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

/**
 * F20260812mrcq Part 1：创建并启动 embedding 重试 worker。
 *
 * 启动前做存量迁移：扫描已存在的暗化条目（本 F 上线前累积），
 * 批量 enqueueRetry 入队，让 retry worker tick 后逐步修复。
 *
 * 仅在 vec 路径启用时启动 worker——disableVec 状态下 worker tick 会空转，
 * 浪费 timer。重新启用 vec 后（如配置回退重启）会重新走 bootstrap 启动 worker。
 */
export async function createAndStartRetryWorker(
  repos: Repositories,
  embeddingService: EmbeddingGateway,
  logger: Logger,
): Promise<EmbeddingRetryWorkerType | null> {
  // vec 未启用：不启动 worker（tick 会空转）
  if (!repos.memory.isVecEnabled()) {
    logger.info("EmbeddingRetryWorker not started: vec path disabled");
    return null;
  }

  // F20260812mrcq Part 1 审视 M8：存量暗化条目迁移
  // 扫描已存在的暗化条目，批量 enqueueRetry 入队
  const existing = await repos.memory.scanDarkEntries(true);  // includeDead=true：之前若曾有 dead 也尝试重新 embed
  if (existing.total > 0) {
    logger.info(`Migrating ${existing.total} existing dark entries to retry queue`);
    for (const entry of existing.entries) {
      await repos.memory.enqueueRetry(entry.entryId, new Error("migrated from existing dark entries"));
    }
  }

  const worker = new EmbeddingRetryWorker(repos.memory, embeddingService, logger);
  worker.start();
  logger.info("EmbeddingRetryWorker started", {
    intervalMs: 30_000,
    migratedExisting: existing.total,
  });
  return worker;
}
