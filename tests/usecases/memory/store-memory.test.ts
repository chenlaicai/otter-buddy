import { describe, it, expect } from "vitest";
import { StoreMemory } from "@usecases/memory/store-memory";
import type { MemoryEntryInput } from "@usecases/memory/store-memory";
import type { MemoryWriter } from "@usecases/memory/memory-writer";
import type { MemoryQueue } from "@usecases/memory/memory-queue";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { MemoryEntry } from "@entities/memory/memory-entry";
import { createCapturingLogger, createTestLogger } from "../../helpers/logger";
import { EMBED_TASK_PRIORITY } from "@usecases/memory/memory-queue";

/** 创建带状态捕获的 MemoryWriter + MemoryQueue mock
 *  F20261110dsqci：replaceEntriesBySource 升级为有状态模拟（删旧插新 + 复用集跳过），
 *  findEntriesBySourceAndType 从 storedEntries 过滤返回——支撑 chunk 复用编排验证 */
function statefulRepo(): MemoryWriter & MemoryQueue & {
  storedEntries: MemoryEntry[];
  storedEmbeddings: { id: string; embedding: Float32Array }[];
  enqueuedRetryIds: string[];
  lastReplaceOpts?: { reuseEntryIds?: ReadonlySet<string> };
} {
  const storedEntries: MemoryEntry[] = [];
  const storedEmbeddings: { id: string; embedding: Float32Array }[] = [];
  const enqueuedRetryIds: string[] = [];
  let lastReplaceOpts: { reuseEntryIds?: ReadonlySet<string> } | undefined;
  return {
    storedEntries,
    storedEmbeddings,
    enqueuedRetryIds,
    get lastReplaceOpts() { return lastReplaceOpts; },
    storeEntry: async (entry: MemoryEntry) => {
      storedEntries.push(entry);
    },
    storeEmbedding: async (id: string, embedding: Float32Array) => {
      storedEmbeddings.push({ id, embedding });
    },
    deleteBySource: async () => {},
    replaceEntryBySource: async () => ({ embeddingKept: false }),
    replaceEntriesBySource: async (entries: MemoryEntry[], opts?: { reuseEntryIds?: ReadonlySet<string> }) => {
      lastReplaceOpts = opts;
      const { sourceTable, sourceId, contentType } = entries[0];
      const requestedReuse = opts?.reuseEntryIds ?? new Set<string>();
      const reuse = new Set(storedEntries.filter(e => requestedReuse.has(e.id)).map(e => e.id));
      // 删旧（同 source+type，排除事务内核实后的实际复用集）
      for (let i = storedEntries.length - 1; i >= 0; i--) {
        const e = storedEntries[i];
        if (e.sourceTable === sourceTable && e.sourceId === sourceId && e.contentType === contentType && !reuse.has(e.id)) {
          storedEntries.splice(i, 1);
        }
      }
      for (const e of entries) {
        if (reuse.has(e.id)) {
          const i = storedEntries.findIndex(x => x.id === e.id);
          if (i >= 0) storedEntries[i] = e;
        } else {
          storedEntries.push(e);
        }
      }
      return { reusedEntryIds: reuse };
    },
    deleteBySourceAndType: async () => {},
    // F20261110dsqci：chunk 复用对齐读（从 storedEntries 过滤，支撑二次 sync 复用验证）
    findEntriesBySourceAndType: async (sourceTable: string, sourceId: string, contentType: MemoryEntry["contentType"]) =>
      storedEntries.filter(e => e.sourceTable === sourceTable && e.sourceId === sourceId && e.contentType === contentType),
    incrementRetrievalCounts: async () => {},
    flagMemory: async () => {},
    updateLayerByConversation: async () => {},
    setEmbeddingMeta: async () => {},
    createEdge: async () => "edge-id",
    deleteEdge: async () => {},
    deleteEdgesByEntryIds: async () => {},
    enqueueRetry: async (entryId: string) => {
      enqueuedRetryIds.push(entryId);
    },
    claimPendingTasks: async () => [],
    markTaskDone: async () => {},
    markTaskAttemptFailed: async () => {},
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
  it("存入条目后返回 id（F20260915midu 后 = source_id）", async () => {
    const repo = statefulRepo();
    const embedding: EmbeddingGateway = {
      available: true,
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    };
    const store = new StoreMemory(repo, repo, embedding, createTestLogger());

    const id = await store.execute(SAMPLE_INPUT);

    // F20260915midu（#942）：投影条目主键 = 源实体 ID，消灭双 ID
    expect(id).toBe("msg-001");
    // 条目应已被存入 repo
    expect(repo.storedEntries).toHaveLength(1);
  });

  it("F20260915midu：signals 源豁免统一（INTEGER PK + 1:N upsert 复用，保持随机 UUID）", async () => {
    const repo = statefulRepo();
    const embedding: EmbeddingGateway = {
      available: true,
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    };
    const store = new StoreMemory(repo, repo, embedding, createTestLogger());

    const signalInput: MemoryEntryInput = {
      ...SAMPLE_INPUT,
      contentType: "fact",
      sourceId: "126",
      sourceTable: "signals",
      conversationId: undefined,
    };
    const id1 = await store.execute(signalInput);
    const id2 = await store.execute(signalInput);

    // 保持随机 UUID：同 source_id 的多次投影各自独立（不会主键互撞）
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id2).not.toBe(id1);
  });

  it("存入的条目包含所有正确字段", async () => {
    const repo = statefulRepo();
    const embedding: EmbeddingGateway = {
      available: true,
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    };
    const store = new StoreMemory(repo, repo, embedding, createTestLogger());

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
    const store = new StoreMemory(repo, repo, embedding, createTestLogger());

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
    const store = new StoreMemory(repo, repo, embedding, createTestLogger());

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

    const store = new StoreMemory(repo, repo, embedding, createTestLogger());

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

    const store = new StoreMemory(repo, repo, embedding, createTestLogger());

    // 即使嵌入失败，execute 也应正常返回
    const id = await store.execute(SAMPLE_INPUT);
    expect(id).toBeTruthy();
    expect(repo.storedEntries).toHaveLength(1);
    expect(repo.storedEntries[0].id).toBe(id);
  });
});

