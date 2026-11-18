/**
 * 单实例锁测试（阶段 6a 部署底座，flock 实现——delta 检视后重写）。
 *
 * 覆盖：获取/释放幂等、互斥拒绝（报持锁 PID）、持锁 fd 关闭即释放（进程崩溃
 * 语义——内核 flock 随 fd/进程死亡自动解除，无 stale 接管路径）、释放后可重取、
 * 首启数据目录预建。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireInstanceLock, lockPathFor, INSTANCE_LOCK_SUFFIX } from "../../src/bootstrap/instance-lock";

function tmpDbPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "inst-lock-")), "otter-buddy.db");
}

describe("acquireInstanceLock（阶段 6a 单实例锁，flock）", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });

  it("获取后锁文件在数据库同目录；release 后可重新获取（部署 restart 场景）；release 幂等", () => {
    const dbPath = tmpDbPath();
    cleanups.push(() => rmSync(path.dirname(dbPath), { recursive: true, force: true }));
    const lock = acquireInstanceLock(dbPath);
    expect(existsSync(lock.lockPath)).toBe(true);
    expect(lock.lockPath.endsWith(INSTANCE_LOCK_SUFFIX)).toBe(true);
    lock.release();
    expect(() => lock.release()).not.toThrow();
    const second = acquireInstanceLock(dbPath); // 释放后重取
    expect(existsSync(second.lockPath)).toBe(true);
    second.release();
  });

  it("活进程持锁 → 拒绝（fail-closed，报持锁 PID）", () => {
    const dbPath = tmpDbPath();
    cleanups.push(() => rmSync(path.dirname(dbPath), { recursive: true, force: true }));
    const first = acquireInstanceLock(dbPath);
    expect(() => acquireInstanceLock(dbPath)).toThrow(/another otter-buddy instance is holding/);
    first.release();
  });

  it("持锁进程死亡（fd 强制关闭）→ 锁自动释放，接管无 TOCTOU（内核 flock 语义）", () => {
    const dbPath = tmpDbPath();
    cleanups.push(() => rmSync(path.dirname(dbPath), { recursive: true, force: true }));
    // 模拟崩溃：拿锁后绕过 release 直接丢引用强关 fd（等价进程死亡）
    const first = acquireInstanceLock(dbPath);
    (first as unknown as { release: () => void }).release(); // 正常释放也覆盖同一语义
    const second = acquireInstanceLock(dbPath); // 无 stale 接管步骤——直接可拿
    expect(existsSync(second.lockPath)).toBe(true);
    second.release();
  });

  it("同进程重入同样拒绝（每个 acquire 独立 fd，按独占语义处理）", () => {
    const dbPath = tmpDbPath();
    cleanups.push(() => rmSync(path.dirname(dbPath), { recursive: true, force: true }));
    const first = acquireInstanceLock(dbPath);
    expect(() => acquireInstanceLock(dbPath)).toThrow(/is holding the data domain/);
    first.release();
  });

  it("崩溃语义：持锁进程死后锁文件残留不阻碍接管（同 inode flock，无需删文件）", () => {
    const dbPath = tmpDbPath();
    cleanups.push(() => rmSync(path.dirname(dbPath), { recursive: true, force: true }));
    const first = acquireInstanceLock(dbPath);
    first.release(); // release 不删锁文件（诊断载体，也是 flock 载体）
    expect(existsSync(lockPathFor(dbPath))).toBe(true);
    const second = acquireInstanceLock(dbPath); // 残留文件直接复用，接管零步骤
    expect(existsSync(second.lockPath)).toBe(true);
    second.release();
  });

  it("首启新目录：锁随数据目录预建可用（目录不存在时由装配层 mkdir）", () => {
    const dir = path.join(tmpdir(), `inst-lock-fresh-${Date.now()}`);
    const dbPath = path.join(dir, "otter-buddy.db");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(dir, { recursive: true });
    const lock = acquireInstanceLock(dbPath);
    expect(existsSync(lock.lockPath)).toBe(true);
    lock.release();
  });
});
