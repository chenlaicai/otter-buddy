/**
 * SimpleLockManager 并发安全测试
 *
 * Why: #376 根因是旧版锁只检查 waiters 队列长度，第一个获取者不入队，
 * 导致第二个调用者也绕过等待。本测试验证修复后的锁正确跟踪 held 状态。
 */
import { describe, it, expect } from "vitest";
import { SimpleLockManager } from "@frameworks/agent/session-helpers";

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
});