describe("StoreMemory - F20260803fbit embedding 截断", () => {
  function capturingEmbedGateway(): EmbeddingGateway & { receivedContents: string[] } {
    const receivedContents: string[] = [];
    return {
      receivedContents,
      available: true,
      embed: async (content: string) => {
        receivedContents.push(content);
        return new Float32Array([0.1, 0.2]);
      },
    };
  }

  it("短文本不截断，embed 收到原文", async () => {
    const repo = statefulRepo();
    const embedding = capturingEmbedGateway();
    const store = new StoreMemory(repo, repo, embedding, createTestLogger());
    const shortContent = "短文本";
    await store.execute({ ...SAMPLE_INPUT, content: shortContent });
    // fire-and-forget，等微任务
    await new Promise(r => setTimeout(r, 10));
    expect(embedding.receivedContents[0]).toBe(shortContent);
  });

  it("超长文本截断到 6000 字符，embed 收到截断版", async () => {
    const repo = statefulRepo();
    const embedding = capturingEmbedGateway();
    const store = new StoreMemory(repo, repo, embedding, createTestLogger());
    const longContent = "x".repeat(10000);
    await store.execute({ ...SAMPLE_INPUT, content: longContent });
    await new Promise(r => setTimeout(r, 10));
    expect(embedding.receivedContents[0].length).toBe(6000);
  });

  it("replaceBySource 路径也截断", async () => {
    const repo = statefulRepo();
    const embedding = capturingEmbedGateway();
    const store = new StoreMemory(repo, repo, embedding, createTestLogger());
    const longContent = "y".repeat(10000);
    await store.replaceBySource({ ...SAMPLE_INPUT, content: longContent });
    await new Promise(r => setTimeout(r, 10));
    expect(embedding.receivedContents[0].length).toBe(6000);
  });

  it("空字符串：#509 防线拦截（原“不截断不抛异常”语义已被污染防线取代）", async () => {
    const repo = statefulRepo();
    const embedding = capturingEmbedGateway();
    const store = new StoreMemory(repo, repo, embedding, createTestLogger());
    // 原断言：空字符串走完 execute 不抛异常（F20260803fbit 截断边界用例）。
    // #509 后：空 content 是污染信号（962c4b80/707ac5c3 实证），execute 入口直接拒绝。
    await expect(store.execute({ ...SAMPLE_INPUT, content: "" })).rejects.toThrow(
      "Refusing to store polluted memory entry",
    );
    expect(embedding.receivedContents).toHaveLength(0);
  });
});

