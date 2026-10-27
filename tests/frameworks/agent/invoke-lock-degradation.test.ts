import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import { invokeEpochStorage } from "@frameworks/agent/invoke-epoch";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { SqliteOtterConfigProvider } from "@frameworks/db/otter/sqlite-otter-config-provider";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";

vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {} }) }));

type Harness = ReturnType<typeof makeFactory>;
function makeFactory() {
  const db = createTestDb();
  db.prepare("INSERT INTO otters (id, name, type) VALUES ('otter-1', '獭一', 'small')").run();
  db.prepare("INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', '测试', 'active', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
  db.prepare("INSERT INTO invokes (id, conversation_id, otter_id, status, started_at) VALUES ('holder-invoke', 'conv-1', 'otter-1', 'running', ?)").run(new Date().toISOString());
  const session = {
    isStreaming: true,
    followUp: vi.fn(async () => "queued"),
    getSessionStats: () => ({ tokens: { input: 0, output: 0 } }),
  } as unknown as AgentSession;
  const factory = new PiSessionFactory({
    db, sessionDir: ":memory:", otterToolClient: {} as never, model: null as never,
    createTools: () => [], otterConfigProvider: new SqliteOtterConfigProvider(db),
    otterRepo: new SqliteOtterRepository(db),
  }, createTestLogger());
  const meta = {
    session, toolContext: { conversationId: "conv-1" }, register: { currentInvokeId: "holder-invoke" },
    otterType: "small", epoch: { invokeId: "holder-invoke" },
    delegatedFollowUpInFlight: undefined as string | undefined,
  };
  const internals = factory as unknown as {
    poolMeta: Map<string, typeof meta>;
    pool: { adopt: (key: string, session: AgentSession) => void; evict: (key: string) => void; stop: () => void };
    lockManager: {
      acquire: (key: string, timeout?: number, epoch?: object) => Promise<() => void>;
      defaultTimeout: number;
      setHandoffMode: (key: string, value: boolean) => void;
      locks: Map<string, { held: boolean; heldAt: number | null; generation: number; waiters: Array<() => void> }>;
    };
    _invokeInternal: (otterId: string, message: string, options?: unknown) => Promise<{ text: string }>;
  };
  internals.poolMeta.set("otter-1", meta);
  internals.pool.adopt("otter-1", session);
  const healing: Array<Record<string, unknown>> = [];
  (factory as unknown as { cfg: { healingRepo?: { create: (event: Record<string, unknown>) => Promise<void> } } }).cfg.healingRepo = {
    create: async (event) => { healing.push(event); },
  };
  // 只缩短测试等待窗口；真实 invoke → lock timeout → degradation 路径不走 mock。
  internals.lockManager.defaultTimeout = 20;
  const hold = async () => {
    const release = await internals.lockManager.acquire("session:otter-1", undefined, meta.epoch);
    internals.lockManager.locks.get("session:otter-1")!.heldAt = Date.now() - 300_001;
    return release;
  };
  return { db, factory, session, meta, healing, hold, internals };
}

describe("F20261026cnsv D2/D3 reliable delegated followUp", () => {
  let h: Harness;
  beforeEach(() => { h = makeFactory(); });
  afterEach(() => {
    h?.internals.pool.stop();
    h?.db.close();
  });

  it("真实 invoke 锁超时：排队成功返回 queued，不执行 _invokeInternal", async () => {
    await h.hold();
    h.internals._invokeInternal = async () => { throw new Error("不应执行新的模型 invoke"); };
    const result = await h.factory.invoke("otter-1", "继续", { conversationId: "conv-1", currentInvokeId: "waiter" });
    expect(result.queued).toBe(true);
    expect(h.healing.some((e) => e.description === "等锁超时，消息已转交当前 session 的 followUp 队列。" && e.messageId === "waiter")).toBe(true);
  });

  it("handoff 置位：快速失败且不注入旧 session", async () => {
    vi.useFakeTimers();
    try {
      await h.hold();
      h.internals.lockManager.setHandoffMode("session:otter-1", true);
      h.internals.poolMeta.clear(); // 池也不可用：任何注入都违反交接冻结。
      const pending = h.factory.invoke("otter-1", "不能注入旧世", { conversationId: "conv-1" });
      const assertion = expect(pending).rejects.toThrow("目标海獭正在交接，消息未能送达，请稍后重试");
      await vi.advanceTimersByTimeAsync(120_001);
      await assertion;
      await vi.waitFor(() => expect(h.healing.some((e) => e.description === "交接冻结窗口超时，拒绝向即将换世的旧 session 注入。")).toBe(true));
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it("池不可用：人话快速失败，不抛 Lock acquire timeout", async () => {
    await h.hold();
    h.internals.poolMeta.clear();
    // 人工锁 epoch 指向无 DB 行的 holder：probe 保守不接管，才能进入锁超时降级。
    h.db.prepare("DELETE FROM invokes WHERE id = 'holder-invoke'").run();
    await expect(h.factory.invoke("otter-1", "消息", { conversationId: "conv-1" })).rejects.toThrow("目标海獭状态异常，消息未能送达，请稍后重试");
    expect(h.healing.some((e) => e.description === "锁被占用但池内 session 不可注入，消息未送达。")).toBe(true);
  });

  it("真实 invoke 的 prompt/drain 未 settle 时拒绝第二委托，settle 后清理", async () => {
    let releasePrompt!: () => void;
    const promptDrain = new Promise<void>((resolve) => { releasePrompt = resolve; });
    h.internals._invokeInternal = async () => {
      h.meta.epoch = invokeEpochStorage.getStore()!;
      await promptDrain; // 同真实 session.prompt：覆盖 yield 后的 followUp drain。
      return { text: "done" };
    };
    const holder = h.factory.invoke("otter-1", "holder", { conversationId: "conv-1", currentInvokeId: "holder-invoke" });
    await vi.waitFor(() => expect(h.internals.lockManager.locks.get("session:otter-1")?.held).toBe(true));
    await expect(h.factory.followUp("otter-1", "one", { delegated: true })).resolves.toBe(true);
    await expect(h.factory.followUp("otter-1", "two", { delegated: true })).rejects.toThrow("目标海獭已有排队任务在消化");
    expect(h.healing.filter((event) => event.description === "目标海獭已有排队任务在消化，拒绝第二个链委托。")).toHaveLength(1);

    // 不能靠 queue_update/agent_end 提前清；只有原 invoke 的完整 prompt settle 才清。
    releasePrompt();
    await holder;
    await expect(h.factory.followUp("otter-1", "two", { delegated: true })).resolves.toBe(true);
    expect(h.healing.filter((event) => event.description === "链式派工已注入持有者队列；持有者异常早退时消息随 session 生命周期处理。")).toHaveLength(2);
  });

  it("生产 probe：holder completed + SDK drain 活跃，超龄锁也不接管", async () => {
    let releasePrompt!: () => void;
    const promptDrain = new Promise<void>((resolve) => { releasePrompt = resolve; });
    h.internals._invokeInternal = async () => {
      h.meta.epoch = invokeEpochStorage.getStore()!;
      h.db.prepare("UPDATE invokes SET status = 'completed' WHERE id = 'holder-invoke'").run();
      await promptDrain;
      return { text: "done" };
    };
    h.internals.lockManager.defaultTimeout = 1_000;
    const holder = h.factory.invoke("otter-1", "holder", { conversationId: "conv-1", currentInvokeId: "holder-invoke" });
    await vi.waitFor(() => expect(h.db.prepare("SELECT status FROM invokes WHERE id = 'holder-invoke'").pluck().get()).toBe("completed"));
    h.internals.lockManager.locks.get("session:otter-1")!.heldAt = Date.now() - 300_001;

    let secondExecuted = false;
    const waiter = h.factory.invoke("otter-1", "after-drain", { conversationId: "conv-1", currentInvokeId: "waiter" })
      .then((result) => { secondExecuted = true; return result; });
    await vi.waitFor(() => expect(h.internals.lockManager.locks.get("session:otter-1")?.waiters.length).toBe(1));
    expect(secondExecuted).toBe(false);
    expect(h.internals.lockManager.locks.get("session:otter-1")?.generation).toBe(0);
    expect(h.healing).toHaveLength(0);

    releasePrompt();
    await holder;
    await expect(waiter).resolves.toEqual({ text: "done" });
  });

  it("SDK 未接收/抛错返回 false，不残留单飞行标志", async () => {
    vi.mocked(h.session.followUp).mockResolvedValueOnce("handled");
    await expect(h.factory.followUp("otter-1", "bad", { delegated: true })).resolves.toBe(false);
    vi.mocked(h.session.followUp).mockRejectedValueOnce(new Error("queue failed"));
    await expect(h.factory.followUp("otter-1", "bad-again", { delegated: true })).resolves.toBe(false);
    await expect(h.factory.followUp("otter-1", "good", { delegated: true })).resolves.toBe(true);
  });

  it("handoff 中链委托拒绝注入旧世，回退锁等待", async () => {
    h.internals.lockManager.setHandoffMode("session:otter-1", true);
    await expect(h.factory.followUp("otter-1", "old world", { delegated: true })).resolves.toBe(false);
    expect(h.meta.delegatedFollowUpInFlight).toBeUndefined();
    expect(h.healing).toHaveLength(0);
  });

  it("池 evict 销毁未 drain 的委托：有 healing 留痕，标志随条目清理", async () => {
    await expect(h.factory.followUp("otter-1", "abandoned", { delegated: true })).resolves.toBe(true);
    expect(h.meta.delegatedFollowUpInFlight).toBeDefined();
    h.internals.pool.evict("otter-1");
    expect(h.internals.poolMeta.has("otter-1")).toBe(false);
    expect(h.healing.some((event) => event.messageId === "holder-invoke" && event.description === "链式派工已注入持有者队列；持有者异常早退时消息随 session 生命周期处理。")).toBe(true);
  });

  it("普通用户 followUp 不受委托单飞行限制", async () => {
    await h.factory.followUp("otter-1", "delegated", { delegated: true });
    expect(h.factory.followUp("otter-1", "user")).toBe(true);
  });
});
