/**
 * F20260922slan V2：wait 工具行为测试。
 *
 * 验证方案「L2：wait 工具」execute 实现：
 * - seconds ∈ [5,600]（<5 / >600 拒绝）
 * - 带 until 时 seconds ≤ 560（D6 预算裕量；561 拒绝）
 * - until 过 checkBashCommandSafety 主链（命中即拒绝并透传拦截文案，S1）
 * - until 禁元字符/单双引号（A1/D4③）
 * - until 非零 exit 返回错误文本不抛错（exit code + stderr 截断返回）
 * - 回显 reason / 缺省附轻提示（A2）
 * - 注册进全獭工具集
 *
 * execFile mock（同 merge-pr-tool.test.ts 模式）：until 的 execFileAsync 经 vi.mock 替换。
 * sleep 用 fake timers 推进（wait 工具内 setTimeout）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToolContext } from "@usecases/ports/agent-tools";

const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";

function makeCtx(): ToolContext {
  return {
    client: {},
    otterId: "otter-1",
    conversationId: "conv-1",
    currentMessageId: "msg-1",
  } as unknown as ToolContext;
}

function findWait() {
  const tool = createTools(makeCtx(), undefined, undefined).find((t) => t.name === "wait");
  expect(tool, "wait 应注册进全獭工具集").toBeDefined();
  return tool!;
}

/** 推进 wait 工具内的 setTimeout（seconds 秒）后返回 execute promise 结果 */
async function runWait(tool: ReturnType<typeof findWait>, params: Record<string, unknown>) {
  const execPromise = tool.execute("t1", params);
  // 让 execute 走到 await setTimeout（微任务冲刷）
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(600_000);
  return execPromise;
}

describe("F20260922slan wait 工具", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("seconds=5 边界正常返回 + 回显 reason", async () => {
    const tool = findWait();
    const result = await runWait(tool, { seconds: 5, reason: "等 CI 跑完" });
    const text = result.content[0].text;
    expect(text).toContain("等待原因：等 CI 跑完");
    expect(text).toContain("已等待 5 秒");
  });

  it("seconds=3 拒绝（<5 搭档无感）", async () => {
    const tool = findWait();
    const result = await tool.execute("t1", { seconds: 3 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("5-600");
  });

  it("seconds=601 拒绝（>600 per-event 熔断窗）", async () => {
    const tool = findWait();
    const result = await tool.execute("t1", { seconds: 601 });
    expect(result.isError).toBe(true);
  });

  it("带 until 时 seconds=561 拒绝（D6 预算裕量：>560）", async () => {
    const tool = findWait();
    const result = await tool.execute("t1", { seconds: 561, until: "gh pr checks" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("560");
  });

  it("带 until 时 seconds=560 边界放行", async () => {
    const tool = findWait();
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "pass\n", stderr: "" });
    });
    const result = await runWait(tool, { seconds: 560, until: "gh pr checks" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("苏醒检查");
  });

  it("until 含管道 `|` 拒绝（禁 shell 元字符）", async () => {
    const tool = findWait();
    const result = await tool.execute("t1", { seconds: 10, until: "gh pr checks | grep pending" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("管道");
  });

  it("until 含单引号拒绝（D4③ 引号显式拒绝）", async () => {
    const tool = findWait();
    const result = await tool.execute("t1", { seconds: 10, until: "sh -c 'echo hi'" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("引号");
  });

  it("until 命中守卫（rm -rf data/x）拒绝并透传拦截文案（S1 绕守卫防线封堵）", async () => {
    const tool = findWait();
    const result = await tool.execute("t1", { seconds: 10, until: "rm -rf data/metrics" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("安全守卫拦截");
    expect(result.content[0].text).toContain("data/");
  });

  it("until 非零 exit 返回错误文本不抛错（exit code + stderr，A1 失败路径）", async () => {
    const tool = findWait();
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
      const err = new Error("command failed") as Error & { code: number; stderr: string };
      err.code = 2;
      err.stderr = "some stderr detail";
      cb(err, { stdout: "", stderr: "some stderr detail" });
    });
    const result = await runWait(tool, { seconds: 5, until: "gh pr checks" });
    // 不抛错——错误文本返回
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("未通过");
    expect(text).toContain("exit code 2");
    expect(text).toContain("some stderr detail");
  });

  it("缺 reason 附轻提示（A2 牵引力，不增强制）", async () => {
    const tool = findWait();
    const result = await runWait(tool, { seconds: 5 });
    const text = result.content[0].text;
    expect(text).toContain("未填");
    expect(text).toContain("无交代的等待");
    expect(text).toContain("已等待 5 秒");
  });

  it("until 命令执行成功把输出返回（苏醒检查「好了」路径）", async () => {
    const tool = findWait();
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "CI pass\n", stderr: "" });
    });
    const result = await runWait(tool, { seconds: 5, until: "gh pr checks", reason: "等 CI" });
    const text = result.content[0].text;
    expect(text).toContain("苏醒检查");
    expect(text).toContain("CI pass");
  });
});
