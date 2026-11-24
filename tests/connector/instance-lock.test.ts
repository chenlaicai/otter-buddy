import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireInstanceLock, isPidAlive, releaseInstanceLock, resolveLockDecision } from "../../src/connector/instance-lock";

/**
 * 单实例锁单测：决策纯函数 + 真实锁文件 acquire/steal/busy/release 生命周期。
 * 锁目录在 ~/.otter/connector——测试用 HOME 重定向到临时目录隔离（进程级 vi.mock 不可
 * 靠，改用子进程代价高；HOME 环境变量在模块函数调用时读取，beforeEach 里改即可）。
 */

describe("resolveLockDecision", () => {
  it("无锁=acquire；活锁=busy；死锁=steal", () => {
    expect(resolveLockDecision(null, false)).toBe("acquire");
    expect(resolveLockDecision(12345, true)).toBe("busy");
    expect(resolveLockDecision(12345, false)).toBe("steal");
  });
});

describe("isPidAlive", () => {
  it("自身 pid 活；不存在的 pid 死", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    // pid 回绕空间内取一个几乎不可能存活的值
    expect(isPidAlive(0x7fffffff)).toBe(false);
  });
});

describe("acquire/steal/release 生命周期", () => {
  it("首次 acquire 成功写 pid；再次 acquire（同 pid 场景模拟活锁）busy；释放后可再 acquire", async () => {
    const fakeHome = await mkdtemp(path.join(tmpdir(), "connector-lock-"));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const first = await acquireInstanceLock();
      expect(first.ok).toBe(true);
      expect(await readFile(first.path, "utf8")).toBe(String(process.pid));

      // 活锁：把锁内容改成另一个活 pid（自身）→ busy
      await writeFile(first.path, String(process.pid));
      const busy = await acquireInstanceLock();
      expect(busy).toEqual({ ok: false, reason: "busy", pid: process.pid, path: first.path });

      // 死锁：内容改成死 pid → 接管
      await writeFile(first.path, "99999999");
      const stolen = await acquireInstanceLock();
      expect(stolen.ok).toBe(true);
      expect(await readFile(stolen.path, "utf8")).toBe(String(process.pid));

      // 坏内容（非数字）→ 视同无主，接管
      await writeFile(first.path, "garbage");
      const repaired = await acquireInstanceLock();
      expect(repaired.ok).toBe(true);

      // 释放只删自己的锁；删后可重新 acquire
      await releaseInstanceLock();
      expect((await readFile(first.path, "utf8").catch(() => "<gone>"))).toBe("<gone>");
      const again = await acquireInstanceLock();
      expect(again.ok).toBe(true);

      // 他人持有时不误删
      await writeFile(first.path, String(process.pid + 1));
      await releaseInstanceLock();
      expect(await readFile(first.path, "utf8")).toBe(String(process.pid + 1));
    } finally {
      process.env.HOME = prevHome;
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});
