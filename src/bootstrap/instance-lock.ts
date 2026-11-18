/**
 * 单实例锁：数据库进程互斥（云端部署阶段 6a）。
 *
 * 防止两个中枢进程同时打开同一 SQLite 数据域（阶段 6 红线：禁止两个进程共写）。
 * 实现用内核级 flock（fs-ext）：互斥由内核仲裁，无 userspace TOCTOU；
 * 持锁 fd 生命周期 = 进程生命周期——进程崩溃即锁自动释放，天然无 stale
 * 接管问题（delta 检视处置：文件锁的 read-判活-unlink-重建三步在并发 stale
 * 观察下存在双持锁窗口，flock 从机制上消灭该窗口）。
 *
 * 锁文件 `<db-path>.otter-instance.lock` 内容为持锁进程 PID，仅作诊断展示
 * （「谁在跑」），不参与互斥判定（互斥唯一依据 = 内核 flock 状态）。
 */

import * as fs from "node:fs";
import * as fsExt from "fs-ext";

export interface InstanceLock {
  /** 锁文件路径（诊断用） */
  readonly lockPath: string;
  /** 释放锁（幂等；正常退出路径调用；进程崩溃由内核自动释放） */
  release: () => void;
}

export const INSTANCE_LOCK_SUFFIX = ".otter-instance.lock";

export function lockPathFor(dbPath: string): string {
  return `${dbPath}${INSTANCE_LOCK_SUFFIX}`;
}

/** 尽力而为读取持锁 PID（诊断信息；读不到返回 null 不影响互斥判定） */
function readHolderPid(lockPath: string): number | null {
  try {
    const parsed = Number.parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 获取实例锁：对锁文件 flock 独占非阻塞——已被任何活进程持有时抛错（fail-closed）。
 * 内核仲裁保证原子性：两个进程同时抢，恰好一个成功，无竞速窗口。
 * 同进程重复调用同样拒绝（flock 对同进程新 fd 也按内核语义独占——macOS/Linux
 * 对 fork 出的 fd 有继承细节，此处语义按「每个 acquire 一个新 fd」保守处理）。
 */
export function acquireInstanceLock(dbPath: string): InstanceLock {
  const lockPath = lockPathFor(dbPath);
  // 锁文件不存在则创建（内容尽力写本进程 PID；写失败不影响互斥）。
  // 运维边界：持锁期间删除锁文件 = 显式破坏互斥（新文件=新 inode，旧 flock 失效）
  // ——正常生命周期（含崩溃重启）从不删它，stale 接管走同 inode flock 无需删除。
  const fd = fs.openSync(lockPath, "a");
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, `${process.pid}\n`);
    fsExt.flockSync(fd, "exnb");
  } catch (err) {
    fs.closeSync(fd);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EACCES") {
      const holder = readHolderPid(lockPath);
      throw new Error(
        `another otter-buddy instance is holding the data domain${holder ? ` (pid ${holder})` : ""}, lock ${lockPath} — ` +
        "refusing to open it twice (single-writer guarantee); " +
        "stop the other instance first (e.g. systemctl stop otter-buddy)",
        { cause: err },
      );
    }
    throw err;
  }

  // 自证（独立于上 try/catch）：fd 的 inode 仍是路径上的 inode——防「锁文件被重建后
  // 拿到无人争的假锁」（flock 绑定 inode，文件被删重建则旧锁对新路径失效）。
  const held = fs.fstatSync(fd);
  const onPath = fs.statSync(lockPath);
  if (held.ino !== onPath.ino) {
    fs.closeSync(fd);
    throw new Error(`lock file replaced during acquisition: ${lockPath}`);
  }

  let released = false;
  return {
    lockPath,
    release: () => {
      if (released) return;
      released = true;
      try {
        fsExt.flockSync(fd, "un");
      } finally {
        fs.closeSync(fd); // 释放语义：解锁 + 关 fd 双保险（关 fd 本身也会释放 flock）
      }
    },
  };
}
