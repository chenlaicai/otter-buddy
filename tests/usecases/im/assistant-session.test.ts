import { describe, it, expect, vi } from "vitest";
import { AssistantSessionManager } from "@usecases/im/assistant-session";

/**
 * F20260918imas / F20260920imax：助理会话管理器测试。
 * 副作用断言风格：记录 conversationRepo/memoryIndex/manageSession 收到的调用，
 * 验证自动开户与 8h 静默 session 重启的编排逻辑（不测 DB 真实现）。
 *
 * F20260920imax 语义修订：对话永续（删 72h 软轮换翻篇）——
 * 8h 静默改为 restartSession（换 session 不换对话），收篇摘要保留（交接 + 记忆）。
 */
function makeManager(overrides: { sessionIdleHours?: number; lastEntryAgeHours?: number } = {}) {
  const created: Array<{ id: string; title: string; kind?: string }> = [];
  const entered: Array<{ connectionId: string; conversationId: string }> = [];
  const summaries: Array<{ id: string; summary: string }> = [];
  const digests: Array<{ digestId: string; conversationId: string; digest: string }> = [];
  const restarts: Array<{ otterId: string; summary?: string }> = [];

  const lastEntryAgeHours = overrides.lastEntryAgeHours ?? 0;
  const lastEntryAt = new Date(Date.now() - lastEntryAgeHours * 3600_000).toISOString();

  const deps = {
    manageConnection: {
      getCurrentConversation: vi.fn().mockResolvedValue(null),
      enterConversation: vi.fn(async (connectionId: string, conversationId: string) => {
        entered.push({ connectionId, conversationId });
      }),
    },
    manageConversation: {
      create: vi.fn(async ({ title, kind }: { title: string; kind?: string }) => {
        const conv = { id: `conv-${created.length + 1}`, title, kind };
        created.push(conv);
        return conv;
      }),
    },
    conversationRepo: {
      updateSummary: vi.fn(async (id: string, summary: string) => {
        summaries.push({ id, summary });
      }),
      getById: vi.fn(async (id: string) => ({ id, title: id })),
    },
    entryRepo: {
      // mock 按真实仓库语义实现（entryType 过滤 + sequence DESC）
      getEntries: vi.fn(async (_conversationId: string, options?: { entryType?: string; limit?: number }) => {
        const all = [
          { id: "e-1", entryType: "speak", body: "水獭回复", createdAt: lastEntryAt, sequenceNum: 2 },
          { id: "e-0", entryType: "user", body: "用户提问", createdAt: lastEntryAt, sequenceNum: 1 },
        ];
        return all
          .filter(e => !options?.entryType || e.entryType === options.entryType)
          .slice(0, options?.limit ?? 50);
      }),
    },
    memoryIndex: {
      indexAssistantDigest: vi.fn(async (digestId: string, conversationId: string, digest: string) => {
        digests.push({ digestId, conversationId, digest });
      }),
    },
    manageSession: {
      restartSession: vi.fn(async (otterId: string, summary?: string) => {
        restarts.push({ otterId, summary });
      }),
    },
    getOtterIds: vi.fn(async (conversationId: string) => [`otter-of-${conversationId}`]),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    sessionIdleHours: overrides.sessionIdleHours ?? 8,
  };

  const manager = new AssistantSessionManager(deps as any);
  return { deps, manager, created, entered, summaries, digests, restarts };
}