describe("StoreMemory - F20260821scrt secrets 脱敏", () => {
  function capturingEmbedGateway(): EmbeddingGateway & { receivedContents: string[] } {
    const receivedContents: string[] = [];
    return {
      receivedContents,
      available: true,
      embed: async (content: string) => {
        receivedContents.push(content);
        return new Float32Array([0.1, 0.2]);
      },
    };
  }

  it("execute：content 含密钥时入库与 embed 均为脱敏后内容", async () => {
    const repo = statefulRepo();
    const embedding = capturingEmbedGateway();
    const store = new StoreMemory(repo, repo, embedding, createTestLogger());

    await store.execute({
      ...SAMPLE_INPUT,
      content: "用户贴了 OpenAI key：sk-abcdefghij1234567890abcdefghij1234",
    });
    await new Promise(r => setTimeout(r, 10));

    expect(repo.storedEntries[0].content).not.toContain("sk-abcdefghij");
    expect(repo.storedEntries[0].content).toContain("[REDACTED]");
    expect(embedding.receivedContents[0]).not.toContain("sk-abcdefghij");
  });

  it("execute：metadata 字符串值含密钥时同样脱敏", async () => {
    const repo = statefulRepo();
    const embedding = capturingEmbedGateway();
    const store = new StoreMemory(repo, repo, embedding, createTestLogger());

    await store.execute({
      ...SAMPLE_INPUT,
      metadata: { note: "api_key: 0123456789abcdef0123456789abcdef", count: 3 },
    });

    const metadata = repo.storedEntries[0].metadata as Record<string, unknown>;
    expect(String(metadata.note)).not.toContain("0123456789abcdef");
    expect(metadata.count).toBe(3);
  });

  it("replaceBySource：文档 upsert 路径同样脱敏", async () => {
    const repo = statefulRepo();
    const embedding = capturingEmbedGateway();
    const store = new StoreMemory(repo, repo, embedding, createTestLogger());
    const replaceCalls: MemoryEntry[] = [];
    repo.replaceEntryBySource = async (entry: MemoryEntry) => {
      replaceCalls.push(entry);
      return { embeddingKept: false };
    };

    await store.replaceBySource({
      ...SAMPLE_INPUT,
      content: "密码：a1b2c3d4e5f6a7b8c9d0",
    });

    expect(replaceCalls[0].content).not.toContain("a1b2c3d4e5f6a7b8c9d0");
    expect(replaceCalls[0].content).toContain("[REDACTED]");
  });

  it("replaceChunksBySource：chunk 批量路径同样脱敏", async () => {
    const repo = statefulRepo();
    const embedding = capturingEmbedGateway();
    const store = new StoreMemory(repo, repo, embedding, createTestLogger());
    const replaceCalls: MemoryEntry[][] = [];
    repo.replaceEntriesBySource = async (entries: MemoryEntry[]) => {
      replaceCalls.push(entries);
      return { reusedEntryIds: new Set<string>() };
    };

    await store.replaceChunksBySource([
      { ...SAMPLE_INPUT, content: "正常 chunk 内容" },
      { ...SAMPLE_INPUT, content: "xoxb-1fixturefixturefx-fixturefixturefx-fixturefixtur" },
    ]);

    const [first, second] = replaceCalls[0];
    expect(first.content).toBe("正常 chunk 内容");
    expect(second.content).toBe("[REDACTED]");
  });

  it("普通内容完全不变（含引用等值比较）", async () => {
    const repo = statefulRepo();
    const embedding = capturingEmbedGateway();
    const store = new StoreMemory(repo, repo, embedding, createTestLogger());
    const metadata = { key: "value" };

    await store.execute({ ...SAMPLE_INPUT, content: "用户询问了天气情况", metadata });

    expect(repo.storedEntries[0].content).toBe("用户询问了天气情况");
    expect(repo.storedEntries[0].metadata).toBe(metadata);
  });
});

