import { describe, expect, it, vi } from "vitest";
import { SimpleLockManager, shouldStealSessionLock, type SessionLockProbeResult } from "@frameworks/agent/session-helpers";
import { createTestLogger } from "../../helpers/logger";

const logger = createTestLogger();

describe("F20261026cnsv D4 session lock steal probe", () => {
  it.each([
    ["running", true, false],
    ["running", false, true], // 孤儿行：定稿 D4 明确可接管
    ["completed", true, false], // yield 后 drain：明确禁止误抢
    ["completed", false, true],
    ["aborted", true, true],
    ["failed", true, true],
    ["aborted", false, true],
    ["failed", false, true],
    [null, false, false], // 读不到持有行 = 失明，不接管
    [null, true, false],
  ] as Array<[SessionLockProbeResult["invokeStatus"], boolean, boolean]>)(
    "invoke=%s sdkRunning=%s -> steal=%s",
    (invokeStatus, sdkRunning, expected) => {
      expect(shouldStealSessionLock({ invokeStatus, sdkRunning })).toBe(expected);
    },
  );

  it("真实锁路径：超龄但 completed+SDK 活仍等待，释放后才获锁", async () => {
    const probe = vi.fn(() => ({ invokeStatus: "completed" as const, sdkRunning: true }));
    const locks = new SimpleLockManager(10, logger, 0, probe);
    const epoch = { invokeId: "holder" };
    const release = await locks.acquire("session:otter", undefined, epoch);
    const waiter = locks.acquire("session:otter");
    await vi.waitFor(() => expect(probe).toHaveBeenCalled());
    await expect(Promise.race([waiter.then(() => "acquired"), Promise.resolve("waiting")])).resolves.toBe("waiting");
    release();
    await waiter;
  });

  it("真实锁路径：aborted+SDK 活接管，旧 release 不能释放新锁", async () => {
    const locks = new SimpleLockManager(10, logger, 0, () => ({ invokeStatus: "aborted", sdkRunning: true }));
    const releaseOld = await locks.acquire("session:otter");
    const releaseNew = await locks.acquire("session:otter");
    releaseOld();
    const third = locks.acquire("session:otter");
    await expect(Promise.race([third.then(() => "acquired"), Promise.resolve("waiting")])).resolves.toBe("waiting");
    releaseNew();
    await third;
  });

  it("探针异常保守等待，超时不误判接管", async () => {
    const locks = new SimpleLockManager(5, logger, 0, () => { throw new Error("db unavailable"); });
    const release = await locks.acquire("session:otter");
    await expect(locks.acquire("session:otter")).rejects.toThrow("Lock acquire timeout");
    release();
  });
});
