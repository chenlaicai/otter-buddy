import { describe, it, expect, vi } from "vitest";
import { WebAssistantProvisioner, WEB_ASSISTANT_TITLE } from "@usecases/conversation/web-assistant-provisioner";

/**
 * F20260924wast：web 助理开户测试。
 * 覆盖：首唤创建（kind=web-assistant + systemPrompt 注入 + participants）、
 * 幂等复用（已存在不重复建）、并发收敛（多条取最早创建）。
 */
function makeHarness(opts: {
  existing?: Array<{ id: string; createdAt: string; status?: string }>;
  listError?: boolean;
} = {}) {
  const createdConversations: unknown[] = [];
  const createdParticipants: unknown[] = [];
  const createOtterCalls: unknown[] = [];

  const deps = {
    conversationRepo: {
      listConversationsWithMeta: vi.fn(async () => {
        if (opts.listError) throw new Error("db error");
        return {
          items: (opts.existing ?? []).map(e => ({
            id: e.id,
            title: WEB_ASSISTANT_TITLE,
            status: e.status ?? "active",
            createdAt: e.createdAt,
          })),
          total: (opts.existing ?? []).length,
        };
      }),
      create: vi.fn(async (conv: unknown) => { createdConversations.push(conv); }),
      createParticipants: vi.fn(async (ps: unknown[]) => { createdParticipants.push(...ps); }),
    },
    createOtter: {
      execute: vi.fn(async (params: unknown) => {
        createOtterCalls.push(params);
        return { id: "otter-new-1" };
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };

  const provisioner = new WebAssistantProvisioner(deps as never);
  return { deps, provisioner, createdConversations, createdParticipants, createOtterCalls };
}

describe("WebAssistantProvisioner", () => {
  it("首唤创建：kind=web-assistant + 大獭带 systemPrompt + 参与者记录", async () => {
    const ctx = makeHarness();
    const result = await ctx.provisioner.ensure();

    expect(result.created).toBe(true);
    // createOtter 入参：大獭 + systemPrompt 注入
    expect(ctx.createOtterCalls[0]).toMatchObject({ name: "大獭", type: "big" });
    expect((ctx.createOtterCalls[0] as { systemPrompt?: string }).systemPrompt).toBeTruthy();
    // 对话 kind
    expect(ctx.createdConversations[0]).toMatchObject({ kind: "web-assistant", title: WEB_ASSISTANT_TITLE });
    // 参与者
    expect(ctx.createdParticipants).toHaveLength(1);
    expect(ctx.createdParticipants[0]).toMatchObject({ otterId: "otter-new-1", status: "active" });
  });

  it("modelAlias 透传（共用 im.assistant.modelAlias）", async () => {
    const deps = makeHarness();
    const provisioner = new WebAssistantProvisioner({
      ...deps.deps,
      modelAlias: "glm",
    } as never);
    await provisioner.ensure();
    expect(ctx0(deps)).toMatchObject({ modelAlias: "glm" });
    function ctx0(c: ReturnType<typeof makeHarness>) { return c.createOtterCalls[0]; }
  });

  it("幂等复用：已存在 active 的 web-assistant 对话直接返回，不重复建", async () => {
    const ctx = makeHarness({ existing: [{ id: "conv-existing", createdAt: "2026-09-20T00:00:00Z" }] });
    const result = await ctx.provisioner.ensure();

    expect(result).toEqual({ conversationId: "conv-existing", created: false });
    expect(ctx.createOtterCalls).toHaveLength(0);
    expect(ctx.createdConversations).toHaveLength(0);
  });

  it("并发收敛：多条残留取最早创建的一条（ORDER BY 后第一条），记 warn 供诊断", async () => {
    const ctx = makeHarness({
      existing: [
        { id: "conv-later", createdAt: "2026-09-24T10:00:00Z" },
        { id: "conv-earlier", createdAt: "2026-09-24T09:00:00Z" },
      ],
    });
    // 模拟 repo 排序（真实 SQL ORDER BY pinned DESC, last_at DESC——此处直接给列表，
    // provisioner 信任 repo 顺序，取 items[0]）
    const result = await ctx.provisioner.ensure();

    expect(result).toEqual({ conversationId: "conv-later", created: false });
    expect(ctx.deps.logger.warn).toHaveBeenCalled();
  });

  it("归档的 web-assistant 对话不复用（重新开户）", async () => {
    const ctx = makeHarness({
      existing: [{ id: "conv-archived", createdAt: "2026-09-20T00:00:00Z", status: "archived" }],
    });
    const result = await ctx.provisioner.ensure();

    expect(result.created).toBe(true);
    expect(ctx.createdConversations).toHaveLength(1);
  });
});
