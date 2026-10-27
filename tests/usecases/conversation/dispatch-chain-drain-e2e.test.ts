import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { DispatchChainEngine, type InvokeFn } from "@usecases/conversation/dispatch-chain-engine";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import { invokeEpochStorage } from "@frameworks/agent/invoke-epoch";
import { QueryOtter } from "@usecases/otter/query-otter";
import { QueryMessage } from "@usecases/conversation/query-message";
import { SendEntry } from "@usecases/conversation/send-entry";
import { initRepositories } from "../../../src/bootstrap/repositories";
import { SqliteOtterConfigProvider } from "@frameworks/db/otter/sqlite-otter-config-provider";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { AgentRunResult } from "@usecases/ports/sdk-invoke-port";

vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {} }) }));

/** 仅 SDK 模型执行替换为可控实现；锁、队列、链路由、AgentInvoker 与 DB 均走生产代码。 */
describe("F20261027cnsv 原案 e2e：委托 drain 借道持有者原链 S", () => {
  let close: (() => void) | undefined;
  afterEach(() => { close?.(); close = undefined; });

  it("A yield 给 drain 中的 B；B 续轮 speak/yield C，S 继续调度 C，不新建 B delegated invoke", async () => {
    const db = createTestDb();
    const logger = createTestLogger();
    const repos = initRepositories(db, logger);
    const now = new Date().toISOString();
    for (const id of ["a", "b", "c"]) {
      db.prepare("INSERT INTO otters (id, name, type, status, created_at) VALUES (?, ?, 'small', 'active', ?)").run(id, id.toUpperCase(), now);
    }
    db.prepare("INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv', '并发复现', 'active', ?, ?)").run(now, now);
    for (const id of ["a", "b", "c"]) {
      db.prepare("INSERT INTO conversation_participants (id, conversation_id, otter_id, status, created_at) VALUES (?, 'conv', ?, 'active', ?)").run(`p-${id}`, id, now);
    }
    await repos.invoke.createInvoke({
      id: "b-holder", conversationId: "conv", otterId: "b", status: "running",
      triggerEntryId: null, talkingStonePassedTo: null, startedAt: now, endedAt: null,
      toolCallCount: 0, tokenUsageInput: null, tokenUsageOutput: null, ctxWindowUsed: null,
      pid: process.pid, metadata: null,
    });
    const sendEntry = new SendEntry(repos.entry, repos.invoke, repos.otter, repos.conversation, { logger });
    // B 已经 speak/yield 给 A；其原始 prompt 仍在 drain，故行 completed + SDK 活。
    await sendEntry.createSpeakEntry({ conversationId: "conv", otterId: "b", invokeId: "b-holder", body: "B 原任务先交给 A" });
    await sendEntry.createYieldEntry({ conversationId: "conv", otterId: "b", invokeId: "b-holder", yieldTargets: ["a"] });

    const followUpQueue: string[] = [];
    const session = {
      isStreaming: false,
      followUp: async (text: string) => { followUpQueue.push(text); return "queued"; },
      getSessionStats: () => ({ tokens: { input: 0, output: 0 } }),
    } as unknown as AgentSession;
    const factory = new PiSessionFactory({
      db, sessionDir: ":memory:", otterToolClient: {} as never, model: null as never,
      createTools: () => [], otterConfigProvider: new SqliteOtterConfigProvider(db), otterRepo: repos.otter,
      healingRepo: repos.healingEvent,
    }, logger);
    const internals = factory as unknown as {
      poolMeta: Map<string, unknown>;
      pool: { adopt: (id: string, session: AgentSession) => void; stop: () => void };
      _invokeInternal: (id: string, message: string, options?: { currentInvokeId?: string }) => Promise<AgentRunResult>;
    };
    close = () => { internals.pool.stop(); db.close(); };

    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => { releaseDrain = resolve; });
    let markDrainStarted!: () => void;
    const drainStarted = new Promise<void>((resolve) => { markDrainStarted = resolve; });
    internals._invokeInternal = async (id, _message, options) => {
      if (id === "b" && options?.currentInvokeId === "b-holder") {
        Object.defineProperty(session, "isStreaming", { value: true, configurable: true });
        internals.poolMeta.set("b", {
          session, toolContext: { conversationId: "conv" }, register: { currentInvokeId: "b-holder" },
          otterType: "small", epoch: invokeEpochStorage.getStore(),
        });
        internals.pool.adopt("b", session);
        markDrainStarted();
        await drain; // 与真实 session.prompt 相同：覆盖 yield 后的整个 followUp drain。
        return { text: "done" };
      }
      if (id === "a" || id === "c") {
        const invokeId = options?.currentInvokeId;
        if (!invokeId) throw new Error(`${id} invoke id missing`);
        await sendEntry.createSpeakEntry({ conversationId: "conv", otterId: id, invokeId, body: id === "a" ? "A 交给 B" : "C 收到 B 的续轮" });
        await sendEntry.createYieldEntry({ conversationId: "conv", otterId: id, invokeId, yieldTargets: id === "a" ? ["b"] : [] });
        return { text: "done" };
      }
      throw new Error(`unexpected invoke: ${id}`);
    };

    const manageSession = {
      getActiveSession: async () => null,
      createSession: async () => { throw new Error("e2e 不应补建 session"); },
    } as unknown as ManageSession;
    const queryOtter = new QueryOtter(repos.otter);
    const invoker = new AgentInvoker(
      factory, new QueryMessage(repos.conversation, repos.entry), manageSession, queryOtter, logger,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, sendEntry, repos.invoke,
    );
    const engine = new DispatchChainEngine({
      conversationRepo: repos.conversation, queryOtter, logger,
      entryRepo: repos.entry, invokeRepo: repos.invoke,
      isRunning: (id) => factory.isRunning(id),
      followUp: async (id, text, options) => factory.followUp(id, text, {
        delegated: true, reason: "chain", delegatedOptions: { conversationId: options?.conversationId ?? "conv" },
      }),
    });
    // 已运行的 b-holder 是测试接入边界，不能由 AgentInvoker 再建一条 B invoke。
    // 其余 hop 全部经真实 AgentInvoker；S/T 都是真实 executeChain。
    const invokeFn: InvokeFn = async (params) => {
      if (params.otterId === "b") {
        await factory.invoke("b", params.userMessageContent, { conversationId: "conv", currentInvokeId: "b-holder" });
        return { messageId: "b-holder" };
      }
      return invoker.invokeConversation(params);
    };

    const chainS = engine.executeChain({
      conversationId: "conv", userMessageContent: "原案任务", senderId: "user", initialTargets: ["b"], invokeFn,
    });
    await drainStarted;
    const chainT = engine.executeChain({
      conversationId: "conv", userMessageContent: "原案任务", senderId: "user", initialTargets: ["a"], invokeFn,
    });
    await vi.waitFor(() => expect(followUpQueue).toHaveLength(1));
    expect(followUpQueue[0]).toContain("## 链式派工\n");
    expect(factory.isRunning("b")).toBe(true);
    await chainT;
    expect((await repos.invoke.getInvokes("conv", { otterId: "b" })).map((row) => row.id)).toEqual(["b-holder"]);

    // B 在原 holder 内消化 A 委托，最后 yield C；S 必须自行读取并路由 C。
    await sendEntry.createSpeakEntry({ conversationId: "conv", otterId: "b", invokeId: "b-holder", body: "B 消化委托，交给 C" });
    await sendEntry.createYieldEntry({ conversationId: "conv", otterId: "b", invokeId: "b-holder", yieldTargets: ["c"] });
    Object.defineProperty(session, "isStreaming", { value: false, configurable: true });
    releaseDrain();
    await chainS;

    const speaks = (await repos.entry.getEntries("conv", { entryType: "speak" })).map((entry) => entry.body);
    expect(speaks).toEqual(expect.arrayContaining(["B 原任务先交给 A", "A 交给 B", "B 消化委托，交给 C", "C 收到 B 的续轮"]));
    expect((await repos.invoke.getInvokes("conv", { otterId: "b" })).map((row) => row.id)).toEqual(["b-holder"]);
    expect((await repos.invoke.getInvokes("conv", { otterId: "c" }))).toHaveLength(1);
    const systems = (await repos.entry.getEntries("conv", { entryType: "system" })).map((entry) => entry.body ?? "");
    expect(systems.join("\n")).not.toContain("Lock acquire timeout");
    const delegatedHealing = await repos.healingEvent.findByConversation("conv");
    expect(delegatedHealing.map((event) => ({ messageId: event.messageId, reason: event.context?.["reason"] }))).toEqual([{ messageId: "b-holder", reason: "chain-delegated" }]);
  });
});
