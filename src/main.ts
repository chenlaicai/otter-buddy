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

  process.on("SIGINT", () => {
    built.dispose();
    process.exit(0);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console -- 启动失败时 logger 可能尚未就绪，兜底输出到 stderr
  console.error(`Failed to start: ${err}`);
  process.exit(1);
});
