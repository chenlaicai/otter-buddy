/**
 * #460：dispose 超时兜底测试（bootstrap/shutdown.ts）。
 * 僵尸进程根因之一的直接防线：dispose 卡住 → 强制退出，绝不悬挂。
 * exitFn 注入记录副作用（不真退出）；断言用副作用状态而非调用参数
 * （仓规：禁止 toHaveBeenCalledWith 绑定实现细节）。
 */
import { describe, it, expect } from "vitest";
import { disposeWithTimeout } from "../../src/bootstrap/shutdown";

/** 记录型 exitFn：副作用 = 记录退出码。
 *  注（检视#808 发现 1）：生产 exitFn = process.exit，同步终止进程、不返回；
 *  测试用 throw 模拟「不返回」——race 走 reject/catch 路径，而生产直接终止（catch 不执行）。
 *  两种语义下进程都会退出，功能等价；本测试验证的是「exitFn 被调 + 退出码正确」的副作用事实，
 *  reject 语义仅是可观测载体。 */
function recordingExit(): { codes: number[]; fn: (code?: number) => never } {
  const codes: number[] = [];
  const fn = ((code?: number): never => {
    codes.push(code ?? -1);
    // 真 exitFn 不返回；测试里 throw 让 Promise.race 的 then 分支短路，
    // 模拟「退出发生」的可见行为（后续 await 不再执行）
    throw new Error(`exited:${code}`);
  }) as (code?: number) => never;
  return { codes, fn };
}

describe("disposeWithTimeout（#460 僵尸进程 dispose 超时兜底）", () => {
  it("dispose 正常完成：resolve 且不触发强制退出", async () => {
    const rec = recordingExit();
    await expect(
      disposeWithTimeout(async () => undefined, 1_000, rec.fn, 1),
    ).resolves.toBeUndefined();
    expect(rec.codes).toEqual([]); // 副作用未发生
  });

  it("dispose 悬挂：超时后强制 exit(exitCode)，不再等待清理", async () => {
    const rec = recordingExit();
    const hanging = new Promise<void>(() => { /* 永不 resolve，模拟 DB/worker 清理卡死 */ });
    const outcome = await disposeWithTimeout(() => hanging, 50, rec.fn, 1)
      .then(() => "resolved" as const)
      .catch((e: unknown) => `thrown:${(e as Error).message}` as const);
    // 超时路径 exitFn 被调（throw）→ race 整体 reject，语义=进程已退出
    expect(outcome).toBe("thrown:exited:1");
    expect(rec.codes).toEqual([1]); // 退出码 = 调用方指定
  });

  it("dispose 抛错：错误透传给调用方，不走超时路径", async () => {
    const rec = recordingExit();
    const boom = new Error("cleanup failed");
    await expect(
      disposeWithTimeout(async () => { throw boom; }, 1_000, rec.fn, 1),
    ).rejects.toBe(boom);
    expect(rec.codes).toEqual([]); // 未走到强制退出
  });

  it("exitCode 可定制：超时退出码随调用方语义", async () => {
    const rec = recordingExit();
    const hanging = new Promise<void>(() => { /* 卡死 */ });
    await disposeWithTimeout(() => hanging, 30, rec.fn, 42).catch(() => undefined);
    expect(rec.codes).toEqual([42]);
  });
});
