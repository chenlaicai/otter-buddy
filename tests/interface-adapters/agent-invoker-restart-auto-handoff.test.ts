/**
 * F20260917rsta：restartWithAutoHandoffIfBlank 单元测试。
 *
 * 语义：手动重启空摘要 → 自动 LLM 交接（四件套 + 合成摘要）；
 * 有摘要直透；失败降级无摘要重启（D9：永不阻塞 restart）。
 *
 * 断言风格：依赖替身用「录制器」收集副作用（restart 收到的 summary、context 写入的
 * key/value），断言录制结果——不绑 mock 调用参数/次数（lint 规则约束）。
 */

import { describe, it, expect, vi } from "vitest";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { SdkInvokePort } from "@usecases/ports/sdk-invoke-port";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { OtterSession } from "@entities/otter/otter-session";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { ManageContext } from "@usecases/otter/manage-context";
import type { HandoffPackage } from "@frameworks/agent/handoff-package-builder";
import { createCapturingLogger } from "../helpers/logger";

const sharedLogger = createCapturingLogger();

function makeSession(overrides: Partial<OtterSession> = {}): OtterSession {
  return {
    id: "sess-new", otterId: "otter-1", status: "active",
    previousSessionId: null, startedAt: "2026-09-17T00:00:00Z",
    archivedAt: null, archiveReason: null, isNegativeCase: false,
    summary: null, modelAlias: null,
    ...overrides,
  };
}

function makeInvoker(opts: {
  conversationIds?: string[];
  restartSession?: ManageSession["restartSession"];
  buildHandoffPkg?: (conversationId: string, otterId: string, options: never) => Promise<HandoffPackage>;
  conversationRepo?: ConversationRepository;
  manageContext?: ManageContext;
}): AgentInvoker {
  const manageSession = {
    getActiveSession: async () => makeSession({ id: "sess-old", summary: "- gen1 sess-0: 初代" }),
    createSession: async (otterId: string) => makeSession({ otterId }),
    restartSession: opts.restartSession ?? (async (otterId: string) => makeSession({ otterId })),
    conversationQuery: { getIdsByOtterId: async () => opts.conversationIds ?? [] },
  } as unknown as ManageSession;

  return new AgentInvoker(
    { invoke: vi.fn(), abort: vi.fn() } as unknown as SdkInvokePort,
    { getMessageById: async () => null, getMessages: async () => [] } as unknown as QueryMessage,
    manageSession,
    { getById: async () => null } as unknown as QueryOtter,
    sharedLogger,
    undefined, // messageBroadcaster
    undefined, // workspaceGateway
    undefined, // settingsRepo
    undefined, // metrics
    undefined, // healingRepo
    opts.conversationRepo,
    undefined, // scheduledTaskRepo
    undefined, // listArtifacts
    opts.manageContext,
    opts.buildHandoffPkg as never,
  );
}

