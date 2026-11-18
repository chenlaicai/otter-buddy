/**
 * 单实例锁测试（阶段 6a 部署底座，TCP 端口锁实现——两轮检视迭代后定稿）。
 *
 * 覆盖：获取/释放幂等、互斥拒绝（报持锁 PID 与诊断端口）、进程死亡（server
 * 关闭）即释放、释放后可重取、同进程重入拒绝、诊断文件语义。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireInstanceLock, lockPathFor, lockPortFor, INSTANCE_LOCK_SUFFIX } from "../../src/bootstrap/instance-lock";

function tmpDbPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "inst-lock-")), "otter-buddy.db");
}

describe("acquireInstanceLock（阶段 6a 单实例锁，TCP 端口互斥）", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });

  it("获取后诊断文件在数据库同目录且含本进程 PID；release 幂等", async () => {
    const dbPath = tmpDbPath();
    cleanups.push(() => rmSync(path.dirname(dbPath), { recursive: true, force: true }));
    const lock = await acquireInstanceLock(dbPath);
    expect(lock.lockPath.endsWith(INSTANCE_LOCK_SUFFIX)).toBe(true);
    expect(Number.parseInt(readFileSync(lock.lockPath, "utf-8"), 10)).toBe(process.pid);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  it("活进程持锁 → 拒绝（fail-closed，报持锁 PID 与端口诊断信息）", async () => {
    const dbPath = tmpDbPath();
    cleanups.push(() => rmSync(path.dirname(dbPath), { recursive: true, force: true }));
    const first = await acquireInstanceLock(dbPath);
    await expect(acquireInstanceLock(dbPath)).rejects.toThrow(/is holding the data domain.*port-lock/s);
    first.release();
  });

  it("持锁进程死亡（端口随 fd 关闭）→ 锁自动释放，接管零步骤无 TOCTOU", async () => {
    const dbPath = tmpDbPath();
    cleanups.push(() => rmSync(path.dirname(dbPath), { recursive: true, force: true }));
    const first = await acquireInstanceLock(dbPath);
    first.release();
    const second = await acquireInstanceLock(dbPath); // 无 stale 接管流程——直接可拿
    expect(existsSync(second.lockPath)).toBe(true);
    second.release();
  });

  it("同进程重入同样拒绝（每端口一个 listening socket）", async () => {
    const dbPath = tmpDbPath();
    cleanups.push(() => rmSync(path.dirname(dbPath), { recursive: true, force: true }));
    const first = await acquireInstanceLock(dbPath);
    await expect(acquireInstanceLock(dbPath)).rejects.toThrow(/is holding the data domain/);
    first.release();
  });

  it("端口派生确定性：同 dbPath 同端口；不同 dbPath 大概率不同段", () => {
    const p = lockPortFor("/var/lib/otter-buddy/otter-buddy.db");
    expect(p).toBeGreaterThanOrEqual(20000);
    expect(p).toBeLessThan(32768);
    expect(lockPortFor("/var/lib/otter-buddy/otter-buddy.db")).toBe(p); // 确定性
    const other = lockPortFor("/var/lib/otter-buddy/other.db");
    expect(other).toBeGreaterThanOrEqual(20000); // 值域合法（碰撞允许，可诊断）
  });

  it("lockPathFor 诊断文件路径与锁端口解耦（删文件不影响互斥——端口才是载体）", async () => {
    const dbPath = tmpDbPath();
    cleanups.push(() => rmSync(path.dirname(dbPath), { recursive: true, force: true }));
    const first = await acquireInstanceLock(dbPath);
    rmSync(lockPathFor(dbPath));
    await expect(acquireInstanceLock(dbPath)).rejects.toThrow(/is holding the data domain/);
    first.release();
  });
});
