/**
 * F20261111slfrz：防睡眠断言 helper 单测（M-a8f8f080 定案——睡眠冻结≠挂起）。
 * 轻量单测（不带 .capability 后缀，不进 capability 重配置）。
 *
 * 断言纪律（检视 P1/P2 修复）：
 * - 不用全局 pkill/pgrep——按句柄暴露的 holderPid 精确断言与清理，不误杀环境中其他 caffeinate 持有方
 * - 平台 stub 后恢复原始 descriptor（非 darwin CI 上不得残留假平台）
 * - spawn 失败路径用模块注入失败（不做 mock 调用参数/次数断言，只断言行为：句柄无害可释放）
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { acquireSleepAssertion, type SleepAssertion } from "./sleep-assertion";

/** 原始 platform 属性描述符（恢复用，不写死 darwin——非 mac CI 不得被污染） */
const PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "platform");

function stubPlatform(platform: string) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function restorePlatform() {
  if (PLATFORM_DESCRIPTOR) Object.defineProperty(process, "platform", PLATFORM_DESCRIPTOR);
}

/** 进程存活探测（pid 无效/已退出返回 false；signal 0 = 存在性检查不发信号） */
function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 本用例持有的句柄登记：断言失败中断时 afterEach 兜底释放（只 kill 自己的，不全局 pkill） */
const held: SleepAssertion[] = [];

function acquireTracked(...args: Parameters<typeof acquireSleepAssertion>): SleepAssertion {
  const a = acquireSleepAssertion(...args);
  held.push(a);
  return a;
}

describe("acquireSleepAssertion（F20261111slfrz）", () => {
  beforeAll(() => { expect(PLATFORM_DESCRIPTOR).toBeDefined(); });

  afterEach(() => {
    for (const a of held) a.release(); // 兜底释放（幂等）
    held.length = 0;
    restorePlatform();
    vi.resetModules();
    vi.doUnmock("node:child_process");
  });

  it("非 darwin 平台 no-op：无 holderPid，返回无害句柄，release 幂等不抛错", () => {
    stubPlatform("linux");
    const assertion = acquireTracked();
    expect(assertion).toBeDefined();
    expect(assertion.holderPid).toBeUndefined();
    expect(() => { assertion.release(); assertion.release(); }).not.toThrow();
  });

  it.runIf(process.platform === "darwin")(
    "darwin 真机：持断言进程按 pid 存活，release 后退出且幂等（不依赖全局 pgrep/pkill）",
    async () => {
      const assertion = acquireTracked();
      expect(assertion.holderPid).toBeGreaterThan(0);
      // 持有期间本句柄的 caffeinate 进程真实存在（行为断言：副作用按 pid 精确发生）
      expect(isPidAlive(assertion.holderPid)).toBe(true);
      assertion.release();
      // SIGTERM 传播需要一点时间
      await new Promise((r) => setTimeout(r, 500));
      expect(isPidAlive(assertion.holderPid)).toBe(false);
      expect(() => assertion.release()).not.toThrow(); // 幂等
    },
  );

  it("同步 spawn 异常不阻断：返回无 pid 的无害句柄，release 不抛错", async () => {
    stubPlatform("darwin");
    vi.doMock("node:child_process", () => ({
      spawn: () => { throw new Error("spawn EPERM（注入失败）"); },
    }));
    const { acquireSleepAssertion: acquire } = await import("./sleep-assertion");
    const assertion = acquire();
    expect(assertion.holderPid).toBeUndefined();
    expect(() => assertion.release()).not.toThrow();
  });

  it("异步 spawn error 事件不阻断：句柄 holderPid 置空语义由 release 幂等兜底", async () => {
    stubPlatform("darwin");
    let errorCallback: ((err: Error) => void) | undefined;
    vi.doMock("node:child_process", () => ({
      spawn: () => ({
        pid: 424242,
        on: (_ev: string, fn: (err: Error) => void) => { errorCallback = fn; },
        kill: () => true,
      }),
    }));
    const { acquireSleepAssertion: acquire } = await import("./sleep-assertion");
    const assertion = acquire();
    expect(assertion.holderPid).toBe(424242);
    errorCallback?.(new Error("ENOTFOUND（注入异步失败）"));
    // 异步失败后 release 不抛错（child 引用已被 error 回调清空；僵尸 pid 不 kill）
    expect(() => assertion.release()).not.toThrow();
  });
});
