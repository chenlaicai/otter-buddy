/**
 * （执行通道）：connector 单实例锁
 *
 * 双击启动器让「同设备误开第二个实例」成为高概率路径；hub 侧同 device 顶替语义
 * （openOnlineSession 顶替旧行 + 旧 sid 心跳失效判死重连）会让两个实例互踢进入
 * 重连风暴——谁都上不了线还刷日志。本锁用 ~/.otter/connector/instance.lock（内容
 * = pid）做 best-effort 单飞：已活实例在场 → 明确退出（人看得懂）；持锁进程已死
 * （崩溃残留）→ 接管。不是安全边界（锁可被人为删除），是 UX 自保护。
 */

import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/** 锁目录：与 device.json 同目录（~/.otter/connector/） */
export async function instanceLockPath(): Promise<string> {
  const dir = path.join(os.homedir(), ".otter", "connector");
  await mkdir(dir, { recursive: true });
  return path.join(dir, "instance.lock");
}

/** 锁决策（纯函数，可测）：acquire=新建 / steal=接管死锁 / busy=已有活实例 */
export function resolveLockDecision(existingPid: number | null, existingPidAlive: boolean): "acquire" | "steal" | "busy" {
  if (existingPid === null) return "acquire";
  return existingPidAlive ? "busy" : "steal";
}

/** pid 存活探测：signal 0 探测；EPERM 视为存活（进程在但属他人——保守）。 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type AcquireResult =
  | { ok: true; path: string; pid: number }
  | { ok: false; reason: "busy"; pid: number; path: string };

/** 获取单实例锁。busy 时返回活实例 pid（调用方打印人话退出）。 */
export async function acquireInstanceLock(): Promise<AcquireResult> {
  const lockPath = await instanceLockPath();
  const myPid = process.pid;
  // O_EXCL 原子创建：多数路径一次到位
  try {
    const handle = await open(lockPath, "wx");
    await writeFile(handle, String(myPid), "utf8");
    await handle.close();
    return { ok: true, path: lockPath, pid: myPid };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  // 已有锁：读 pid → 判活 → 接管或退出（读失败/解析失败视同无主锁——接管）
  let existingPid: number | null;
  try {
    const text = (await readFile(lockPath, "utf8")).trim();
    const parsed = Number.parseInt(text, 10);
    existingPid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    existingPid = null;
  }
  const decision = resolveLockDecision(existingPid, existingPid !== null && isPidAlive(existingPid));
  if (decision === "busy") {
    return { ok: false, reason: "busy", pid: existingPid as number, path: lockPath };
  }
  await writeFile(lockPath, String(myPid), "utf8");
  return { ok: true, path: lockPath, pid: myPid };
}

/** 释放锁（优雅退出路径调用；崩溃残留由下一次启动的接管逻辑兜底）。best-effort：
 *  只删自己的锁（内容校验），不误删他人接管后的锁。 */
export async function releaseInstanceLock(): Promise<void> {
  try {
    const lockPath = await instanceLockPath();
    const text = (await readFile(lockPath, "utf8")).trim();
    if (text === String(process.pid)) await rm(lockPath, { force: true });
  } catch {
    // 释放失败不影响退出语义（下次启动接管）
  }
}
