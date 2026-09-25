import { describe, it, expect, vi } from "vitest";
import { AssistantSessionManager } from "@usecases/im/assistant-session";

/**
 * F20260924wast（S1/D1）：maybeRestartIdleSession 公开入口 + 并发防重测试。
 * checkIdleAndRestartSession = HTTP sendMessage 链调用的公开入口（web 助理对话）；
 * restarting 集合防重保证同对话并发触发时只执行一次 restart。
 */
function makeManager(overrides: {
  lastEntryAgeHours?: number;
  restartDelayMs?: number;
} = {}) {
  const restarts: string[] = [];
  const summaries: string[] = [];
  const digests: string[] = [];
  const lastEntryAt = new Date(Date.now() - (overrides.lastEntryAgeHours ?? 0) * 3600_000).toISOString();

  const deps = {
    manageConnection: {
      getCurrentConversation: vi.fn(),
      enterConversation: vi.fn(),
    },
    manageConversation: { create: vi.fn() },
    conversationRepo: {
      updateSummary: vi.fn(async (id: string, summary: string) => { summaries.push(`${id}:${summary}`); }),
      getById: vi.fn(async (id: string) => ({ id, title: id })),
    },
    entryRepo: {
      getEntries: vi.fn(async (_id: string, options?: { entryType?: string; limit?: number }) => {
        const all = [
          { id: "e-1", entryType: "speak", body: "旧回复", createdAt: lastEntryAt, sequenceNum: 2 },
          { id: "e-0", entryType: "user", body: "旧提问", createdAt: lastEntryAt, sequenceNum: 1 },
        ];
        return all
          .filter(e => !options?.entryType || e.entryType === options.entryType)
          .slice(0, options?.limit ?? 50);
      }),
    },
    memoryIndex: { indexAssistantDigest: vi.fn(async (digestId: string) => { digests.push(digestId); }) },
    manageSession: {
      restartSession: vi.fn(async (otterId: string) => {
        restarts.push(otterId);
        if (overrides.restartDelayMs) await new Promise(r => setTimeout(r, overrides.restartDelayMs));
      }),
    },
    getOtterIds: vi.fn(async (conversationId: string) => [`otter-of-${conversationId}`]),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    sessionIdleHours: 8,
  };

  const manager = new AssistantSessionManager(deps as never);
  return { deps, manager, restarts, summaries, digests };
}

describe("checkIdleAndRestartSession（F20260924wast S1 公开入口）", () => {
  it("超 8h 静默 → 触发 restartSession（换 session 不换对话）", async () => {
    const ctx = makeManager({ lastEntryAgeHours: 9 });
    await ctx.manager.checkIdleAndRestartSession("conv-1");

    expect(ctx.restarts).toEqual(["otter-of-conv-1"]);
    // 摘要链路照旧（summary 落库 + 记忆沉淀）
    expect(ctx.summaries[0]).toContain("conv-1");
    expect(ctx.digests).toEqual(["digest-conv-1"]);
  });

  it("静默不足 8h → 不触发", async () => {
    const ctx = makeManager({ lastEntryAgeHours: 1 });
    await ctx.manager.checkIdleAndRestartSession("conv-1");
    expect(ctx.restarts).toHaveLength(0);
  });

  it("并发防重（D1）：同对话并发两次调用只执行一次 restart（首个完成的标记拦截后续）", async () => {
    const ctx = makeManager({ lastEntryAgeHours: 9, restartDelayMs: 50 });
    // 同 tick 并发两调用（双 tab 同 tick 场景）
    await Promise.all([
      ctx.manager.checkIdleAndRestartSession("conv-1"),
      ctx.manager.checkIdleAndRestartSession("conv-1"),
    ]);
    expect(ctx.restarts).toHaveLength(1);

    // 标记清除后：再次超时消息可再次触发（失败重试语义不受影响）
    await ctx.manager.checkIdleAndRestartSession("conv-1");
    expect(ctx.restarts).toHaveLength(2);
  });

  it("不同对话互不影响（防重按 conversationId 隔离）", async () => {
    const ctx = makeManager({ lastEntryAgeHours: 9, restartDelayMs: 30 });
    await Promise.all([
      ctx.manager.checkIdleAndRestartSession("conv-a"),
      ctx.manager.checkIdleAndRestartSession("conv-b"),
    ]);
    expect(ctx.restarts.sort()).toEqual(["otter-of-conv-a", "otter-of-conv-b"]);
  });

  it("restart 失败不抛出（消息继续发送），标记清除后下次可重试", async () => {
    const ctx = makeManager({ lastEntryAgeHours: 9 });
    ctx.deps.manageSession.restartSession.mockRejectedValueOnce(new Error("boom"));
    // 失败被吞（不阻塞 sendMessage 链）
    await expect(ctx.manager.checkIdleAndRestartSession("conv-1")).resolves.toBeUndefined();
    // 标记已清除：下次调用可再触发
    await ctx.manager.checkIdleAndRestartSession("conv-1");
    expect(ctx.restarts).toHaveLength(1); // 第二次成功（mockRejectedValueOnce 只失败一次）
    expect(ctx.deps.logger.error).toHaveBeenCalled();
  });
});
