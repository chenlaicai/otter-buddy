/**
 * F20261009epoc（#905）：invoke epoch 统一世代——方案验证节 8 条用例中的新增行为锁定。
 *
 * 覆盖（对应特性文档「验证」节编号）：
 * - case 2 降级路径：锁 epoch 缺失回退 generation（fail-soft，热路径不挂）
 * - case 3 寄存器归属（S4 裸露面收口）：stale steal 后旧 invoke finally delete 不删新 invoke 条目
 * - case 4 嵌套继承：嵌套 invoke 继承外层 epoch（不 mint）；嵌套+steal 混合场景 finally delete 正确跳过
 * - case 6 同键嵌套清理边界（known-boundary）：裸 otterId 共键，嵌套与外层共享 epoch，
 *   finally delete 无法区分内外层条目——与现状持平非回归，本用例划定边界
 * - case 7 非对称失效（r3-E-1）：otterInvokeStorage 断但 invokeEpochStorage 残留 →
 *   判非嵌套路径必铸新 epoch 并遮蔽残留外层值——等价性不可达证明的行为锁定
 *
 * 策略：走公共 invoke() 入口锁定时序（epoch 铸造/继承/遮蔽），内部方法用 mock
 * _invokeInternal / 直接打私有方法（与 nested-invoke-lock-bypass.test.ts 同构）。
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {} }) }));

import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import { otterInvokeStorage } from "@frameworks/agent/model-runtime-registry";
import { invokeEpochStorage, mintEpoch, type InvokeEpoch } from "@frameworks/agent/invoke-epoch";
import { SimpleLockManager } from "@frameworks/agent/session-helpers";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";

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

  const internals = factory as unknown as {
    _invokeInternal: (id: string, msg: string, opts: unknown) => Promise<{ text: string }>;
    _deleteActiveSessionIfOwned: (sessionKey: string) => void;
    activeSessions: Map<string, { epoch?: InvokeEpoch } & Record<string, unknown>>;
    lockManager: { acquire: (key: string, timeout?: number, epoch?: object) => Promise<() => void> };
  };
  return { factory, internals, db };
}

describe("F20261009epoc case 2：锁 epoch 降级（fail-soft，D3 分面）", () => {
  it("epoch 在场：steal 后旧持有者 release 对易主锁 no-op（引用比对路径）", async () => {
    const lock = new SimpleLockManager(30000, undefined, 100);

    const eA = mintEpoch("o1", "inv-a");
    const zombieRelease = await lock.acquire("session:o1", undefined, eA);
    await new Promise(r => setTimeout(r, 120));

    // 新 invoke（新 epoch 对象）steal 接管
    const eB = mintEpoch("o1", "inv-b");
    const newRelease = await lock.acquire("session:o1", undefined, eB);

    // 旧持有者 release：epoch 引用不等（eA ≠ eB）→ no-op，不干扰新持有者
    expect(() => zombieRelease()).not.toThrow();
    const third = lock.acquire("session:o1", 80);
    await expect(third).rejects.toThrow("Lock acquire timeout"); // 新持有者的锁仍有效

    newRelease();
  });

  it("epoch 缺失：回退 generation 计数器兜底（行为与旧版完全一致，fail-soft）", async () => {
    const lock = new SimpleLockManager(30000, undefined, 100);

    // 不带 epoch（非 invoke 路径调用锁——旧版全部走这条）
    const zombieRelease = await lock.acquire("session:o1");
    await new Promise(r => setTimeout(r, 120));

    const newRelease = await lock.acquire("session:o1");
    expect(() => zombieRelease()).not.toThrow(); // generation 判定兜底 no-op

    const third = lock.acquire("session:o1", 80);
    await expect(third).rejects.toThrow("Lock acquire timeout");
    newRelease();
  });

  it("epoch 在场：正常接力路径（waiter 队列）引用相等，release 不被误吞", async () => {
    const lock = new SimpleLockManager(30000, undefined, 60_000);

    const eA = mintEpoch("o1", "inv-a");
    const release1 = await lock.acquire("session:o1", undefined, eA);

    // waiter 携不同 epoch 排队（不同 invoke 是不同 epoch——但正常路径是等锁不是抢锁）
    const eB = mintEpoch("o1", "inv-b");
    const waiterPromise = lock.acquire("session:o1", undefined, eB);
    await new Promise(r => setTimeout(r, 20));

    release1(); // 接力给 waiter：锁转移不经过 steal，waiter 接管后成为新持有者
    const release2 = await waiterPromise;
    release2();
    // 两个都正常释放，锁回到可用状态
    const release3 = await lock.acquire("session:o1", undefined, mintEpoch("o1", "inv-c"));
    release3();
  });

  it("判别场景：锁条目删除重建后，zombie 迟到 release 不得释放新持有者的锁（世代链行为锁定）", async () => {
    // 场景链：① zombie（eA）持有（gen 0）→ ② 被 steal（gen→1，eB）→ ③ eB 正常释放
    // （无 waiter，条目从 Map 删除）→ ④ eC 重新 acquire（新建条目）→ ⑤ zombie 迟到的
    // release 到来。安全机理（变异验证实证）：release 闭包捕获的是旧条目对象，旧对象上
    // gen 已被 steal 推到 1（≠zombie 捕获的 0）→ no-op；新条目是不可达的独立对象。
    // 本用例锁定该世代链行为——无论判定走 epoch 引用比对还是 generation 兑底部不得释放 eC 的锁。
    const lock = new SimpleLockManager(30000, undefined, 100);

    const eA = mintEpoch("o1", "inv-a");
    const zombieRelease = await lock.acquire("session:o1", undefined, eA);
    await new Promise(r => setTimeout(r, 120)); // 超 steal 阈值

    const eB = mintEpoch("o1", "inv-b");
    const releaseB = await lock.acquire("session:o1", undefined, eB); // steal 接管（gen 0→1）
    releaseB(); // 正常释放，无 waiter → 条目删除

    const eC = mintEpoch("o1", "inv-c");
    const releaseC = await lock.acquire("session:o1", undefined, eC); // 新条目

    // zombie 迫到的 release：旧条目对象上 gen 不匹配 → no-op
    expect(() => zombieRelease()).not.toThrow();

    // eC 的锁仍完好：第四个 acquire 应排队等待而非直接获锁
    const fourth = lock.acquire("session:o1", 80);
    await expect(fourth).rejects.toThrow("Lock acquire timeout");
    releaseC();
  });
});

describe("F20261009epoc case 3：寄存器归属（S4 裸露面收口）", () => {
  it("stale steal 后旧 invoke finally delete 不删新 invoke 条目（epoch 不匹配 → 跳过）", async () => {
    const { internals, db } = makeFactory();
    const oldEpoch = mintEpoch("o1", "inv-old");
    const newEpoch = mintEpoch("o1", "inv-new");

    // 场景构造：旧 invoke 注册的条目已被新 invoke 顶替（activeSessions 同 sessionKey 重写）
    internals.activeSessions.set("o1", { toolCallCount: 3, epoch: newEpoch });

    // 旧 invoke 的 finally 在自己的 epoch 上下文里醒来执行 delete
    await invokeEpochStorage.run(oldEpoch, () => {
      internals._deleteActiveSessionIfOwned("o1");
      return Promise.resolve();
    });

    // 新 invoke 的条目存活（abort/steer 入口不消失——原 :991 无条件 delete 的裸露面已收口）
    expect(internals.activeSessions.has("o1")).toBe(true);
    expect(internals.activeSessions.get("o1")?.epoch).toBe(newEpoch);
    db.close();
  });

  it("归属自己（正常路径）：epoch 匹配 → delete 执行", async () => {
    const { internals, db } = makeFactory();
    const epoch = mintEpoch("o1", "inv-1");
    internals.activeSessions.set("o1", { toolCallCount: 0, epoch });

    await invokeEpochStorage.run(epoch, () => {
      internals._deleteActiveSessionIfOwned("o1");
      return Promise.resolve();
    });

    expect(internals.activeSessions.has("o1")).toBe(false);
    db.close();
  });
});

describe("F20261009epoc case 4：嵌套继承（D5）", () => {
  it("嵌套 invoke（otterInvokeStorage 同 otterId）继承外层 epoch，不 mint", async () => {
    const { factory, internals, db } = makeFactory();
    const seen: (InvokeEpoch | undefined)[] = [];
    internals._invokeInternal = async () => {
      seen.push(invokeEpochStorage.getStore());
      return { text: "ok" };
    };

    const outerEpochHolder: InvokeEpoch[] = [];
    // 外层：正常 invoke 走 mint 路径；mock internal 捕获 epoch
    internals._invokeInternal = async (id: string, msg: string) => {
      if (msg === "outer") {
        const e = invokeEpochStorage.getStore()!;
        outerEpochHolder.push(e);
        // 嵌套调用：外层 otterInvokeStorage store 已在（真实形态是钩子在 :918 run 内触发）
        return await otterInvokeStorage.run(
          { otterPromptConfig: undefined, identityPrefix: "", otterId: id },
          async () => {
            const r = await factory.invoke(id, "nested");
            seen.push(invokeEpochStorage.getStore());
            return { text: r.text };
          },
        ) as { text: string };
      }
      seen.push(invokeEpochStorage.getStore());
      return { text: "inner-ok" };
    };

    await factory.invoke("o1", "outer");
    // 嵌套继承断言：嵌套 invoke 里的 epoch === 外层 epoch（同一对象，未 mint 新币）
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toBe(outerEpochHolder[0]); // 嵌套执行时 ALS 读到外层对象
    db.close();
  });

  it("嵌套+steal 混合场景：外层被 steal 后嵌套 finally delete 比对时条目已是新 epoch → 跳过", async () => {
    const { internals, db } = makeFactory();
    const outerEpoch = mintEpoch("o1", "inv-outer"); // 外层（嵌套继承它）——已失效
    const newEpoch = mintEpoch("o1", "inv-new"); // steal 后的新 invoke

    // 场景构造：stale steal 后新 invoke 顶替了 activeSessions 条目
    internals.activeSessions.set("o1", { toolCallCount: 1, epoch: newEpoch });

    // 嵌套 invoke 继承外层 epoch（已失效），其 finally delete 跳过
    await invokeEpochStorage.run(outerEpoch, () => {
      internals._deleteActiveSessionIfOwned("o1");
      return Promise.resolve();
    });
    expect(internals.activeSessions.has("o1")).toBe(true); // 新 invoke 条目存活

    // 反向对照：新 invoke 自己的 finally delete 正常删除自己的条目
    await invokeEpochStorage.run(newEpoch, () => {
      internals._deleteActiveSessionIfOwned("o1");
      return Promise.resolve();
    });
    expect(internals.activeSessions.has("o1")).toBe(false);
    db.close();
  });
});

describe("F20261009epoc case 6：同键嵌套清理边界（known-boundary，D5）", () => {
  it("裸 otterId 共键：嵌套与外层共享 epoch，finally delete 无法区分内外层条目（与现状持平）", async () => {
    const { internals, db } = makeFactory();
    const sharedEpoch = mintEpoch("o1", "inv-outer"); // 嵌套继承 → 共享

    // 共键条目（裸 otterId，无 messageId）
    internals.activeSessions.set("o1", { toolCallCount: 0, epoch: sharedEpoch });

    // 嵌套 invoke 的 finally（继承的 epoch === 条目 epoch）→ delete 执行（旧行为：无条件 delete 同样删）
    await invokeEpochStorage.run(sharedEpoch, () => {
      internals._deleteActiveSessionIfOwned("o1");
      return Promise.resolve();
    });
    expect(internals.activeSessions.has("o1")).toBe(false); // known-boundary：与旧行为持平

    // known-boundary 声明：外层的后续 finally 再跑一次 delete 时条目已不在（无二次伤害面），
    // 且外层若重新注册（下轮 invoke）不受影响——边界由 sessionKey 键控语义划定，
    // 彻底区分需引入嵌套计数（超出本 PR 范围，方案 D5 边界声明）。
    db.close();
  });
});

describe("F20261009epoc case 7：非对称失效（r3-E-1 遮蔽式 run）", () => {
  it("otterInvokeStorage 断但 invokeEpochStorage 残留 → 判非嵌套 + 铸新 epoch 遮蔽残留外层值", async () => {
    const { factory, internals, db } = makeFactory();
    const seenDuringExec: (InvokeEpoch | undefined)[] = [];
    internals._invokeInternal = async () => {
      seenDuringExec.push(invokeEpochStorage.getStore()); // 执行期 ALS 读到的值
      return { text: "ok" };
    };

    // 锁 acquire spy：捕获第三参（epoch）——invoke() 传入锁的就是它 mint 的对象
    const acquiredEpochs: (object | undefined)[] = [];
    const realAcquire = internals.lockManager.acquire.bind(internals.lockManager);
    internals.lockManager.acquire = async (key: string, timeout?: number, epoch?: object) => {
      acquiredEpochs.push(epoch);
      return realAcquire(key, timeout, epoch);
    };

    // 残留的外层 epoch eA（invokeEpochStorage 可读，otterInvokeStorage 不可读——非对称形态）
    const residualEpoch = mintEpoch("o1", "inv-residual");
    // 不套 otterInvokeStorage（模拟身份 ALS 断裂），只套 epoch ALS 残留
    const result = await invokeEpochStorage.run(residualEpoch, () => factory.invoke("o1", "m"));
    expect(result.text).toBe("ok");

    // 断言：判非嵌套（走了取锁路径）+ 铸的是全新对象（≠ 残留 eA，遮蔽成立）
    expect(acquiredEpochs).toHaveLength(1);
    expect(acquiredEpochs[0]).toBeDefined();
    expect(acquiredEpochs[0]).not.toBe(residualEpoch); // 关键对首跳：外层 eA vs 遮蔽铸的 eB
    // 执行期 ALS 读到的也是 eB（遮蔽不是只遮锁路径，整个 run 作用域都被新对象覆盖）
    expect(seenDuringExec[0]).toBe(acquiredEpochs[0]);
    expect(seenDuringExec[0]).not.toBe(residualEpoch);
    db.close();
  });

  it("正常非嵌套路径：无任何 ALS 残留 → mint + 锁收到该对象", async () => {
    const { factory, internals, db } = makeFactory();
    internals._invokeInternal = async () => {
      // 锁收到的 epoch 应与执行期 ALS 读到的同一对象
      expect(invokeEpochStorage.getStore()).toBe(acquiredEpochs[0]);
      return { text: "ok" };
    };
    const acquiredEpochs: (object | undefined)[] = [];
    const realAcquire = internals.lockManager.acquire.bind(internals.lockManager);
    internals.lockManager.acquire = async (key: string, timeout?: number, epoch?: object) => {
      acquiredEpochs.push(epoch);
      return realAcquire(key, timeout, epoch);
    };

    await factory.invoke("o1", "m");
    expect(acquiredEpochs).toHaveLength(1);
    expect(acquiredEpochs[0]).toBeDefined();
    db.close();
  });
});

describe("F20261009epoc：mintEpoch 值对象", () => {
  it("每次铸造必返回全新冻结对象（引用唯一性是判定根基）", () => {
    const a = mintEpoch("o1", "inv-1");
    const b = mintEpoch("o1", "inv-2");
    expect(a).not.toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(a.seq).toBeLessThan(b.seq); // per-otter 单调
  });
});
