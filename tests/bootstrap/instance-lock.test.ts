/**
 * 单实例锁测试（阶段 6a 部署底座）。
 *
 * 覆盖：获取/释放幂等、活锁拒绝（fail-closed + 报持锁 PID）、
 * stale 锁接管（崩溃残留）、release 后可重新获取。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireInstanceLock, lockPathFor, INSTANCE_LOCK_SUFFIX } from "../../src/bootstrap/instance-lock";

function tmpDbPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "inst-lock-")), "otter-buddy.db");
}

describe("acquireInstanceLock（阶段 6a 单实例锁）", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });

  it("获取后锁文件在数据库同目录；release 删除；release 幂等", () => {
    const dbPath = tmpDbPath();
    cleanups.push(() => rmSync(path.dirname(dbPath), { recursive: true, force: true }));
    const lock = acquireInstanceLock(dbPath);
    expect(existsSync(lock.lockPath)).toBe(true);
    expect(lock.lockPath.endsWith(`${INSTANCE_LOCK_SUFFIX}`)).toBe(true);
    expect(lock.lockPath.startsWith(path.dirname(dbPath))).toBe(true);
    lock.release();
    expect(existsSync(lock.lockPath)).toBe(false);
    expect(() => lock.release()).not.toThrow();
  });

  it("活进程持锁 → 拒绝（fail-closed，报持锁 PID）", () => {
    const dbPath = tmpDbPath();
    cleanups.push(() => rmSync(path.dirname(dbPath), { recursive: true, force: true }));
    const first = acquireInstanceLock(dbPath);
    expect(() => acquireInstanceLock(dbPath)).toThrow(/another otter-buddy instance is running/);
    first.release();
  });

  it("stale 锁（持锁 PID 已死）→ 接管覆写", () => {
    const dbPath = tmpDbPath();
    cleanups.push(() => rmSync(path.dirname(dbPath), { recursive: true, force: true }));
    // 伪造崩溃残留：PID 4194303 是 Linux 上限附近的保留值（无此进程）
    writeFileSync(lockPathFor(dbPath), "4194303\n");
    const lock = acquireInstanceLock(dbPath);
    expect(existsSync(lock.lockPath)).toBe(true);
    lock.release();
  });

  it("锁内容损坏（非 PID 文本）→ 视同 stale 接管", () => {
    const dbPath = tmpDbPath();
    cleanups.push(() => rmSync(path.dirname(dbPath), { recursive: true, force: true }));
    writeFileSync(lockPathFor(dbPath), "not-a-pid");
    const lock = acquireInstanceLock(dbPath);
    expect(existsSync(lock.lockPath)).toBe(true);
    lock.release();
  });

  it("release 后可重新获取（部署 restart 场景）", () => {
    const dbPath = tmpDbPath();
    cleanups.push(() => rmSync(path.dirname(dbPath), { recursive: true, force: true }));
    acquireInstanceLock(dbPath).release();
    const second = acquireInstanceLock(dbPath);
    expect(existsSync(second.lockPath)).toBe(true);
    second.release();
  });
});
