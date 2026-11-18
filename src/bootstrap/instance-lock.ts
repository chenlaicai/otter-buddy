/**
 * 单实例锁：数据库进程互斥（云端部署阶段 6a）。
 *
 * 防止两个中枢进程同时打开同一 SQLite 数据域（阶段 6 红线：禁止两个进程共写）。
 * 实现用 TCP 端口 bind 做内核级互斥（Unix daemon 惯用法）：对由 dbPath 确定性
 * 派生的回环端口 listen——同一数据域派生同一端口，第二个进程 EADDRINUSE 即拒绝。
 *
 * 为什么不是文件锁：轮替过两版均被实证否决——
 * - O_EXCL 文件锁：stale 接管（read 判活→unlink→重建）非原子，并发 stale 观察
 *   下存在双持锁 TOCTOU 窗口（首轮检视 major）；
 * - flock（fs-ext 原生模块）：内核语义无竞速，但实测在目标 ECS 上三重摩擦——
   安装必编译（非 prebuilt）、双 node 并存导致 install script 用错 ABI、node-gyp
 *  headers 下载被网络环境阻断（delta 检视 major + 真机实证）。
 * TCP 端口 bind 三者全占：内核仲裁（listen 原子）、进程死亡 fd 自动释放（无
 * stale 接管路径）、纯 Node 零依赖（无部署摩擦）。
 *
 * 锁文件 `<db-path>.otter-instance.lock`（内容=持锁进程 PID）仅作诊断展示
 * （「谁在跑」），不参与互斥判定。端口派生：FNV-1a(dbPath) 映射到
 * 20000-39999 段——不同数据域互不冲突，碰撞（概率 ~1/20000）时错误信息
 * 可直接诊断。
 */

import * as net from "node:net";
import * as fs from "node:fs";

export interface InstanceLock {
  /** 诊断锁文件路径（互斥载体是端口，文件仅展示持锁 PID） */
  readonly lockPath: string;
  /** 释放锁（幂等；正常退出路径调用；进程崩溃由内核关闭 socket 自动释放） */
  release: () => void;
}

export const INSTANCE_LOCK_SUFFIX = ".otter-instance.lock";
/** 端口段：20000-32767（三轮检视后收敛：避开 Linux 默认临时端口段 32768-60999，
 *  消除 TIME_WAIT 误判 EADDRINUSE 的可能） */
const PORT_RANGE_BASE = 20000;
const PORT_RANGE_SPAN = 12768;

export function lockPathFor(dbPath: string): string {
  return `${dbPath}${INSTANCE_LOCK_SUFFIX}`;
}

/** FNV-1a 32 位——确定性、跨平台稳定（不用 hash 哈希因 node 版本 seed 不稳） */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** dbPath → 互斥端口（导出供诊断/测试：运维可据此查端口占用） */
export function lockPortFor(dbPath: string): number {
  return PORT_RANGE_BASE + (fnv1a(dbPath) % PORT_RANGE_SPAN);
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
 * 获取实例锁：listen 派生端口（exclusive 独占）——被任何活进程持有时抛错
 * （fail-closed）。内核 TCP 栈仲裁：两个进程同时 bind，恰好一个成功。
 * 同进程重复调用同样拒绝（每端口每进程一个 listening socket）。
 * 异步：listen 回调后持锁才算成立（打开数据库前 await 完成）。
 */
export function acquireInstanceLock(dbPath: string): Promise<InstanceLock> {
  const lockPath = lockPathFor(dbPath);
  const port = lockPortFor(dbPath);

  const server = net.createServer();
  server.unref(); // 不阻止进程正常退出（锁随进程生命周期；显式 release 更早释放）

  let released = false;
  return new Promise<InstanceLock>((resolve, reject) => {
    const fail = (err: Error): void => {
      const holder = readHolderPid(lockPath);
      reject(new Error(
        `another otter-buddy instance is holding the data domain${holder ? ` (pid ${holder})` : ""} — ` +
        `port-lock ${port} on 127.0.0.1 already bound, lock file ${lockPath} — ` +
        "refusing to open it twice (single-writer guarantee); " +
        "stop the other instance first (e.g. systemctl stop otter-buddy)" +
        (holder ? `; if pid ${holder} is stale, check: ss -tlnp | grep :${port}` : ""),
        { cause: err },
      ));
    };
    server.once("error", fail);
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.removeListener("error", fail);
      // 诊断文件仅持锁成功后写入（三轮检视发现：写在 listen 前会被失败进程覆写，
      // 报错对象变成自己——互斥不受影响但诊断关失真）
      try {
        fs.writeFileSync(lockPath, `${process.pid}\n`);
      } catch {
        // 诊断载体写不进（如只读目录）——互斥仍由端口保证
      }
      resolve({
        lockPath,
        release: () => {
          if (released) return;
          released = true;
          server.close(); // close 即释放端口（幂等：重复 close 无害）
        },
      });
    });
  });
}