describe("StoreMemory - issue #509 污染防线", () => {
  function capturingEmbedGateway(): EmbeddingGateway & { receivedContents: string[] } {
    const receivedContents: string[] = [];
    return {
      receivedContents,
      available: true,
      embed: async (content: string) => {
        receivedContents.push(content);
        return new Float32Array([0.1, 0.2]);
      },
    };
  }

  const CHUNK_INPUT: MemoryEntryInput = {
    layer: "document",
    contentType: "feature_chunk",
    sourceId: "F20260827xxxx",
    sourceTable: "features",
    granularity: "fine",
    content: "正常 chunk 内容，长度足够",
    metadata: { char_count: 20 },
  };

  it("execute：trim 后空 content 拒绝入库（PollutedContentError）", async () => {
    const repo = statefulRepo();
    const store = new StoreMemory(repo, repo, capturingEmbedGateway(), createTestLogger());

    await expect(
      store.execute({ ...SAMPLE_INPUT, content: "" }),
    ).rejects.toThrow("Refusing to store polluted memory entry");
    expect(repo.storedEntries).toHaveLength(0);
  });

  it("execute：空白/纯换行 content 同样拒绝", async () => {
    const repo = statefulRepo();
    const store = new StoreMemory(repo, repo, capturingEmbedGateway(), createTestLogger());

    await expect(
      store.execute({ ...SAMPLE_INPUT, content: "\n\n  \n" }),
    ).rejects.toThrow("Refusing to store polluted memory entry");
    expect(repo.storedEntries).toHaveLength(0);
  });

  it("execute：短消息（如“继续”）是合法内容，不拦截", async () => {
    const repo = statefulRepo();
    const store = new StoreMemory(repo, repo, capturingEmbedGateway(), createTestLogger());

    await store.execute({ ...SAMPLE_INPUT, content: "继续" });
    expect(repo.storedEntries).toHaveLength(1);
  });

  it("replaceBySource：summary 路径拦截空 content", async () => {
    const repo = statefulRepo();
    const store = new StoreMemory(repo, repo, capturingEmbedGateway(), createTestLogger());

    await expect(
      store.replaceBySource({ ...SAMPLE_INPUT, content: "" }),
    ).rejects.toThrow("Refusing to store polluted memory entry");
  });

  it("replaceChunksBySource：污染 chunk 被过滤，健康 chunk 正常入库", async () => {
    const repo = statefulRepo();
    const store = new StoreMemory(repo, repo, capturingEmbedGateway(), createTestLogger());
    const replaceCalls: MemoryEntry[][] = [];
    repo.replaceEntriesBySource = async (entries: MemoryEntry[]) => {
      replaceCalls.push(entries);
      return { reusedEntryIds: new Set<string>() };
    };

    await store.replaceChunksBySource([
      { ...CHUNK_INPUT, content: "健康的 chunk 内容一" },
      { ...CHUNK_INPUT, content: "." },
      { ...CHUNK_INPUT, content: "健康的 chunk 内容二" },
    ]);

    expect(replaceCalls[0]).toHaveLength(2);
    expect(replaceCalls[0].map(e => e.content)).toEqual(["健康的 chunk 内容一", "健康的 chunk 内容二"]);
  });

  it("replaceChunksBySource：全部污染时返回空数组且不写库", async () => {
    const repo = statefulRepo();
    const store = new StoreMemory(repo, repo, capturingEmbedGateway(), createTestLogger());
    let replaceCalled = false;
    repo.replaceEntriesBySource = async () => {
      replaceCalled = true;
      return { reusedEntryIds: new Set<string>() };
    };

    const ids = await store.replaceChunksBySource([
      { ...CHUNK_INPUT, content: "." },
      { ...CHUNK_INPUT, content: "\n" },
    ]);

    expect(ids).toEqual([]);
    expect(replaceCalled).toBe(false);
  });

  it("replaceChunksBySource：metadata.char_count 与实际 content 严重偏离时告警（不拦截）", async () => {
    const repo = statefulRepo();
    const store = new StoreMemory(repo, repo, capturingEmbedGateway(), createTestLogger());
    const replaceCalls: MemoryEntry[][] = [];
    repo.replaceEntriesBySource = async (entries: MemoryEntry[]) => {
      replaceCalls.push(entries);
      return { reusedEntryIds: new Set<string>() };
    };

    // char_count=933 但 cleaned content 只剩 100 字符（<20% 阈值）——833391fa 型缺陷兜底感知
    await store.replaceChunksBySource([
      { ...CHUNK_INPUT, content: "x".repeat(100), metadata: { char_count: 933 } },
    ]);

    expect(replaceCalls[0]).toHaveLength(1); // 不拦截，只告警
  });

  it("execute：前后包裹空白的合法内容 trim 后判定，正常入库（PR #519 审视补充）", async () => {
    const repo = statefulRepo();
    const store = new StoreMemory(repo, repo, capturingEmbedGateway(), createTestLogger());

    // "  hello  " trim 后 5 字符 > 0，execute 路径只拦「空」——前后空白不构成污染
    const id = await store.execute({ ...SAMPLE_INPUT, content: "  hello  " });
    expect(id).toBeTruthy();
    expect(repo.storedEntries).toHaveLength(1);
    // 入库保留原文（trim 只用于判定，不改写 content）
    expect(repo.storedEntries[0].content).toBe("  hello  ");
  });

  it("replaceChunksBySource：char_count 偏离告警写入日志（PR #519 审视补充）", async () => {
    const repo = statefulRepo();
    const logger = createCapturingLogger();
    const store = new StoreMemory(repo, repo, capturingEmbedGateway(), logger);

    // char_count=933 但 cleaned content 只剩 100 字符（<20% 阈值）——833391fa 型缺陷兜底感知
    await store.replaceChunksBySource([
      { ...CHUNK_INPUT, content: "x".repeat(100), metadata: { char_count: 933 } },
    ]);

    expect(logger.captured.warns.some((m) => m.includes("char_count mismatch") && m.includes("933"))).toBe(true);
  });

  it("replaceChunksBySource：char_count 与 content 匹配时不告警", async () => {
    const repo = statefulRepo();
    const logger = createCapturingLogger();
    const store = new StoreMemory(repo, repo, capturingEmbedGateway(), logger);

    await store.replaceChunksBySource([
      { ...CHUNK_INPUT, content: "x".repeat(100), metadata: { char_count: 100 } },
    ]);

    expect(logger.captured.warns).toHaveLength(0);
  });
});

