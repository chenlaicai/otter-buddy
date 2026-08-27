import { describe, it, expect } from "vitest";
import { StoreMemory } from "@usecases/memory/store-memory";
import type { MemoryEntryInput } from "@usecases/memory/store-memory";
import type { MemoryWriter } from "@usecases/memory/memory-writer";
import type { MemoryQueue } from "@usecases/memory/memory-queue";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { MemoryEntry } from "@entities/memory/memory-entry";
import { createCapturingLogger, createTestLogger } from "../../helpers/logger";

/** 创建带状态捕获的 MemoryWriter + MemoryQueue mock */
function statefulRepo(): MemoryWriter & MemoryQueue & {
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
    deleteBySource: async () => {},
    replaceEntryBySource: async () => {},
    replaceEntriesBySource: async () => {},
    deleteBySourceAndType: async () => {},
    incrementRetrievalCounts: async () => {},
    flagMemory: async () => {},
    updateLayerByConversation: async () => {},
    setEmbeddingMeta: async () => {},
    createEdge: async () => "edge-id",
    deleteEdge: async () => {},
    deleteEdgesByEntryIds: async () => {},
    enqueueRetry: async () => {},
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
  it("存入条目后返回 UUID 格式的 id", async () => {
    const repo = statefulRepo();
    const embedding: EmbeddingGateway = {
      available: true,
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    };
    const store = new StoreMemory(repo, repo, embedding, createTestLogger());

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
