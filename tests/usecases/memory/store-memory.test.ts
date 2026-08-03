import { describe, it, expect } from "vitest";
import { StoreMemory } from "@usecases/memory/store-memory";
import type { MemoryEntryInput } from "@usecases/memory/store-memory";
import type { MemoryRepository } from "@usecases/memory/memory-repository";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { Logger } from "@usecases/ports/logger";
import type { MemoryEntry } from "@entities/memory/memory-entry";

/** 创建 noop Logger（不记录调用，只提供接口） */
function noopLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => noopLogger(),
  };
}

/** 创建带状态捕获的 MemoryRepository mock */
function statefulRepo(): MemoryRepository & {
  storedEntries: MemoryEntry[];
  storedEmbeddings: { id: string; embedding: Float32Array }[];
} {
  const storedEntries: MemoryEntry[] = [];
  const storedEmbeddings: { id: string; embedding: Float32Array }[] = [];
  return {
    storedEntries,
    storedEmbeddings,
    storeEntry: async (entry: MemoryEntry) => {
      storedEntries.push(entry);
    },
    storeEmbedding: async (id: string, embedding: Float32Array) => {
      storedEmbeddings.push({ id, embedding });
    },
    getById: async () => null,
    getEmbedding: async () => null,
    getWeights: async () => [],
    searchFTS: async () => [],
    searchFTSWithHighlight: async () => [],
    searchVec: async () => [],
    hasVecTable: () => false,
    getDetails: async () => [],
    incrementRetrievalCounts: async () => {},
    flagMemory: async () => {},
    updateLayerByConversation: async () => {},
    deleteBySource: async () => {},
  };
}

/** 测试用输入 */
const SAMPLE_INPUT: MemoryEntryInput = {
  layer: "working",
  contentType: "message",
  sourceId: "msg-001",
  sourceTable: "messages",
  conversationId: "conv-abc",
  granularity: "fine",
  content: "用户询问了天气情况",
  metadata: { key: "value" },
};

describe("StoreMemory.execute()", () => {
  it("存入条目后返回 UUID 格式的 id", async () => {
    const repo = statefulRepo();
    const embedding: EmbeddingGateway = {
      available: true,
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    };
    const store = new StoreMemory(repo, embedding, noopLogger());

    const id = await store.execute(SAMPLE_INPUT);

    // 返回值应为 UUID 格式（8-4-4-4-12）
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // 条目应已被存入 repo
    expect(repo.storedEntries).toHaveLength(1);
  });

  it("存入的条目包含所有正确字段", async () => {
    const repo = statefulRepo();
    const embedding: EmbeddingGateway = {
      available: true,
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    };
    const store = new StoreMemory(repo, embedding, noopLogger());

    const id = await store.execute(SAMPLE_INPUT);

    const entry = repo.storedEntries[0];
    expect(entry.id).toBe(id);
    expect(entry.layer).toBe("working");
    expect(entry.contentType).toBe("message");
    expect(entry.sourceId).toBe("msg-001");
    expect(entry.sourceTable).toBe("messages");
    expect(entry.conversationId).toBe("conv-abc");
    expect(entry.granularity).toBe("fine");
    expect(entry.content).toBe("用户询问了天气情况");
    expect(entry.metadata).toEqual({ key: "value" });
    expect(entry.createdAt).toBeTruthy();
  });

  it("conversationId 缺省时默认为 null", async () => {
    const repo = statefulRepo();
    const embedding: EmbeddingGateway = {
      available: true,
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    };
    const store = new StoreMemory(repo, embedding, noopLogger());

    const inputWithoutConv = { ...SAMPLE_INPUT };
    delete inputWithoutConv.conversationId;

    await store.execute(inputWithoutConv);

    expect(repo.storedEntries[0].conversationId).toBeNull();
  });

  it("metadata 缺省时默认为 null", async () => {
    const repo = statefulRepo();
    const embedding: EmbeddingGateway = {
      available: true,
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    };
    const store = new StoreMemory(repo, embedding, noopLogger());

    const inputWithoutMeta = { ...SAMPLE_INPUT };
    delete inputWithoutMeta.metadata;

    await store.execute(inputWithoutMeta);

    expect(repo.storedEntries[0].metadata).toBeNull();
  });

  it("异步嵌入在 execute 返回后才完成（fire-and-forget）", async () => {
    const repo = statefulRepo();

    /** 模拟嵌入需要一定时间 */
    let embedResolve: (v: Float32Array) => void;
    let embedCalled = false;
    const embedding: EmbeddingGateway = {
      available: true,
      embed: async () => {
        embedCalled = true;
        return new Promise<Float32Array>((resolve) => {
          embedResolve = resolve;
        });
      },
    };

    const store = new StoreMemory(repo, embedding, noopLogger());

    const id = await store.execute(SAMPLE_INPUT);

    // execute 已返回，但嵌入尚未完成
    expect(id).toBeTruthy();
    expect(repo.storedEntries).toHaveLength(1);

    // 嵌入已触发但存储尚未发生
    expect(embedCalled).toBe(true);
    expect(repo.storedEmbeddings).toHaveLength(0);

    // 等待嵌入流程全部完成
    embedResolve!(new Float32Array([0.5]));
    // 给 microtask 队列一个 tick 来完成 storeEmbedding
    await new Promise((r) => setTimeout(r, 10));
    expect(repo.storedEmbeddings).toHaveLength(1);
    expect(repo.storedEmbeddings[0].id).toBe(id);
  });

  it("嵌入失败时不阻塞返回，条目仍然存入", async () => {
    const repo = statefulRepo();
    const embedding: EmbeddingGateway = {
      available: true,
      embed: async () => {
        throw new Error("嵌入服务不可用");
      },
    };

    const store = new StoreMemory(repo, embedding, noopLogger());

    // 即使嵌入失败，execute 也应正常返回
    const id = await store.execute(SAMPLE_INPUT);
    expect(id).toBeTruthy();
    expect(repo.storedEntries).toHaveLength(1);
    expect(repo.storedEntries[0].id).toBe(id);
  });
});