/** F20260915midu（#942）：投影条目主键 = 源实体 ID（消灭双 ID）的规则锁定。
 *  可统一类（messages/linked_resources/features/research）id = source_id；
 *  豁免类保持随机 UUID：signals（INTEGER PK + 1:N upsert）、chunk（1:N + D3 禁边）。 */
describe("StoreMemory - F20260915midu 投影 ID 统一", () => {
  const gateway: EmbeddingGateway = {
    available: true,
    embed: async () => new Float32Array([0.1, 0.2]),
  };

  it("execute：linked_resources / features / research 源的 id = source_id", async () => {
    for (const [sourceTable, sourceId] of [
      ["linked_resources", "res-uuid-1"],
      ["features", "F20260915midu"],
      ["research", "R20260915test"],
    ] as const) {
      const repo = statefulRepo();
      const store = new StoreMemory(repo, repo, gateway, createTestLogger());
      const id = await store.execute({
        ...SAMPLE_INPUT,
        sourceTable,
        sourceId,
      });
      expect(id).toBe(sourceId);
      expect(repo.storedEntries[0].id).toBe(sourceId);
    }
  });

  it("replaceBySource：文档 summary 投影的 id = source_id", async () => {
    const repo = statefulRepo();
    const store = new StoreMemory(repo, repo, gateway, createTestLogger());
    const id = await store.replaceBySource({
      ...SAMPLE_INPUT,
      contentType: "feature",
      sourceTable: "features",
      sourceId: "F20260915midu",
      conversationId: undefined,
    });
    expect(id).toBe("F20260915midu");
  });

  it("replaceChunksBySource：chunk 保持随机 UUID（1:N 共享 source_id，D3 禁边，不统一）", async () => {
    const repo = statefulRepo();
    const storedChunks: MemoryEntry[] = [];
    repo.replaceEntriesBySource = async (entries: MemoryEntry[]) => {
      storedChunks.push(...entries);
      return { reusedEntryIds: new Set<string>() };
    };
    const store = new StoreMemory(repo, repo, gateway, createTestLogger());
    const ids = await store.replaceChunksBySource([
      { ...SAMPLE_INPUT, contentType: "feature_chunk", sourceTable: "features", sourceId: "F20260915midu", content: "chunk 内容一，长度足够" },
      { ...SAMPLE_INPUT, contentType: "feature_chunk", sourceTable: "features", sourceId: "F20260915midu", content: "chunk 内容二，长度足够" },
    ]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe("F20260915midu");
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-/);
  });
});

