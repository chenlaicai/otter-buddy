/**
 * F20261111slfrz：golden 采样窗口的 macOS 防睡眠断言（M-a8f8f080 定案）。
 *
 * 睡眠期间进程存活但计时器冻结，采样链（n 次 × 多跳，分钟级）撞睡眠高发窗时
 * 表现成「挂起」（golden b5 检视链曾录 3:1 卡点率）。采样前持有 caffeinate -i
 * 断言、结束后释放。
 *
 * 边界：非 darwin 平台 no-op；启动失败仅 console 警告不阻断——防睡眠是采样
 * 质量优化不是前置条件。独立于 golden.runner.ts（重 import capability boot），
 * 单测可轻量引用本模块。
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface SleepAssertion {
  release: () => void;
  /** F20261111slfrz 检视 P1：暴露持断言进程 pid（非 darwin / spawn 失败时 undefined）——
 *  测试按 pid 精确断言与清理，禁止全局 pkill/pgrep（会误杀环境中其他 caffeinate 持有方） */
  readonly holderPid?: number;
}

export function acquireSleepAssertion(): SleepAssertion {
  if (process.platform !== "darwin") return { release: () => {} };
  let child: ChildProcess | undefined;
  try {
    child = spawn("caffeinate", ["-i"], { stdio: "ignore", detached: false });
    child.on("error", (err) => {
      console.warn(`[sleep-assertion] caffeinate 启动失败（采样继续，不阻断）：${err.message}`);
      child = undefined;
    });
    console.warn("[sleep-assertion] 已持有防睡眠断言（caffeinate -i），采样结束释放");
  } catch (err) {
    console.warn(`[sleep-assertion] caffeinate 不可用（采样继续，不阻断）：${err instanceof Error ? err.message : String(err)}`);
    child = undefined;
  }
  const holderPid = child?.pid;
  return {
    holderPid,
    release: () => {
      if (child) {
        try { child.kill("SIGTERM"); } catch { /* 尽力释放 */ }
        child = undefined;
      }
    },
  };
}
