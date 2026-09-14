/**
 * #460：进程关闭的 dispose 超时兜底。
 * 根因：SIGTERM handler await dispose()——任一 async 清理（DB/worker/metric flush）卡住
 * 就永远到不了 process.exit()，进程"杀不死"，必须 kill -9（僵尸进程根因之一）。
 *
 * 语义：只兜超时——超时调 exitFn(exitCode) 强制退出；dispose 抛错原样透传，
 * 由调用方按原有语义处理（graceful 场景 log 后继续退出，异常场景退出码 1）。
 *
 * exitFn 注入（默认 process.exit）：测试传 spy，避免真退出测试进程。
 */

export type ExitFn = (code?: number) => never;

/** dispose 带超时兜底。resolve = dispose 正常完成；reject = dispose 抛错（透传）。 */
export function disposeWithTimeout(
  dispose: () => Promise<void>,
  timeoutMs: number,
  exitFn: ExitFn,
  exitCode = 1,
): Promise<void> {
  const timeout = new Promise<"timeout">((resolve) => {
    // 兜底 timer 自身 unref：不引入新的退出阻塞
    const t = setTimeout(() => resolve("timeout"), timeoutMs);
    t.unref?.();
  });
  return Promise.race([
    dispose(),
    timeout.then(() => {
      exitFn(exitCode); // 超时：强制退出（exitFn 默认 process.exit，不返回）
    }),
  ]);
}
