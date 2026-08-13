/**
 * 生产入口（薄 shim）。全部装配逻辑在 ./app.ts 的 buildApp()。
 * 本文件只做：创建 logger → buildApp → listen → SIGINT 清理。
 */
import { buildApp, createLogger } from "./app";
import { listen } from "./bootstrap/server";

async function main(): Promise<void> {
  const logger = createLogger("./data/logs");
  const built = await buildApp({ logger });
  listen(built.app, built.config.server.port, logger);

  // ── 进程级安全网：最后一道防线，防止未处理异常/rejection 导致进程裸死 ──

  /** 优雅关闭：SIGINT / SIGTERM 统一走 dispose → exit。
   *  async 以确保 metric flush 等 async 清理在 process.exit 前完成。 */
  const gracefulShutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully…`);
    try {
      await built.dispose();
    } catch (err) {
      logger.error("dispose failed during graceful shutdown", err instanceof Error ? err : undefined);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
  process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });

  /**
   * uncaughtException：Node.js 官方建议在 handler 中同步 flush 日志后退出，
   * 因为进程状态可能已损坏。不要尝试"忽略继续跑"。
   */
  process.on("uncaughtException", async (err: Error) => {
    logger.error("uncaughtException — 进程将退出", err, { stack: err.stack });
    try { await built.dispose(); } catch { /* dispose 失败不阻塞退出 */ }
    process.exit(1);
  });

  /**
   * unhandledRejection：log + 退出。Node.js 未来版本默认行为就是 exit(1)，
   * 现在显式处理避免静默丢失错误。
   */
  process.on("unhandledRejection", async (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error("unhandledRejection — 进程将退出", err, { stack: err.stack });
    try { await built.dispose(); } catch { /* dispose 失败不阻塞退出 */ }
    process.exit(1);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console -- 启动失败时 logger 可能尚未就绪，兜底输出到 stderr
  console.error(`Failed to start: ${err}`);
  process.exit(1);
});