describe("AssistantSessionManager", () => {
  it("无绑定时自动开户：建助理对话（kind=assistant）并绑定 connection", async () => {
    const ctx = makeManager();
    const result = await ctx.manager.ensureAssistantConversation({
      connectionId: "conn-1",
      channel: "weixin",
      displayName: "a1b2c3",
    });
    expect(ctx.created[0].title).toBe("a1b2c3");
    expect(ctx.created[0].kind).toBe("assistant");
    expect(ctx.entered[0]).toEqual({ connectionId: "conn-1", conversationId: "conv-1" });
    expect(result).toEqual({ id: "conv-1", title: "a1b2c3" });
  });

  it("飞书开户标题带「飞书助理」前缀", async () => {
    const ctx = makeManager();
    await ctx.manager.ensureAssistantConversation({ connectionId: "c", channel: "feishu", displayName: "张三" });
    expect(ctx.created[0].title).toBe("张三");
  });

  it("开户时透传助理线模型（modelAlias → 新建对话参数）", async () => {
    const ctx = makeManager();
    await ctx.manager.ensureAssistantConversation({
      connectionId: "conn-1", channel: "weixin", displayName: "x", modelAlias: "glm",
    });
    // 副作用断言：created 记录表里含模型标记（create 的入参经 mock 落进 created）
    expect(ctx.created[0]).toMatchObject({ title: "x" });
    // 模型透传路径：create 入参含 modelAlias + kind（行为结果）
    expect(ctx.deps.manageConversation.create.mock.calls[0][0]).toMatchObject({ modelAlias: "glm", kind: "assistant" });
  });

  it("已有绑定且未超 8h：直接返回当前对话（永续），不重启 session 不开户", async () => {
    const ctx = makeManager({ lastEntryAgeHours: 1 });
    ctx.deps.manageConnection.getCurrentConversation.mockResolvedValue({ id: "conv-existing", title: "助理线" });
    const result = await ctx.manager.ensureAssistantConversation({ connectionId: "conn-1", channel: "weixin", displayName: "x" });
    expect(result).toEqual({ id: "conv-existing", title: "助理线" });
    expect(ctx.created).toHaveLength(0);
    expect(ctx.restarts).toHaveLength(0);
  });

  it("F20260920imax：last-entry 超过 8h → 先落摘要后重启（对话不动）+ 交接摘要带真实标题", async () => {
    const ctx = makeManager({ lastEntryAgeHours: 10 });
    ctx.deps.manageConnection.getCurrentConversation.mockResolvedValue({ id: "conv-existing", title: "助理线" });
    const result = await ctx.manager.ensureAssistantConversation({ connectionId: "conn-1", channel: "weixin", displayName: "x" });

    // 对话永续：不新建不 complete，返回原对话
    expect(result).toEqual({ id: "conv-existing", title: "助理线" });
    expect(ctx.created).toHaveLength(0);

    // restartSession 收到的摘要带真实标题（检视发现 1：曾发空标题）+ 内容完整
    expect(ctx.restarts).toHaveLength(1);
    expect(ctx.restarts[0].otterId).toBe("otter-of-conv-existing");
    expect(ctx.restarts[0].summary).toContain("conv-existing");
    expect(ctx.restarts[0].summary).toContain("用户提问");

    // 先落 summary/记忆后重启（检视发现 1/4 处置验证：摘要只构建一次、带真实标题）
    expect(ctx.summaries).toHaveLength(1); // 单次落库（若双 buildDigest 路径会重复写）
    expect(ctx.digests).toHaveLength(1);
    expect(ctx.summaries[0].id).toBe("conv-existing");
    expect(ctx.digests[0]).toMatchObject({ digestId: "digest-conv-existing", conversationId: "conv-existing" });
  });

  it("空对话（无 entry）不触发 session 重启——防异常态误动作", async () => {
    const ctx = makeManager();
    ctx.deps.entryRepo.getEntries.mockResolvedValue([]);
    ctx.deps.manageConnection.getCurrentConversation.mockResolvedValue({ id: "conv-empty", title: "助理线" });
    const result = await ctx.manager.ensureAssistantConversation({ connectionId: "conn-1", channel: "weixin", displayName: "x" });
    expect(result).toEqual({ id: "conv-empty", title: "助理线" });
    expect(ctx.restarts).toHaveLength(0);
  });

  it("session 重启失败不阻塞消息处理（下次消息再试）", async () => {
    const ctx = makeManager({ lastEntryAgeHours: 10 });
    ctx.deps.manageSession.restartSession.mockRejectedValue(new Error("restart boom"));
    ctx.deps.manageConnection.getCurrentConversation.mockResolvedValue({ id: "conv-old", title: "助理线" });
    const result = await ctx.manager.ensureAssistantConversation({ connectionId: "conn-1", channel: "weixin", displayName: "x" });
    // 消息照常进对话（错误已捕获，仅日志）
    expect(result).toEqual({ id: "conv-old", title: "助理线" });
    expect(ctx.deps.logger.error).toHaveBeenCalled();
  });

  it("开户失败（enterConversation 异常）返回 null——调用方回退拒聊", async () => {
    const ctx = makeManager();
    ctx.deps.manageConnection.enterConversation.mockRejectedValue(new Error("already occupied"));
    const result = await ctx.manager.ensureAssistantConversation({ connectionId: "conn-1", channel: "weixin", displayName: "x" });
    expect(result).toBeNull();
  });
});