describe("restartWithAutoHandoffIfBlank（F20260917rsta）", () => {
  it("有摘要 → 直透 restartSession，不触发四件套构建", async () => {
    const restarts: Array<{ summary?: string; modelAlias?: string }> = [];
    let pkgBuilt = false;
    const invoker = makeInvoker({
      conversationIds: ["conv-1"],
      restartSession: async (_id, summary, modelAlias) => {
        restarts.push({ summary, modelAlias });
        return makeSession({ summary: summary ?? null });
      },
      buildHandoffPkg: (async () => { pkgBuilt = true; throw new Error("不应被调用"); }) as never,
      conversationRepo: {} as ConversationRepository,
    });

    const session = await invoker.restartWithAutoHandoffIfBlank("otter-1", "我自己写的叙事", "kimi");

    expect(session.id).toBe("sess-new");
    expect(session.summary).toBe("我自己写的叙事");
    expect(pkgBuilt).toBe(false);
  });

  it("空摘要 + 有对话 + 四件套成功 → 用合成摘要重启 + 件②③④写入 context", async () => {
    const restarts: Array<{ summary?: string }> = [];
    const contextWrites = new Map<string, string>();
    const pkg: HandoffPackage = {
      summary: "LLM 合成的交接摘要",
      fileTrail: "files", recencyWindow: "recent", stateInventory: "inventory",
      totalTokenEstimate: 100,
    };
    const invoker = makeInvoker({
      conversationIds: ["conv-1"],
      restartSession: async (_id, summary) => {
        restarts.push({ summary });
        return makeSession({ summary: summary ?? null });
      },
      buildHandoffPkg: (async (_c: string, _o: string, options: { trigger?: string }) => {
        expect(options.trigger).toBe("手动");
        return pkg;
      }) as never,
      conversationRepo: {} as ConversationRepository,
      manageContext: {
        set: async (_id: string, key: string, value: string) => { contextWrites.set(key, value); },
        get: async () => ({}),
        delete: async () => {},
      } as unknown as ManageContext,
    });

    const session = await invoker.restartWithAutoHandoffIfBlank("otter-1", "  ");

    expect(session.id).toBe("sess-new");
    expect(session.summary).toBe("LLM 合成的交接摘要");
    expect(contextWrites.get("handoff_file_trail")).toBe("files");
    expect(contextWrites.get("handoff_recency_window")).toBe("recent");
    expect(contextWrites.get("handoff_state_inventory")).toBe("inventory");
  });

  it("空摘要 + 无对话 → 降级无摘要重启（不阻塞）", async () => {
    let pkgBuilt = false;
    const invoker = makeInvoker({
      conversationIds: [],
      buildHandoffPkg: (async () => { pkgBuilt = true; throw new Error("不应被调用"); }) as never,
      conversationRepo: {} as ConversationRepository,
    });

    const session = await invoker.restartWithAutoHandoffIfBlank("otter-1", undefined);

    expect(session.id).toBe("sess-new");
    expect(session.summary).toBeNull();
    expect(pkgBuilt).toBe(false);
    expect(sharedLogger.captured.warns.some(w => w.includes("No conversation found"))).toBe(true);
  });

  it("空摘要 + 四件套构建抛错 → 降级无摘要重启（D9 永不阻塞）", async () => {
    const invoker = makeInvoker({
      conversationIds: ["conv-1"],
      buildHandoffPkg: (async () => { throw new Error("LLM 合成超时"); }) as never,
      conversationRepo: {} as ConversationRepository,
    });

    const session = await invoker.restartWithAutoHandoffIfBlank("otter-1", "");

    expect(session.id).toBe("sess-new");
    expect(session.summary).toBeNull();
    expect(sharedLogger.captured.warns.some(w => w.includes("Auto handoff failed"))).toBe(true);
  });

  it("空摘要 + 四件套依赖未注入 → 降级无摘要重启", async () => {
    const invoker = makeInvoker({ conversationIds: ["conv-1"] });

    const session = await invoker.restartWithAutoHandoffIfBlank("otter-1", undefined);

    expect(session.id).toBe("sess-new");
    expect(session.summary).toBeNull();
    expect(sharedLogger.captured.warns.some(w => w.includes("Handoff deps not injected"))).toBe(true);
  });

  it("restart 失败 → D8 补偿删除已写入的借用式 context，错误上抛", async () => {
    const deletedKeys: string[] = [];
    const writtenKeys: string[] = [];
    const pkg: HandoffPackage = {
      summary: "s", fileTrail: "f", recencyWindow: "r", stateInventory: "i", totalTokenEstimate: 10,
    };
    const invoker = makeInvoker({
      conversationIds: ["conv-1"],
      restartSession: async () => { throw new Error("DB 锁冲突"); },
      buildHandoffPkg: (async () => pkg) as never,
      conversationRepo: {} as ConversationRepository,
      manageContext: {
        set: async (_id: string, key: string) => { writtenKeys.push(key); },
        get: async () => ({}),
        delete: async (_id: string, key: string) => { deletedKeys.push(key); },
      } as unknown as ManageContext,
    });

    await expect(invoker.restartWithAutoHandoffIfBlank("otter-1", undefined)).rejects.toThrow("DB 锁冲突");
    // 补偿删除覆盖全部已写入的借用式 key
    expect(deletedKeys.sort()).toEqual(writtenKeys.sort());
    expect(deletedKeys.length).toBeGreaterThan(0);
  });
});
