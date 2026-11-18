/**
 * 单实例锁：数据库进程互斥（云端部署阶段 6a）。
 *
 * 防止两个中枢进程同时打开同一 SQLite 数据域（issue #1868 阶段 6 红线：
 * 禁止滚动替换期间两个进程共写同一数据域）。锁文件与数据库同目录
 * （`<db-path>.otter-instance.lock`），内容为持锁进程 PID。
 *
 * 语义：
 * - 原子创建（O_WRONLY|O_CREAT|O_EXCL）成功 → 持锁
 * - 已存在且持锁 PID 存活 → 拒绝启动（列出 PID，防误杀提示）
 * - 已存在但 PID 已死（崩溃残留 stale lock）→ 接管覆写（stale 恢复）
 * - release() 幂等；进程退出钩子兜底删除（异常退出的残留走下次启动的 stale 恢复）
 */

import * as fs from "node:fs";

export interface InstanceLock {
  /** 锁文件路径（诊断用） */
  readonly lockPath: string;
  /** 释放锁（幂等；进程正常退出路径调用） */
  release: () => void;
}

/** 进程存活探测（Unix 信号 0 = 探活不发送；ESRCH = 不存在） */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function lockPathFor(dbPath: string): string {
  return `${dbPath}.otter-instance.lock`;
}

/**
 * 获取实例锁。锁被活进程持有时抛错（fail-closed）——由调用方决定退出码与提示。
 */
export function acquireInstanceLock(dbPath: string): InstanceLock {
  const lockPath = lockPathFor(dbPath);
  const pid = process.pid;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, `${pid}\n`);
      fs.closeSync(fd);
      return makeLock(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    // 锁已存在：读持锁 PID 判活（读失败/内容损坏时保持 null → 下方视同 stale 接管）
    let holderPid: number | null = null;
    try {
      const content = fs.readFileSync(lockPath, "utf-8").trim();
      const parsed = Number.parseInt(content, 10);
      holderPid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    } catch {
      // 保持 null（声明初值）：读不到内容视同 stale，走接管
    }

    if (holderPid !== null && isPidAlive(holderPid)) {
      throw new Error(
        `another otter-buddy instance is running (pid ${holderPid}${holderPid === pid ? " — same process re-entering buildApp" : ""}, lock ${lockPath}) — ` +
        "refusing to open the same data domain twice (single-writer guarantee); " +
        `stop it first (e.g. systemctl stop otter-buddy / kill ${holderPid})`,
      );
    }

    // stale（持锁进程已死/内容损坏）：删除后重试原子创建
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // 并发窗口：他人刚接管（unlink ENOENT 后重试会撞活锁并正确报错）
    }
  }
  throw new Error(`failed to acquire instance lock after stale takeover attempts: ${lockPath}`);
}

function makeLock(lockPath: string): InstanceLock {
  let released = false;
  return {
    lockPath,
    release: () => {
      if (released) return;
      released = true;
      try {
        const content = fs.readFileSync(lockPath, "utf-8").trim();
        if (Number.parseInt(content, 10) === process.pid) {
          fs.unlinkSync(lockPath);
        }
        // 内容 PID 非本进程：已被他人接管（stale 恢复竞速），不误删他人锁
      } catch {
        // 文件已不存在（异常退出清理竞速）：无事
      }
    },
  };
}

/** 文件名后缀导出供部署文档/诊断引用 */
export const INSTANCE_LOCK_SUFFIX = ".otter-instance.lock";
