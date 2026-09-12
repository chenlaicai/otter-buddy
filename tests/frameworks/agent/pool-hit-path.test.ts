/**
 * F20260911pspl：池命中路径集成测试（检视 r2 严重 1）。
 *
 * 守护的行为：二次 invoke 复用同一 session（不重建）+ invoke 级寄存器重置 +
 * 工具 getter 穿透读寄存器当前值 + stale streaming 会话驱逐防御。
 *
 * 策略：_restoreOrCreateSession 与 _createSessionWithTools mock 到最小边界
 * （真实 createAgentSession 需要模型端点，单测不触网），验证 PiSessionFactory
 * 内部的池化编排逻辑——这是本 PR 新增的代码路径。
 */
import { describe, it, expect, vi } from "vitest";

// 与 identity-prefix.test.ts 同款：getConfig 需要初始化，mock 掉
vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {} }) }));

import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import { createInvokeRegister, resetInvokeRegister } from "@frameworks/agent/tool-builder";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";

type FakeSession = {
  isStreaming: boolean;
  disposed: boolean;
  dispose(): void;
  abort(): Promise<void>;
  steer(text: string): Promise<void>;
};

function fakeSession(): FakeSession {
  const s: FakeSession = {
    isStreaming: false,
    disposed: false,
    dispose() { s.disposed = true; },
    abort: async () => {},
    steer: async () => {},
  };
  return s;
}

/** 构造池化编排可测的工厂：mock 掉 SDK 接触的两侧（restore 与 createSession） */
function makeFactory() {
  const db = createTestDb();
  const factory = new PiSessionFactory({
    db,
    sessionDir: ":memory:",
    otterToolClient: {} as never,
    model: null as never,
    createTools: () => [],
    otterConfigProvider: {
      getConfig: () => ({ systemPrompt: undefined, otterType: "big", modelAlias: null }),
      setConfig: () => {},
      deleteConfig: () => {},
    } as never,
    otterRepo: new SqliteOtterRepository(db),
  }, createTestLogger());

  const sessions = new Map<string, FakeSession>();
  let createCount = 0;
  const internals = factory as unknown as {
    _restoreOrCreateSession: (id: string) => Promise<{ sessionManager: unknown; createdNew: boolean }>;
    _createSessionWithTools: (...args: unknown[]) => Promise<{ session: unknown; sessionKey: string; toolContext: unknown }>;
    _acquirePooled: (id: string, opts: unknown) => Promise<{
      session: FakeSession; sessionKey: string; toolContext: { register?: unknown };
      turnText: { text: string }; isPooled: boolean; createdNew: boolean;
    }>;
    poolMeta: Map<string, { session: FakeSession; register: ReturnType<typeof createInvokeRegister> }>;
    pendingIdentity: Set<string>;
  };

  internals._restoreOrCreateSession = async () => ({ sessionManager: {}, createdNew: false });
  internals._createSessionWithTools = async (otterId: unknown, _otterType: unknown, options: unknown, _sm: unknown, register: unknown) => {
    createCount++;
    const session = fakeSession();
    sessions.set(otterId as string, session);
    // 与真实实现同构：sessionKey 按 messageId 键控
    const msgId = (options as { messageId?: string })?.messageId;
    return {
      session,
      sessionKey: msgId ? `${otterId}:${msgId}` : (otterId as string),
      toolContext: { register },
    };
  };
  return { factory, internals, sessions, db, getCreateCount: () => createCount };
}

