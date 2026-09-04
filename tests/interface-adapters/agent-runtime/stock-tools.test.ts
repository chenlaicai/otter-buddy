/**
 * stock-tools 单元测试——mock child_process，不真调 python。
 *
 * 覆盖：参数构造正确性、错误透传、超时路径、venv 探测优先级。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ToolContext } from "@usecases/ports/agent-tools";

// Mock child_process.spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Mock fs.existsSync
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createStockDataTool, clearAkshareCheckCache } from "@interface-adapters/agent-runtime/tools/stock-tools";

const mockSpawn = vi.mocked(spawn);
const mockExistsSync = vi.mocked(existsSync);

function createMockCtx(): ToolContext {
  return {
    currentMessageId: "msg-1",
    conversationId: "conv-1",
    otterId: "otter-1",
    client: {} as any,
  };
}

/** 创建一个可控的 mock ChildProcess */
function createMockProcess(stdout = "", stderr = "", exitCode: number | null = 0) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();

  // 异步触发 stdout/close
  setTimeout(() => {
    if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
    if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
    proc.emit("close", exitCode);
  }, 10);

  return proc;
}

describe("stock_data tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAkshareCheckCache();
    // 默认：script 存在，python 存在
    mockExistsSync.mockImplementation((p: string | Buffer | URL) => {
      const path = typeof p === 'string' ? p : p.toString();
      if (path.includes("stock-cli.py")) return true;
      if (path.includes(".venv-stock/bin/python")) return true;
      return false;
    });
  });

  it("返回错误：未知命令", async () => {
    const tool = createStockDataTool(createMockCtx());
    const result = await tool.execute("id", { command: "unknown" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("未知命令");
  });

  it("返回错误：需要 code 但未提供", async () => {
    const tool = createStockDataTool(createMockCtx());
    const result = await tool.execute("id", { command: "kline" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("需要 code 参数");
  });

  it("返回错误：code 格式非法", async () => {
    const tool = createStockDataTool(createMockCtx());
    const result = await tool.execute("id", { command: "kline", code: "abc" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("非法股票代码");
  });

  it("正确构造 kline 参数", async () => {
    const tool = createStockDataTool(createMockCtx());

    // 第一次 spawn：akshare 检查
    // 第二次 spawn：实际 kline 命令
    let spawnCalls = 0;
    mockSpawn.mockImplementation(() => {
      spawnCalls++;
      if (spawnCalls === 1) return createMockProcess("", "", 0);
      return createMockProcess(JSON.stringify({ code: "600519", data: [] }), "", 0);
    });

    const result = await tool.execute("id", { command: "kline", code: "600519", days: 30 });
    expect(result.isError).toBeFalsy();

    // 验证第二次 spawn 的参数
    const spawnArgs = mockSpawn.mock.calls[1];
    expect(spawnArgs[1]).toContain("600519");
    expect(spawnArgs[1]).toContain("--days");
    expect(spawnArgs[1]).toContain("30");
  });

  it("透传 bridge 脚本的 error 结构", async () => {
    const tool = createStockDataTool(createMockCtx());

    let spawnCalls = 0;
    mockSpawn.mockImplementation(() => {
      spawnCalls++;
      if (spawnCalls === 1) return createMockProcess("", "", 0); // akshare 检查通过
      return createMockProcess(JSON.stringify({ error: "network down" }), "", 1); // kline 错误
    });

    const result = await tool.execute("id", { command: "kline", code: "600519" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("network down");
  });

  it("northflow 不需要 code", async () => {
    const tool = createStockDataTool(createMockCtx());

    let spawnCalls = 0;
    mockSpawn.mockImplementation(() => {
      spawnCalls++;
      if (spawnCalls === 1) return createMockProcess("", "", 0);
      return createMockProcess(JSON.stringify({ count: 10, data: [] }), "", 0);
    });

    const result = await tool.execute("id", { command: "northflow" });
    expect(result.isError).toBeFalsy();

    // 验证第二次 spawn 不含 code 参数
    const spawnArgs = mockSpawn.mock.calls[1];
    expect(spawnArgs[1]).not.toContain("600519");
  });

  it("no_cache 参数透传（顶层位置，子命令之前）", async () => {
    const tool = createStockDataTool(createMockCtx());

    let spawnCalls = 0;
    mockSpawn.mockImplementation(() => {
      spawnCalls++;
      if (spawnCalls === 1) return createMockProcess("", "", 0);
      return createMockProcess(JSON.stringify({ ok: true }), "", 0);
    });

    await tool.execute("id", { command: "selftest", no_cache: true });

    // F20260904pptq：--no-cache 是 argparse 顶层参数，必须出现在子命令之前，
    // 否则 CLI 报 unrecognized arguments（旧 bug：拼在子命令后导致 no_cache=true 必报错）
    const spawnArgs = mockSpawn.mock.calls[1];
    const cliArgs = spawnArgs[1] as string[];
    expect(cliArgs).toContain("--no-cache");
    const selftestIdx = cliArgs.indexOf("selftest");
    const noCacheIdx = cliArgs.indexOf("--no-cache");
    expect(selftestIdx).toBeGreaterThan(-1);
    expect(noCacheIdx).toBeGreaterThan(-1);
    expect(noCacheIdx).toBeLessThan(selftestIdx);
  });

  it("spawn 失败返回错误", async () => {
    const tool = createStockDataTool(createMockCtx());

    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      setTimeout(() => proc.emit("error", new Error("ENOENT")), 10);
      return proc;
    });

    const result = await tool.execute("id", { command: "kline", code: "600519" });
    expect(result.isError).toBe(true);
  });

  it("venv 探测优先级：STOCK_PYTHON > .venv-stock > python3", async () => {
    const origEnv = process.env.STOCK_PYTHON;
    process.env.STOCK_PYTHON = "/custom/python";

    mockExistsSync.mockImplementation((p: string | Buffer | URL) => {
      const path = typeof p === 'string' ? p : p.toString();
      if (path.includes("stock-cli.py")) return true;
      if (path === "/custom/python") return true;
      return false;
    });

    const tool = createStockDataTool(createMockCtx());

    let spawnCalls = 0;
    mockSpawn.mockImplementation(() => {
      spawnCalls++;
      if (spawnCalls === 1) return createMockProcess("", "", 0);
      return createMockProcess(JSON.stringify({ ok: true }), "", 0);
    });

    await tool.execute("id", { command: "selftest" });

    const spawnArgs = mockSpawn.mock.calls[1];
    expect(spawnArgs[0]).toBe("/custom/python");

    if (origEnv) process.env.STOCK_PYTHON = origEnv;
    else delete process.env.STOCK_PYTHON;
  });

  it("akshare 缺失返回安装指引", async () => {
    mockSpawn.mockImplementation(() => {
      return createMockProcess("", "ModuleNotFoundError: No module named 'akshare'", 1);
    });

    const tool = createStockDataTool(createMockCtx());
    const result = await tool.execute("id", { command: "kline", code: "600519" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("akshare 未安装");
    expect(result.content[0].text).toContain("pip install akshare");
  });

  it("空输出返回超时错误", async () => {
    let spawnCalls = 0;
    mockSpawn.mockImplementation(() => {
      spawnCalls++;
      if (spawnCalls === 1) return createMockProcess("", "", 0);
      return createMockProcess("", "", null);
    });

    const tool = createStockDataTool(createMockCtx());
    const result = await tool.execute("id", { command: "kline", code: "600519" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("无输出");
  });

  // ── 港股命令测试 ──

  it("hkline：5 位代码合法", async () => {
    const tool = createStockDataTool(createMockCtx());

    let spawnCalls = 0;
    mockSpawn.mockImplementation(() => {
      spawnCalls++;
      if (spawnCalls === 1) return createMockProcess("", "", 0);
      return createMockProcess(JSON.stringify({ code: "01810", market: "HK", summary_days: 5, ohlcv: [], stats: {} }), "", 0);
    });

    const result = await tool.execute("id", { command: "hkline", code: "01810", days: 5 });
    expect(result.isError).toBeFalsy();

    // 验证 CLI 参数
    const spawnArgs = mockSpawn.mock.calls[1];
    expect(spawnArgs[1]).toContain("01810");
    expect(spawnArgs[1]).toContain("--days");
    expect(spawnArgs[1]).toContain("5");
  });

  it("hkline：6 位代码拒绝（港股需 5 位）", async () => {
    const tool = createStockDataTool(createMockCtx());
    const result = await tool.execute("id", { command: "hkline", code: "600519" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("港股代码");
  });

  it("hvaluation：5 位代码合法", async () => {
    const tool = createStockDataTool(createMockCtx());

    let spawnCalls = 0;
    mockSpawn.mockImplementation(() => {
      spawnCalls++;
      if (spawnCalls === 1) return createMockProcess("", "", 0);
      return createMockProcess(JSON.stringify({ code: "01810", market: "HK", indicators: { pe_ttm: { current: 19.3, percentile: 22.5 } } }), "", 0);
    });

    const result = await tool.execute("id", { command: "hvaluation", code: "01810" });
    expect(result.isError).toBeFalsy();

    // hvaluation 不需要 days/adjust 等参数
    const spawnArgs = mockSpawn.mock.calls[1];
    expect(spawnArgs[1]).toContain("01810");
    expect(spawnArgs[1]).not.toContain("--days");
  });

  it("hvaluation：缺 code 返回错误", async () => {
    const tool = createStockDataTool(createMockCtx());
    const result = await tool.execute("id", { command: "hvaluation" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("需要 code 参数");
  });
});