describe("StoreMemory - F20261109epqst 后台任务统一落库（RAM 长队退役）", () => {
  const chunkInputs = (n: number): MemoryEntryInput[] =>
    Array.from({ length: n }, (_, i) => ({
      ...SAMPLE_INPUT,
      contentType: "feature_chunk" as const,
      sourceTable: "features",
      sourceId: "F20261109epqst",
      content: `chunk 内容 ${i}，长度足够通过校验`,
    }));

  it("replaceChunksBySource：chunk 全部落库为 bulk 任务（不调 gateway——同步路径不依赖 worker）", async () => {
    const repo = statefulRepo();
    const enqueued: Array<{ id: string; priority?: number }> = [];
    repo.enqueueRetry = async (id: string, _err: unknown, priority?: number) => {
      enqueued.push({ id, priority });
    };
    const embedding: EmbeddingGateway = {
      available: false, // worker 不可用也不影响落库
      embed: async () => {
        throw new Error("should not be called");
      },
      embedBatch: async () => {
        throw new Error("should not be called");
      },
    };
    const store = new StoreMemory(repo, repo, embedding, createTestLogger());

    const ids = await store.replaceChunksBySource(chunkInputs(3));
    await new Promise((r) => setTimeout(r, 0));

    expect(ids).toHaveLength(3);
    // 全部落库、bulk 优先级
    expect(enqueued).toHaveLength(3);
    expect(enqueued.every(e => e.priority === EMBED_TASK_PRIORITY.bulk)).toBe(true);
    // 旧机制退役：不再写 embedding（那是 retry worker 消费者的事）
    expect(repo.storedEmbeddings).toHaveLength(0);
  });

  it("replaceChunksBySource：gateway 完全无 embedBatch/embed 能力时任务照样落库（可用性解耦）", async () => {
    const repo = statefulRepo();
    const enqueued: string[] = [];
    repo.enqueueRetry = async (id: string) => {
      enqueued.push(id);
    };
    const embedding: EmbeddingGateway = {
      available: false,
      embed: async () => {
        throw new Error("unavailable");
      },
    };
    const store = new StoreMemory(repo, repo, embedding, createTestLogger());

    await store.replaceChunksBySource(chunkInputs(4));
    await new Promise((r) => setTimeout(r, 0));

    expect(enqueued).toHaveLength(4);
  });
});


/** F20261110dsqci（#1818）：chunk 内容寻址复用编排验证。
 * 案发：无条件删旧插新 + 全量 enqueueRetry（entry id 每次全新，ON CONFLICT
 * 幂等键形同虚设），归档-复活振荡下每轮全量重灌 ~6200 任务白算。 */
