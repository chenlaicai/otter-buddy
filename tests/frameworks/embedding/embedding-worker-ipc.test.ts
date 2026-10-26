/**
 * F20261026emct：worker IPC 发送防护单测。
 *
 * 场景：父进程已死/IPC 已关时 process.send 抛 EPIPE——postResponse 必须
 * 受控退出（warn + exit(1)）而不是 uncaught 杀进程（10-23 实锤的
 * libc++abi mutex lock failed 崩溃形态）。
 *
 * 测试方式：vitest worker 内替换 process.send 为 throw 版本，断言 exit 被调。
 * 不真杀测试进程——exit 用 mock 拦截。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { postResponse } from "../../../src/frameworks/embedding/embedding-worker-ipc";

describe("postResponse（F20261026emct IPC 防护）", () => {
  const originalSend = process.send;
  afterEach(() => {
    process.send = originalSend;
  });

  it("send 正常时不退出", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    process.send = (() => true) as never;
    postResponse({ type: "result", embedding: new Float32Array(1), id: 1 });
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("send 抛 EPIPE（IPC 已关）→ warn + exit(1) 自我了断，不 uncaught", () => {
    let exitCode: number | undefined;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      return undefined as never;
    }) as never);
    const epipe = new Error("process.send EPIPE");
    process.send = (() => { throw epipe; }) as never;
    postResponse({ type: "result", embedding: new Float32Array(1), id: 2 });
    // 副作用断言：退出码 1（让父进程看门狗接管重启，不留半死 worker）
    expect(exitCode).toBe(1);
    exitSpy.mockRestore();
  });

  it("send 返回 false（背压）→ 不是错误，正常返回", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    process.send = (() => false) as never;
    postResponse({ type: "result", embedding: new Float32Array(1), id: 3 });
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
