/**
 * SimpleLockManager 并发安全测试
 *
 * Why: #376 根因是旧版锁只检查 waiters 队列长度，第一个获取者不入队，
 * 导致第二个调用者也绕过等待。本测试验证修复后的锁正确跟踪 held 状态。
 */
import { describe, it, expect, vi } from "vitest";
import { SimpleLockManager } from "@frameworks/agent/session-helpers";
import type { Logger } from "@usecases/ports/logger";

describe("SimpleLockManager", () => {
  it("should prevent concurrent access to the same key", async () => {
    const lock = new SimpleLockManager();
    const executionOrder: number[] = [];

    // 模拟两个并发操作竞争同一把锁
    const task1 = async () => {
      const release = await lock.acquire("resource-1");
      executionOrder.push(1); // task1 获得锁
      // 模拟异步工作（不释放锁）
      await new Promise(r => setTimeout(r, 50));
      executionOrder.push(3); // task1 完成
      release();
    };

    const task2 = async () => {
      // Why: 短延迟确保 task1 先获取锁，但 task1 还没释放
      await new Promise(r => setTimeout(r, 10));
      const release = await lock.acquire("resource-1");
      executionOrder.push(2); // task2 获得锁（必须在 task1 释放后）
      release();
    };

    await Promise.all([task1(), task2()]);

    // 验证：task1 获得锁 → task1 完成 → task2 获得锁
    // 如果锁有 bug，task2 会在 task1 完成前获得锁，顺序变为 [1, 2, 3]
    expect(executionOrder).toEqual([1, 3, 2]);
  });

  it("should allow sequential access after lock is released", async () => {
    const lock = new SimpleLockManager();
    const executionOrder: number[] = [];

    const release1 = await lock.acquire("resource-1");
    executionOrder.push(1);
    release1();

    const release2 = await lock.acquire("resource-1");
    executionOrder.push(2);
    release2();

    expect(executionOrder).toEqual([1, 2]);
  });

  it("should allow concurrent access to different keys", async () => {
    const lock = new SimpleLockManager();
    const executionOrder: string[] = [];

    const task1 = async () => {
      const release = await lock.acquire("resource-A");
      executionOrder.push("A-start");
      await new Promise(r => setTimeout(r, 50));
      executionOrder.push("A-end");
      release();
    };

    const task2 = async () => {
      const release = await lock.acquire("resource-B");
      executionOrder.push("B-start");
      await new Promise(r => setTimeout(r, 50));
      executionOrder.push("B-end");
      release();
    };

    await Promise.all([task1(), task2()]);

    // 不同 key 应该可以并发：A-start 和 B-start 应该在 A-end 和 B-end 之前
    expect(executionOrder.indexOf("A-start")).toBeLessThan(executionOrder.indexOf("A-end"));
    expect(executionOrder.indexOf("B-start")).toBeLessThan(executionOrder.indexOf("B-end"));
    // A-start 和 B-start 应该几乎同时（都在前两个位置）
    expect(executionOrder.slice(0, 2).sort()).toEqual(["A-start", "B-start"]);
  });

  it("should timeout when lock is held too long", async () => {
    const lock = new SimpleLockManager();

    // 获取锁但不释放
    const release = await lock.acquire("resource-1");

    // 第二个获取者应该超时
    await expect(
      lock.acquire("resource-1", 100)
    ).rejects.toThrow("Lock acquire timeout for key: resource-1");

    release();
  });

  it("should handle double release safely", async () => {
    const lock = new SimpleLockManager();

    const release = await lock.acquire("resource-1");
    release();
    // 第二次释放不应该报错或影响后续获取
    release();

    // 应该能正常获取锁
    const release2 = await lock.acquire("resource-1");
    release2();
  });

  it("should wake up next waiter when lock is released", async () => {
    const lock = new SimpleLockManager();
    const executionOrder: number[] = [];

    const task1 = async () => {
      const release = await lock.acquire("resource-1");
      executionOrder.push(1);
      await new Promise(r => setTimeout(r, 30));
      release();
    };

    const task2 = async () => {
      await new Promise(r => setTimeout(r, 10));
      const release = await lock.acquire("resource-1");
      executionOrder.push(2);
      release();
    };

    const task3 = async () => {
      await new Promise(r => setTimeout(r, 20));
      const release = await lock.acquire("resource-1");
      executionOrder.push(3);
      release();
    };

    await Promise.all([task1(), task2(), task3()]);

    // 顺序应该是 1 → 2 → 3（task2 先等，先被唤醒）
    expect(executionOrder).toEqual([1, 2, 3]);
  });

  it("should clean up after destroy", async () => {
    const lock = new SimpleLockManager();

    const release = await lock.acquire("resource-1");

    // destroy 应该唤醒所有等待者
    const waitPromise = lock.acquire("resource-1").then(r => r());
    lock.destroy();

    // 不应该挂起
    await expect(waitPromise).resolves.toBeUndefined();

    release();
  });

  it("should handle late release after destroy safely", async () => {
    // Why: 检视獭发现 #2 —— destroy 在持有者释放前调用的边界场景
    // 持有者的闭包仍引用旧 lock 对象，但 lock.held 已被 Map 清理
    // 验证：不 crash、不挂起
    const lock = new SimpleLockManager();

    const release = await lock.acquire("resource-1");

    // destroy 在持有者释放前调用——唤醒所有等待者并清理 Map
    lock.destroy();

    // 持有者仍然持有闭包中的 release 函数
    // 调用 release 不应该 crash（lock entry 已被清理，held 状态不影响）
    expect(() => release()).not.toThrow();

    // destroy 后应该能重新获取锁（Map 已清理）
    const release2 = await lock.acquire("resource-1");
    release2();
  });

  it("should allow new acquire after waiter timeout and holder release", async () => {
    // Why: 检视獭发现 #3 —— timeout 后 stale entry 清理的端到端路径
    // holder 持有锁 → waiter 超时 → holder 释放 → 新 acquire 立即获取锁
    const lock = new SimpleLockManager();

    // 1. holder 获取锁
    const holderRelease = await lock.acquire("resource-1");

    // 2. waiter 尝试获取锁，会超时
    const waiterPromise = lock.acquire("resource-1", 50);
    await expect(waiterPromise).rejects.toThrow("Lock acquire timeout for key: resource-1");

    // 3. holder 释放锁
    holderRelease();

    // 4. 新的 acquire 应该立即获取锁（stale waiter 已被清理，lock 正确重置）
    const newRelease = await lock.acquire("resource-1");
    // 不应该超时或挂起
    newRelease();
  });

  it("should emit structured diagnostic log on lock acquire timeout (#423)", async () => {
    // Why(#423 方案1): 超时路径此前是静默故障——报错文本之外无任何证据，
    // 无法定位持有者是谁、持有了多久。注入 logger 后，超时时必须落结构化日志。
    const errorSpy = vi.fn();
    const logger = {
      info: vi.fn(), warn: vi.fn(), debug: vi.fn(),
      error: errorSpy,
      child: vi.fn(),
    } as unknown as Logger;
    const lock = new SimpleLockManager(30000, logger);

    // holder 获取锁后持有不释放
    const holderRelease = await lock.acquire("session:otter-abc");
    await new Promise(r => setTimeout(r, 30)); // 让 holder 持有一段时间，heldForMs 可测

    // waiter 超时
    await expect(
      lock.acquire("session:otter-abc", 60)
    ).rejects.toThrow("Lock acquire timeout for key: session:otter-abc");

    // 断言：结构化日志被记录，且包含诊断关键字段
    expect(errorSpy.mock.calls).toHaveLength(1);
    const [message, error, context] = errorSpy.mock.calls[0];
    expect(message).toBe("Lock acquire timeout for key: session:otter-abc");
    expect(error).toBeInstanceOf(Error);
    expect(context).toMatchObject({
      module: 'SimpleLockManager',
      lockKey: "session:otter-abc",
      otterId: "otter-abc",
      timeoutMs: 60,
      queueLength: 0,
      activeLocks: 1,
    });
    expect(context.waitedMs).toBeGreaterThanOrEqual(60);
    expect(context.holderHeldForMs).toBeGreaterThanOrEqual(30);

    holderRelease();
  });

  it("should not log on successful acquire after waiting (#423)", async () => {
    // Why: 只有超时路径落日志，正常等待后获锁不应产生噪音日志
    const errorSpy = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: errorSpy, child: vi.fn() } as unknown as Logger;
    const lock = new SimpleLockManager(30000, logger);

    const release1 = await lock.acquire("resource-1");
    const waiter = lock.acquire("resource-1", 200);
    await new Promise(r => setTimeout(r, 20));
    release1(); // 释放后 waiter 获锁
    const release2 = await waiter;
    release2();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("should work without logger (backward compatible)", async () => {
    // Why: logger 可选——未注入时超时行为不变（仍 reject），只是无日志
    const lock = new SimpleLockManager();
    const release = await lock.acquire("resource-1");
    await expect(
      lock.acquire("resource-1", 50)
    ).rejects.toThrow("Lock acquire timeout for key: resource-1");
    release();
  });
});
