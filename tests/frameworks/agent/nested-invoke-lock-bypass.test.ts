/**
 * #896：嵌套 invoke 锁旁路（ALS 检测）。
 *
 * 守护的行为：session_before_compact 钩子在 session.prompt() 的 agent loop 内部触发，
 * 此时外层 invoke 持有 per-otter 锁；钩子里的合成（readOnly invoke）走完整 invoke 链路——
 * 若再取同一把锁必死锁（30s 超时降级 Pi 默认摘要）。修复：invoke 入口检测
 * otterInvokeStorage 中同 otterId 的 store，命中 = 同 async context 嵌套 invoke，跳过取锁。
 *
 * 测试策略：mock SDK 接触的两侧（restore/createSession），_invokeInternal 用可控 barrier
 * 挂起外层，嵌套 invoke 若误取锁必在 held 锁上超时（可观察副作用）；旁路则立即通过。
 * 锁状态通过 lockManager.locks 的 held 位断言（状态断言，非调用次数）。
 */
import { describe, it, expect, vi } from "vitest";

// 与 identity-prefix.test.ts 同款：getConfig 需要初始化，mock 掉
vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {} }) }));

import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import { otterInvokeStorage } from "@frameworks/agent/model-runtime-registry";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";

/** 可控 barrier：外层 _invokeInternal 挂起直到 release，模拟压缩钩子触发时外层仍在 prompt */
function makeBarrier() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { gate, release };
}

function makeFactory(internalImpl: (id: string, msg: string) => Promise<{ text: string }>) {
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

  const internals = factory as unknown as {
    lockManager: { locks: Map<string, { held: boolean }> };
    _invokeInternal: (id: string, msg: string, opts: unknown) => Promise<{ text: string }>;
  };
  internals._invokeInternal = internalImpl;
  return { factory, internals, db };
}

describe("#896 嵌套 invoke 锁旁路", () => {
  it("外层持锁期间，同 otterId 的嵌套 invoke（压缩合成）旁路锁立即执行", async () => {
    const barrier = makeBarrier();
    const { factory, internals, db } = makeFactory(async (_id, msg) => {
      // 外层 invoke 挂起（模拟 prompt 中途）；嵌套 invoke 直接返回
      if (msg === "外层用户消息") await barrier.gate;
      return { text: `done:${msg}` };
    });

    // 外层 invoke：不在 ALS context（store 在 _executeWithSession 内才建立）→ 正常取锁，挂起
    const outerPromise = factory.invoke("o1", "外层用户消息", { conversationId: "c1" });

    // 等外层进入 _invokeInternal（锁已持有）
    await new Promise((r) => setTimeout(r, 20));
    expect(internals.lockManager.locks.get("session:o1")?.held).toBe(true);

    // 嵌套 invoke：携带同 otterId store（模拟压缩钩子在 prompt 中途触发合成）。
    // 若误取锁 → 在 held 锁上等待 30s 超时；旁路 → 立即完成。
    const nestedResult = await otterInvokeStorage.run(
      { otterPromptConfig: undefined, identityPrefix: "", otterId: "o1" },
      () => factory.invoke("o1", "压缩合成 prompt", { conversationId: "", readOnly: true }),
    );
    // 嵌套立即完成（未等外层 barrier）= 旁路的可观察证据
    expect(nestedResult.text).toBe("done:压缩合成 prompt");
    // 嵌套完成后外层锁仍持有（嵌套没有 release 不属于自己的锁）
    expect(internals.lockManager.locks.get("session:o1")?.held).toBe(true);

    barrier.release();
    const outerResult = await outerPromise;
    expect(outerResult.text).toBe("done:外层用户消息");
    // 外层释放后锁归还（release 删除条目，get 返回 undefined = 未持有）
    expect(internals.lockManager.locks.get("session:o1")?.held ?? false).toBe(false);
    db.close();
  });

  it("不同 async context 的同 otterId invoke 照常取锁（真并发不旁路，排队等待）", async () => {
    const barrier = makeBarrier();
    const { factory, internals, db } = makeFactory(async (_id, msg) => {
      if (msg === "外层用户消息") await barrier.gate;
      return { text: `done:${msg}` };
    });

    const outerPromise = factory.invoke("o1", "外层用户消息", { conversationId: "c1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(internals.lockManager.locks.get("session:o1")?.held).toBe(true);

    // 裸调用（无 store）→ 取锁 → 在 held 锁上排队。给它 50ms 窗口：若排队则必然未完成。
    let secondSettled = false;
    const secondPromise = factory.invoke("o1", "并发消息", { conversationId: "c2" })
      .then((r) => { secondSettled = true; return r; });
    await new Promise((r) => setTimeout(r, 50));
    // 锁被外层持有，第二个 invoke 排队中（未 settle）= 真并发走锁的可观察证据
    expect(secondSettled).toBe(false);

    barrier.release();
    const secondResult = await secondPromise;
    expect(secondSettled).toBe(true);
    expect(secondResult.text).toBe("done:并发消息");
    await outerPromise;
    expect(internals.lockManager.locks.get("session:o1")?.held ?? false).toBe(false);
    db.close();
  });

  it("ALS store 中 otterId 不同（其他獭的嵌套上下文）不旁路，照常取锁排队", async () => {
    const barrier = makeBarrier();
    const { factory, internals, db } = makeFactory(async (_id, msg) => {
      if (msg === "外层用户消息") await barrier.gate;
      return { text: `done:${msg}` };
    });

    const outerPromise = factory.invoke("otter-A", "外层用户消息", { conversationId: "c1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(internals.lockManager.locks.get("session:otter-A")?.held).toBe(true);

    // store 里是 otter-B，invoke 目标是 otter-A —— 不是同獭嵌套，必须走锁排队
    let settled = false;
    const promise = otterInvokeStorage.run(
      { otterPromptConfig: undefined, identityPrefix: "", otterId: "otter-B" },
      () => factory.invoke("otter-A", "其他獭上下文中的调用", { conversationId: "c2" })
        .then((r) => { settled = true; return r; }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false); // 排队中 = 未旁路

    barrier.release();
    const result = await promise;
    expect(result.text).toBe("done:其他獭上下文中的调用");
    await outerPromise;
    db.close();
  });
});
