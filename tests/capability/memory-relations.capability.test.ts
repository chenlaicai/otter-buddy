/**
 * F20260813mrel 能力测试：记忆关系层端到端。
 *
 * 验证的能力：LLM 能用 link_memory 声明关系，get_related 拼出结构化链。
 * 基础设施层（无 LLM）：真 app + 真 DB，use case 直调验证 edge CRUD + BFS + provenance。
 *
 * 断言为行为不变量（边存在、path 结构正确、provenance 消息返回），不断言 LLM 措辞。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootCapabilityApp, type CapabilityContext } from "./helpers/boot";
import { StoreMemory } from "@usecases/memory/store-memory";
import { createTestLogger } from "../helpers/logger";

describe("记忆关系层：edge CRUD + BFS + provenance（真 app + 真 DB）", () => {
  let ctx: CapabilityContext;
  let storeMemory: StoreMemory;

  beforeAll(async () => {
    ctx = await bootCapabilityApp();
    storeMemory = new StoreMemory(
      ctx.built.repos.memory, ctx.built.embeddingService, createTestLogger(),
    );
  });

  afterAll(() => {
    ctx?.cleanup();
  });

  it("embedding 就绪", () => {
    expect(ctx.built.embeddingService.available).toBe(true);
  });

  it("link_memory 建边 → get_related 返回结构化 path", async () => {
    // conversationId=null 避免 FK 约束（这些条目不需要挂在真实对话上）
    const msgId = await storeMemory.execute({
      layer: "working", contentType: "message",
      sourceId: "cap-msg-1", sourceTable: "messages",
      granularity: "coarse",
      content: "我们讨论了记忆关系层的设计方案",
    });
    const docId = await storeMemory.execute({
      layer: "document", contentType: "feature",
      sourceId: "F20260813cap", sourceTable: "features",
      granularity: "coarse",
      content: "记忆关系层特性文档",
    });

    const edgeId = await ctx.built.usecases.createEdge.execute({
      fromEntryId: msgId, toEntryId: docId, edgeType: "produced", createdBy: "test",
    });
    expect(edgeId).toBeTruthy();

    const related = await ctx.built.usecases.getRelated.execute({
      entryId: msgId, direction: "out",
    });
    expect(related.length).toBeGreaterThanOrEqual(1);

    const hit = related.find(r => r.entry.id === docId);
    expect(hit).toBeDefined();
    expect(hit!.edgeType).toBe("produced");
    expect(hit!.edgeFromEntryId).toBe(msgId);
    expect(hit!.depth).toBe(1);
    expect(hit!.entry.contentType).toBe("feature");
  });

  it("relates-to 自动双向查", async () => {
    const aId = await storeMemory.execute({
      layer: "working", contentType: "message",
      sourceId: "cap-bi-a", sourceTable: "messages",
      granularity: "coarse",
      content: "主题 A",
    });
    const bId = await storeMemory.execute({
      layer: "working", contentType: "message",
      sourceId: "cap-bi-b", sourceTable: "messages",
      granularity: "coarse",
      content: "主题 B（与 A 相关）",
    });

    await ctx.built.usecases.createEdge.execute({
      fromEntryId: aId, toEntryId: bId, edgeType: "relates-to",
    });

    // 从 B 查出边（relates-to 应自动双向）也能看到 A
    const fromB = await ctx.built.usecases.getRelated.execute({
      entryId: bId, edgeTypes: ["relates-to"],
    });
    expect(fromB.find(r => r.entry.id === aId)).toBeDefined();
  });

  it("BFS depth=2 拼出两跳链", async () => {
    const aId = await storeMemory.execute({
      layer: "working", contentType: "message",
      sourceId: "cap-chain-a", sourceTable: "messages",
      granularity: "coarse",
      content: "链起点",
    });
    const bId = await storeMemory.execute({
      layer: "working", contentType: "message",
      sourceId: "cap-chain-b", sourceTable: "messages",
      granularity: "coarse",
      content: "链中间",
    });
    const cId = await storeMemory.execute({
      layer: "working", contentType: "message",
      sourceId: "cap-chain-c", sourceTable: "messages",
      granularity: "coarse",
      content: "链终点",
    });

    await ctx.built.usecases.createEdge.execute({
      fromEntryId: aId, toEntryId: bId, edgeType: "produced",
    });
    await ctx.built.usecases.createEdge.execute({
      fromEntryId: bId, toEntryId: cId, edgeType: "references",
    });

    const chain = await ctx.built.usecases.getRelated.execute({
      entryId: aId, depth: 2, direction: "out",
    });

    const hitC = chain.find(r => r.entry.id === cId);
    expect(hitC).toBeDefined();
    expect(hitC!.depth).toBe(2);
  });

  it("文档 provenance：get_related 返回催生对话的消息", async () => {
    // 创建真实对话（满足 FK 约束）
    const convRes = await ctx.built.app.request("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "provenance-test-conv", title: "provenance-test" }),
    });
    expect(convRes.status).toBe(201);
    const conv = await convRes.json() as { id: string };

    // 写两条消息到该对话
    await storeMemory.execute({
      layer: "working", contentType: "message",
      sourceId: "cap-prov-msg-1", sourceTable: "messages",
      conversationId: conv.id, granularity: "coarse",
      content: "第一条：讨论 provenance 设计",
    });
    await storeMemory.execute({
      layer: "working", contentType: "message",
      sourceId: "cap-prov-msg-2", sourceTable: "messages",
      conversationId: conv.id, granularity: "coarse",
      content: "第二条：决定用 created_in_conversation_id",
    });

    // 写 feature doc + 直接写 features 表行（StoreMemory 只写 memory_entries，还需 features 表行给 provenance 查）
    ctx.built.db.prepare(`
      INSERT INTO features (id, title, summary, change_type, status, tags, modules, causal_links_from, supersedes, file_path, created_in_conversation_id)
      VALUES ('F20260813prov', 'prov test', 'provenance test', 'feature', 'draft', '[]', '[]', '[]', '[]', '/tmp/prov.md', ?)
    `).run(conv.id);

    const docEntryId = await storeMemory.execute({
      layer: "document", contentType: "feature",
      sourceId: "F20260813prov", sourceTable: "features",
      granularity: "coarse",
      content: "provenance 特性文档",
    });

    // 通过 GetDocProvenance 查
    const provenance = await ctx.built.usecases.getDocProvenance.execute(docEntryId);
    expect(provenance.conversationId).toBe(conv.id);
    expect(provenance.messages.length).toBe(2);
    // D8: 不预筛选，两条消息都返回
    expect(provenance.messages.some(m => m.content.includes("第一条"))).toBe(true);
    expect(provenance.messages.some(m => m.content.includes("第二条"))).toBe(true);
  });
});