describe("StoreMemory.replaceChunksBySource - F20261110dsqci 内容寻址复用", () => {
  const CHUNK_INPUT = (i: number, content: string, total = 3) => ({
    layer: "document" as const,
    contentType: "feature_chunk" as const,
    sourceId: "F20261110dsqci",
    sourceTable: "features",
    conversationId: undefined,
    granularity: "fine" as const,
    content,
    metadata: { chunk_index: i, chunk_total: total, heading_path: ["正文"], char_count: content.length },
  });

  function makeStore(repo: ReturnType<typeof statefulRepo>) {
    const embedding: EmbeddingGateway = {
      available: true,
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    };
    return new StoreMemory(repo, repo, embedding, createTestLogger());
  }

  it("二次 sync 同输入：全部复用（id 不变），enqueueRetry 零登记（#1818 验证断言）", async () => {
    const repo = statefulRepo();
    const store = makeStore(repo);
    const inputs = [CHUNK_INPUT(0, "第一段内容足够长，用于复用验证"), CHUNK_INPUT(1, "第二段内容足够长，用于复用验证"), CHUNK_INPUT(2, "第三段内容足够长，用于复用验证")];

    const ids1 = await store.replaceChunksBySource(inputs);
    expect(repo.enqueuedRetryIds).toHaveLength(3); // 首次：全部登记

    repo.enqueuedRetryIds.length = 0;
    const ids2 = await store.replaceChunksBySource(inputs);

    expect(ids2).toEqual(ids1); // id 全复用
    expect(repo.enqueuedRetryIds).toHaveLength(0); // 零重灌
    expect(repo.storedEntries).toHaveLength(3); // 无重复
    expect(repo.lastReplaceOpts?.reuseEntryIds?.size).toBe(3);
  });

  it("局部修改：仅变更 chunk 新建+登记，未变 chunk 复用", async () => {
    const repo = statefulRepo();
    const store = makeStore(repo);
    await store.replaceChunksBySource([
      CHUNK_INPUT(0, "第一段内容足够长，保持不变"),
      CHUNK_INPUT(1, "第二段内容足够长，将被改写"),
      CHUNK_INPUT(2, "第三段内容足够长，保持不变"),
    ]);
    repo.enqueuedRetryIds.length = 0;

    const ids2 = await store.replaceChunksBySource([
      CHUNK_INPUT(0, "第一段内容足够长，保持不变"),
      CHUNK_INPUT(1, "第二段内容足够长，已经改写为新年"),
      CHUNK_INPUT(2, "第三段内容足够长，保持不变"),
    ]);

    expect(repo.enqueuedRetryIds).toHaveLength(1); // 只有改写的 chunk 重算
    const reused = repo.storedEntries.filter(e => !repo.enqueuedRetryIds.includes(e.id));
    expect(reused).toHaveLength(2);
    expect(ids2.filter(id => !repo.enqueuedRetryIds.includes(id))).toHaveLength(2);
  });

  it("heading_path 变化：content 相同也不复用（三重判据）", async () => {
    const repo = statefulRepo();
    const store = makeStore(repo);
    await store.replaceChunksBySource([{ ...CHUNK_INPUT(0, "同一段内容但换了章节标题"), metadata: { chunk_index: 0, chunk_total: 1, heading_path: ["旧章节"], char_count: 20 } }]);
    repo.enqueuedRetryIds.length = 0;

    await store.replaceChunksBySource([{ ...CHUNK_INPUT(0, "同一段内容但换了章节标题"), metadata: { chunk_index: 0, chunk_total: 1, heading_path: ["新章节"], char_count: 20 } }]);

    expect(repo.enqueuedRetryIds).toHaveLength(1); // heading 变了 → 不复用
  });

  it("同文档内重复段落：两个相同 content 各自复用旧 id，第二/三轮均零登记", async () => {
    const repo = statefulRepo();
    const store = makeStore(repo);
    const dup = "重复段落内容足够长，出现两次验证consume语义";
    const inputs = [CHUNK_INPUT(0, "开头段落的内容足够长了呀", 3), CHUNK_INPUT(1, dup, 3), CHUNK_INPUT(2, dup, 3)];
    const ids1 = await store.replaceChunksBySource(inputs);
    repo.enqueuedRetryIds.length = 0;

    const ids2 = await store.replaceChunksBySource(inputs);
    const ids3 = await store.replaceChunksBySource(inputs);

    expect(new Set(ids2).size).toBe(3);
    expect(ids2).toEqual(ids1);
    expect(ids3).toEqual(ids1);
    expect(repo.storedEntries).toHaveLength(3);
    expect(repo.enqueuedRetryIds).toHaveLength(0);
  });
});
