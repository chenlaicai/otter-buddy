/**
 * F20261023emct：embedding worker 的 IPC 发送防护。
 *
 * 背景：bge-m3-worker.ts 的 post() 直接 process.send?.(msg)，无 try/catch——
 * 父进程死亡/disconnect 与最后一次 send 竞态时 send 同步抛 EPIPE，
 * uncaught 异常以非预期姿势杀 worker（2026-10-23 实锤：libc++abi mutex
 * lock failed 崩溃栈，F20261015kill 的 SIGKILL 隔离没盖住 send 路径）。
 *
 * 防护语义：
 * - send 抛错（IPC 已关）→ warn 一条受控日志 + process.exit(1) 自我了断，
 *   让父进程侧看门狗/重启逻辑按正常 exit 路径处理，不留半死 worker。
 * - send 返回 false（背压，channel 缓冲满）→ 不是错误，正常返回（Node 会
 *   自行 flush，worker 无需处理）。
 *
 * 独立模块（而非 worker 文件内联函数）：worker 文件是 fork 入口（顶层加载
 * 模型 + 无 process.send 即 throw），vitest 无法 import；拆出后本模块零副作用
 * 可单测（tests/frameworks/embedding/embedding-worker-ipc.test.ts）。
 */
import type { EmbedResponse } from "./embedding-protocol";

export function postResponse(msg: EmbedResponse): void {
  try {
    process.send?.(msg);
  } catch (err) {
    // eslint-disable-next-line no-console -- worker 子进程内无 logger，console.warn 兜底
    console.warn(
      `[embedding-worker] IPC send failed (parent gone?), exiting: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // 自我了断而非 uncaught：exit(1) 让父进程把本次 exit 当 worker 意外退出处理
    // （handleWorkerExit → reject pending + 重建），不留半死状态。
    process.exit(1);
  }
}