describe("F20260911pspl 池命中路径（_acquirePooled）", () => {
  it("二次 invoke 复用同一 session（不重建），寄存器被重置", async () => {
    const { internals, db, getCreateCount } = makeFactory();
    const first = await internals._acquirePooled("o1", { messageId: "m1" });
    expect(first.isPooled).toBe(false);
    expect(getCreateCount()).toBe(1);

    // 模拟上轮 invoke 留下的寄存器状态
    const meta = internals.poolMeta.get("o1")!;
    meta.register.currentMessageId = "m1";
    meta.register.turnText.text = "上轮残留文本";
    meta.register.dispatchWarningShown = true;
    meta.register.pendingDispatches.set("x", "y");

    const second = await internals._acquirePooled("o1", { messageId: "m2" });
    expect(second.isPooled).toBe(true);
    expect(second.session).toBe(first.session); // 同一对象，未重建
    expect(getCreateCount()).toBe(1); // createSession 未被再调

    // 寄存器已重置为本轮 messageId，上轮状态清零
    expect(meta.register.currentMessageId).toBe("m2");
    expect(meta.register.turnText.text).toBe("");
    expect(meta.register.dispatchWarningShown).toBe(false);
    expect(meta.register.pendingDispatches.size).toBe(0);
    db.close();
  });

  it("stale streaming 会话：命中仍 streaming 时标记出池（不 dispose）并冷启动（#599 防御）", async () => {
    const { internals, sessions, db, getCreateCount } = makeFactory();
    const first = await internals._acquirePooled("o1", { messageId: "m1" });
    expect(getCreateCount()).toBe(1);

    // 模拟 stale steal：旧 invoke 仍挂 streaming
    sessions.get("o1")!.isStreaming = true;

    const second = await internals._acquirePooled("o1", { messageId: "m2" });
    expect(second.isPooled).toBe(false); // 走冷启动
    expect(getCreateCount()).toBe(2); // 重建
    // 旧 session 不被 dispose（旧 invoke 仍在跑，dispose 会撕裂它）——出池后由旧 invoke 生命周期托管
    expect(sessions.get("o1")!.disposed).toBe(false);
    expect(second.session).not.toBe(first.session);
    db.close();
  });

  it("F20260910ctlv 整合移植：readOnly 绕过池——不复用/不入池（修 main #894 潜在回归）", async () => {
    const { internals, db, getCreateCount } = makeFactory();
    // 先普通 invoke 入池
    const first = await internals._acquirePooled("o1", { messageId: "m1" });
    expect(getCreateCount()).toBe(1);

    // readOnly invoke：即使池有命中条目也不复用（工具集是全量的，readOnly 需过滤）
    const ro = await internals._acquirePooled("o1", { messageId: "m2", readOnly: true });
    expect(ro.isPooled).toBe(false);
    expect(getCreateCount()).toBe(2); // 重建（带工具过滤）
    expect(ro.session).not.toBe(first.session);
    // readOnly session 不入池：poolMeta 仍指向首个 session（mock 的 sessions Map 按 otterId 键控被 ro 重建覆盖，不作断言面）
    expect(internals.poolMeta.get("o1")!.session).toBe(first.session);
    db.close();
  });

  it("F20260910ctlv 整合移植：池命中刷新 currentInvokeId/emitEvent/lastSpeakEntryId（不刷新则挂错 invoke）", async () => {
    const { internals, db } = makeFactory();
    await internals._acquirePooled("o1", { messageId: "m1", currentInvokeId: "inv-1" });
    const meta = internals.poolMeta.get("o1")!;
    expect(meta.register.currentInvokeId).toBe("inv-1");

    // 模拟上轮 invoke 残留
    meta.register.lastSpeakEntryId = "speak-1";
    meta.register.emitEvent = () => {};

    const emit2 = () => {};
    const second = await internals._acquirePooled("o1", { messageId: "m2", currentInvokeId: "inv-2", emitEvent: emit2 });
    expect(second.isPooled).toBe(true);
    // ctlv 三字段全部刷新为本轮值
    expect(meta.register.currentInvokeId).toBe("inv-2");
    expect(meta.register.lastSpeakEntryId).toBeUndefined();
    expect(meta.register.emitEvent).toBe(emit2);
    db.close();
  });

  it("池命中跳过身份注入（needsIdentity=false）；冷启动 createdNew 时注入", async () => {
    const { factory, internals, db } = makeFactory();
    // 冷启动 createdNew=true → 身份标记
    internals._restoreOrCreateSession = async () => ({ sessionManager: {}, createdNew: true });
    await internals._acquirePooled("o1", undefined);
    expect(internals.pendingIdentity.has("o1")).toBe(true);

    // 池命中 → _invokeInternal 判定 needsIdentity=false（身份已在 session 上下文）
    // 注：完整 _invokeInternal 链路在 identity-prefix.test.ts 覆盖（mock 层不同），
    // 此处直接验证池命中后 pendingIdentity 不影响 isPooled 语义。
    const hit = await internals._acquirePooled("o1", undefined);
    expect(hit.isPooled).toBe(true);
    expect(hit.createdNew).toBe(false);
    db.close();
    void factory;
  });
});

describe("InvokeRegister 寄存器（getter 穿透的守护）", () => {
  it("resetInvokeRegister 单点重置全部 invoke 级字段", () => {
    const reg = createInvokeRegister();
    reg.currentMessageId = "old-msg";
    reg.turnText.text = "残留";
    reg.pendingDispatches.set("a", "b");
    reg.dispatchWarningShown = true;
    reg.orchestrationWarningShown = true;
    reg.pendingRestart = { summary: "x" };

    resetInvokeRegister(reg, "new-msg");

    expect(reg.currentMessageId).toBe("new-msg");
    expect(reg.turnText.text).toBe("");
    expect(reg.pendingDispatches.size).toBe(0);
    expect(reg.dispatchWarningShown).toBe(false);
    expect(reg.orchestrationWarningShown).toBe(false);
    expect(reg.pendingRestart).toBeUndefined();
  });

  it("resetInvokeRegister 无 messageId 时清空（合成/readOnly 场景）", () => {
    const reg = createInvokeRegister();
    reg.currentMessageId = "old";
    resetInvokeRegister(reg, undefined);
    expect(reg.currentMessageId).toBe("");
  });
});
