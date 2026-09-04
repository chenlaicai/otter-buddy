/**
 * #460：listen() EADDRINUSE 处理测试。
 * 僵尸进程根因之三：port 冲突时走 uncaughtException → dispose 链卡住 → 僵尸。
 * 现在 listen() 挂 server 'error' handler，捕获后 process.exit(1) 干净退出。
 * process.exit mock 为 spy，避免真退出测试进程。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createServer, type AddressInfo } from "node:net";
import { Hono } from "hono";
import { listen } from "../../src/bootstrap/server";
import type { Logger } from "../../src/usecases/ports/logger";
import { createTestLogger } from "../helpers/logger";

describe("listen() 端口冲突处理（#460）", () => {
  let blocker: ReturnType<typeof createServer>;
  let port: number;
  const logger: Logger = createTestLogger();
  let exitSpy: ReturnType<typeof vi.spyOn>;
  /** 记录退出码（副作用状态断言，避免绑定 spy 调用参数；beforeAll 里注入 mock） */
  const exitCodes: Array<number | undefined> = [];

  beforeAll(async () => {
    // 先占住一个随机端口（真实占用，非 mock——EADDRINUSE 必须真发生）。
    // 注：不指定 host（绑全接口，含 IPv6 ::）——listen() 内部 serve() 默认也绑全接口，
    // 若 blocker 只绑 127.0.0.1，IPv6 侧不冲突，不会触发 EADDRINUSE。
    blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, () => resolve());
    });
    port = (blocker.address() as AddressInfo).port;
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null): never => {
      exitCodes.push(typeof code === "number" ? code : undefined);
      return undefined as never;
    }));
  });

  afterAll(() => {
    exitSpy.mockRestore();
    blocker.close();
  });

  it("端口被占时：error handler 捕获 EADDRINUSE 并干净退出（不走 uncaughtException）", async () => {
    const app = new Hono();
    const uncaught: Error[] = [];
    const onUncaught = (err: Error): undefined => {
      uncaught.push(err);
      return undefined;
    };
    process.on("uncaughtException", onUncaught);
    // 记录退出码（副作用状态断言，避免绑定 spy 调用参数）
    exitCodes.length = 0;
    try {
      // 被占端口上 listen：不应 throw（否则此处直接失败）
      listen(app, port, logger);
      // 'error' 事件是异步 emit——轮询等待退出副作用发生
      await vi.waitFor(() => {
        if (exitCodes.length === 0) throw new Error("exit not called yet");
      }, 3_000);
      expect(exitCodes).toEqual([1]); // 退出码 1 = 干净退出而非悬挂
      expect(uncaught).toEqual([]);   // 未走 uncaughtException 路径
    } finally {
      process.removeListener("uncaughtException", onUncaught);
    }
  });
});
