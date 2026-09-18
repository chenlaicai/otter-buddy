import { describe, it, expect, vi } from "vitest";
import { AssistantSessionManager } from "@usecases/im/assistant-session";

/**
 * F20260918imas：助理会话管理器测试。
 * 副作用断言风格：记录 conversationRepo/memoryIndex 收到的调用，
 * 验证自动开户与软轮换的编排逻辑（不测 DB 真实现）。
 */
function makeManager(overrides: { rotationHours?: number; lastEntryAgeHours?: number } = {}) {
  const created: Array<{ id: string; title: string }> = [];
  const entered: Array<{ connectionId: string; conversationId: string }> = [];
  const summaries: Array<{ id: string; summary: string }> = [];
  const digests: Array<{ digestId: string; conversationId: string; digest: string }> = [];
  const completed: string[] = [];

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
      create: vi.fn(async ({ title }: { title: string }) => {
        const conv = { id: `conv-${created.length + 1}`, title };
        created.push(conv);
        return conv;
      }),
      complete: vi.fn(async (id: string) => {
        completed.push(id);
      }),
    },
    conversationRepo: {
      updateSummary: vi.fn(async (id: string, summary: string) => {
        summaries.push({ id, summary });
      }),
    },
    entryRepo: {
      getEntries: vi.fn().mockResolvedValue([
        { id: "e-1", entryType: "speak", body: "水獭回复", createdAt: lastEntryAt, sequenceNum: 2 },
        { id: "e-0", entryType: "user", body: "用户提问", createdAt: lastEntryAt, sequenceNum: 1 },
      ]),
    },
    memoryIndex: {
      indexAssistantDigest: vi.fn(async (digestId: string, conversationId: string, digest: string) => {
        digests.push({ digestId, conversationId, digest });
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    rotationHours: overrides.rotationHours ?? 72,
  };

  const manager = new AssistantSessionManager(deps as any);
  return { deps, manager, created, entered, summaries, digests, completed };
}

describe("AssistantSessionManager", () => {
  it("无绑定时自动开户：建「微信助理 · <名>」对话并绑定 connection", async () => {
    const ctx = makeManager();
    const result = await ctx.manager.ensureAssistantConversation({
      connectionId: "conn-1",
      channel: "weixin",
      displayName: "a1b2c3",
    });
    expect(ctx.created[0].title).toBe("微信助理 · a1b2c3");
    expect(ctx.entered[0]).toEqual({ connectionId: "conn-1", conversationId: "conv-1" });
    expect(result).toEqual({ id: "conv-1", title: "微信助理 · a1b2c3" });
  });

  it("飞书开户标题带「飞书助理」前缀", async () => {
    const ctx = makeManager();
    await ctx.manager.ensureAssistantConversation({ connectionId: "c", channel: "feishu", displayName: "张三" });
    expect(ctx.created[0].title).toBe("飞书助理 · 张三");
  });

  it("已有绑定且未超阈值：直接返回当前对话，不轮换", async () => {
    const ctx = makeManager({ lastEntryAgeHours: 10 });
    ctx.deps.manageConnection.getCurrentConversation.mockResolvedValue({ id: "conv-existing", title: "微信助理 · x" });
    const result = await ctx.manager.ensureAssistantConversation({ connectionId: "conn-1", channel: "weixin", displayName: "x" });
    expect(result).toEqual({ id: "conv-existing", title: "微信助理 · x" });
    expect(ctx.created).toHaveLength(0);
    expect(ctx.completed).toHaveLength(0);
  });

  it("last-entry 超过阈值：收篇（summary + 记忆）→ 旧对话 complete → 新开户", async () => {
    const ctx = makeManager({ lastEntryAgeHours: 100 });
    ctx.deps.manageConnection.getCurrentConversation
      .mockResolvedValueOnce({ id: "conv-old", title: "微信助理 · x" })
      .mockResolvedValue(null); // 轮换后 provision 内部重读绑定（首次返回旧篇，第二次重读）
    const result = await ctx.manager.ensureAssistantConversation({ connectionId: "conn-1", channel: "weixin", displayName: "x" });

    // 收篇：摘要落库 + 记忆条目（关联旧对话）
    expect(ctx.summaries[0].id).toBe("conv-old");
    expect(ctx.summaries[0].summary).toContain("助理对话收篇");
    expect(ctx.summaries[0].summary).toContain("用户提问");
    expect(ctx.summaries[0].summary).toContain("水獭回复");
    expect(ctx.digests[0]).toMatchObject({ digestId: "digest-conv-old", conversationId: "conv-old" });

    // 翻篇：旧对话 complete + 新开户绑定
    expect(ctx.completed).toEqual(["conv-old"]);
    expect(ctx.entered[0]).toEqual({ connectionId: "conn-1", conversationId: ctx.created[0].id });
    expect(result!.id).toBe(ctx.created[0].id);
  });

  it("空对话（无 entry）不轮换——防「开户即翻篇」循环", async () => {
    const ctx = makeManager();
    ctx.deps.entryRepo.getEntries.mockResolvedValue([]);
    ctx.deps.manageConnection.getCurrentConversation.mockResolvedValue({ id: "conv-empty", title: "微信助理 · x" });
    const result = await ctx.manager.ensureAssistantConversation({ connectionId: "conn-1", channel: "weixin", displayName: "x" });
    expect(result).toEqual({ id: "conv-empty", title: "微信助理 · x" });
    expect(ctx.completed).toHaveLength(0);
    expect(ctx.created).toHaveLength(0);
  });

  it("收篇失败不阻塞翻篇（丢摘要代价 < 丢消息代价）", async () => {
    const ctx = makeManager({ lastEntryAgeHours: 100 });
    ctx.deps.conversationRepo.updateSummary.mockRejectedValue(new Error("db down"));
    ctx.deps.manageConnection.getCurrentConversation
      .mockResolvedValueOnce({ id: "conv-old", title: "微信助理 · x" })
      .mockResolvedValue(null);
    const result = await ctx.manager.ensureAssistantConversation({ connectionId: "conn-1", channel: "weixin", displayName: "x" });
    expect(ctx.completed).toEqual(["conv-old"]);
    expect(result!.id).toBe(ctx.created[0].id);
  });

  it("开户失败（enterConversation 异常）返回 null——调用方回退拒聊", async () => {
    const ctx = makeManager();
    ctx.deps.manageConnection.enterConversation.mockRejectedValue(new Error("already occupied"));
    const result = await ctx.manager.ensureAssistantConversation({ connectionId: "conn-1", channel: "weixin", displayName: "x" });
    expect(result).toBeNull();
  });
});
