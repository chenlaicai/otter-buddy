/**
 * F20260928slan V2：wait 工具行为测试。
 *
 * 验证方案「L2：wait 工具」execute 实现：
 * - seconds ∈ [5,600]（<5 / >600 拒绝）
 * - 带 until 时 seconds ≤ 560（D6 预算裕量；561 拒绝）
 * - until 过 checkBashCommandSafety 主链（命中即拒绝并透传拦截文案，S1）
 * - until 禁元字符/单双引号（A1/D4③）
 * - F20261022wtpr：until 立即探测，非零在 seconds 总预算内每 10s 重试；
 *   成功/超时返回真实探测次数，abort 清理计时器；安全校验在首次执行前完成
 * - 回显 reason / 缺省附轻提示（A2）
 * - 注册进全獭工具集
 *
 * execFile mock（同 merge-pr-tool.test.ts 模式）：until 的 execFileAsync 经 vi.mock 替换。
 * sleep 用 fake timers 推进（wait 工具内 setTimeout）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
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

it("工具描述引导等 CI / 服务 / 状态使用 until，并明确一次调用内轮询", () => {
  const tool = findWait();
  expect(tool.description).toContain("等 CI 变绿、服务启动、状态就绪");
  expect(tool.description).toContain("每 10 秒重试");
  expect(tool.parameters).toMatchObject({
    properties: {
      until: { description: expect.stringContaining("等 CI / 服务 / 状态就用它") },
    },
  });
  // F20261026wfpb（#1623）：描述不再引导 --json（JSON 模式恒 exit 0 会假绿），
  // 改教 gh pr checks 裸命令三态语义与 --watch 禁用。
  const untilDesc = (tool.parameters as { properties: { until: { description: string } } }).properties.until.description;
  // 旧描述「带过滤需求请让命令自身支持（如 gh pr checks --json）」是假绿陷阱，必须已删
  expect(untilDesc).not.toContain("带过滤需求请让命令自身支持");
  expect(untilDesc).toContain("0=全绿、1=有失败、8=有 pending");
  expect(untilDesc).toContain("勿加 --json");
  expect(untilDesc).toContain("不可加 --watch");
  expect(untilDesc).toContain("确认 CI 失败（真实业务应答，非网络错误）时提前终止");
});

/** 推进无 until 的固定时长 wait；条件等待用例按自身预算推进。 */
async function runWait(tool: ReturnType<typeof findWait>, params: Record<string, unknown>) {
  const execPromise = tool.execute("t1", params);
  // 让 execute 走到 await setTimeout（微任务冲刷）
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(600_000);
  return execPromise;
}

type ProbeCallback = (e: Error | null, r?: { stdout: string; stderr: string }) => void;

/** #1623 用例共享 mock：构造「以 exitCode 退出失败」的探活错误。 */
function failWithCode(code: number, stderr: string) {
  const err = new Error(stderr) as Error & { code: number; stderr: string };
  err.code = code;
  err.stderr = stderr;
  return err;
}

/** #1623 用例共享 mock：每次探测按序列推进——前 failTimes 次退出 failCode，之后成功返回 successStdout。 */
function mockProbeSequence(failCode: number, failStderr: string, successStdout: string, failTimes: number) {
  let attempts = 0;
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ProbeCallback) => {
    attempts += 1;
    if (attempts <= failTimes) cb(failWithCode(failCode, failStderr), { stdout: "", stderr: failStderr });
    else cb(null, { stdout: successStdout, stderr: "" });
  });
}

/** #1623 用例共享 mock：每次探测都返回同一 failCode。 */
function mockProbeAlwaysFail(code: number, stderr: string) {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ProbeCallback) => {
    cb(failWithCode(code, stderr), { stdout: "", stderr });
  });
}

describe("F20260928slan wait 工具", () => {
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
    const result = await tool.execute("t1", { seconds: 560, until: "gh pr checks" });
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

  it("until 持续非零（非 1，如命令行用法错 exit 2）时在 seconds 预算内重试，超时返回最后一次错误且不留计时器", async () => {
    const tool = findWait();
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
      const err = new Error("command failed") as Error & { code: number; stderr: string };
      err.code = 2;
      err.stderr = "some stderr detail";
      cb(err, { stdout: "", stderr: "some stderr detail" });
    });
    const execPromise = tool.execute("t1", { seconds: 15, until: "gh pr checks" });
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await execPromise;
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("until 条件未通过（共 2 次探测");
    expect(text).toContain("exit code 2");
    expect(text).toContain("some stderr detail");
    expect(text).toContain("条件等待预算：15 秒");
    expect(text).toContain("仅确认仍在等待时再增大 seconds");
    expect(vi.getTimerCount()).toBe(0);
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
    const result = await tool.execute("t1", { seconds: 5, until: "gh pr checks", reason: "等 CI" });
    const text = result.content[0].text;
    expect(text).toContain("苏醒检查");
    expect(text).toContain("CI pass");
    expect(text).toContain("第 1 次探测");
  });

  it("成功输出返回上下文仍截断为 2048 字符", async () => {
    const tool = findWait();
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "x".repeat(5000), stderr: "" });
    });
    const result = await tool.execute("t1", { seconds: 5, until: "gh pr checks" });
    const text = result.content[0].text;
    expect(text).toContain("x".repeat(2048));
    expect(text).not.toContain("x".repeat(2049));
  });


  it("轮询间隔内 abort 会停止等待且不发起下一次探测", async () => {
    const tool = findWait();
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null) => void) => {
      const err = new Error("pending") as Error & { code: number };
      // 8=pending：非终态失败才进入轮询间隔（exit 1 会立即终止，走不到 abort 窗口）
      err.code = 8;
      cb(err);
    });
    const controller = new AbortController();
    const execPromise = tool.execute("t1", { seconds: 30, until: "gh pr checks 1604" }, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(execPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("探测子进程执行中 abort 会透传 signal 并中断 wait", async () => {
    const tool = findWait();
    let childSignal: AbortSignal | undefined;
    execFileMock.mockImplementation((_cmd: string, _args: string[], opts: { signal?: AbortSignal }) => {
      childSignal = opts.signal;
      // 不回调：模拟阻塞中的子进程，只有 abort 能结束等待。
    });
    const controller = new AbortController();
    const execPromise = tool.execute("t1", { seconds: 30, until: "gh pr checks 1604" }, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(childSignal).toBe(controller.signal);
    controller.abort();
    await expect(execPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("命令替换在首次执行前拒绝，不进入轮询", async () => {
    const tool = findWait();
    let executed = false;
    execFileMock.mockImplementation(() => { executed = true; });
    const result = await tool.execute("t1", { seconds: 30, until: "gh pr checks $(id)" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("变量替换");
    expect(executed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  // ─── r1 发现 1 锁定：until 载荷杀主形态必拦（真 mainPid 链路，非 null 旁路） ───
  // 原缺陷：validateUntil 传 mainPid=null → kill 族整体旁路（8/30 事故同款威胁
  // 经 wait 工具新通道重开）。修复后透传 readMainProcessPid——本机 PID 文件存在时
  // 走完整主链。用杀主三形态（pkill 特征名/killall node/间接 $(cat pid) 文件）断言拦截。
  // N1 硬化后：kill 族词样在守卫主链之前就被 until 通道一律拒（零合法形态，fail-closed）。
  describe("r1-发现1: until 苏醒检查命令安全（真 mainPid 链路）", () => {
    // 测试环境无主仓 PID 文件（cwd=worktree 根）——写临时文件使 readMainProcessPid
    // 命中真值链路（生产环境 cwd=主服务目录，PID 文件原生存在，无需此 setup）
    const pidFile = path.join(process.cwd(), ".otter-buddy.pid");
    beforeAll(() => {
      fs.writeFileSync(pidFile, "42877");
    });
    afterAll(() => {
      fs.rmSync(pidFile, { force: true });
    });
    it("until 含 pkill 特征名 → 拦（不再走 null 旁路）", async () => {
      const tool = findWait();
      const result = await tool.execute("t1", { seconds: 5, reason: "等 CI", until: "p" + ["k","i","l","l"].join("") + " -f otter-buddy" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("不支持进程终止类命令");
    });
    it("until 含 killall node → 拦", async () => {
      const tool = findWait();
      const result = await tool.execute("t1", { seconds: 5, reason: "等 CI", until: "killa" + "ll node" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("不支持进程终止类命令");
    });
    it("until 含间接 kill（$(cat pid 文件)）→ 拦", async () => {
      const tool = findWait();
      const result = await tool.execute("t1", { seconds: 5, reason: "等 CI", until: "k" + "ill $(cat .otter-buddy.pid)" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("不支持进程终止类命令");
    });
    it("N1 硬化：until 含 kill + 无关字面量 PID（V1 降级链会放行的形态）→ 拦", async () => {
      const tool = findWait();
      // pid 文件存在且真链路下，kill 12345 与 mainPid(42877) 无关——主链本会放行；
      // N1 fail-closed 一律拒（until 零合法 kill 形态）
      const result = await tool.execute("t1", { seconds: 5, reason: "等 CI", until: "k" + "ill 12345" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("不支持进程终止类命令");
    });
  });
});

describe("F20261026wfpb（#1623 返修）gh pr checks 业务失败 fail-fast（stderr 分类）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── F20261026wfpb（#1623 返修）：gh pr checks 业务失败 fail-fast（stderr 分类，非裸退出码）───
  // Review-1640 反例实证：exit 1 同时覆盖业务失败、test -f/grep 未就绪、gh transport 错误、
  // NONE、GraphQL 错误——退出码不可分类。改为：gh + exit 1 + stderr 空 + stdout 含 bucket
  // 行 = 真实业务应答 → 终态失败；其余（含所有非 gh 命令）保留预算内重试。
  function ghFailProbe(): Error & { code: number; stdout: string; stderr: string } {
    const err = new Error("gh pr checks failed") as Error & { code: number; stdout: string; stderr: string };
    err.code = 1;
    err.stdout = "check\tfail\t9s\thttps://example.invalid/job/1";
    err.stderr = "";
    return err;
  }

  it("gh pr checks 真实业务失败（stdout 表格 + stderr 空）立即终止轮询，不盲等满预算", async () => {
    const tool = findWait();
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ProbeCallback) => {
      cb(ghFailProbe(), { stdout: ghFailProbe().stdout, stderr: "" });
    });
    const execPromise = tool.execute("t1", { seconds: 300, until: "gh pr checks 1604", reason: "等 CI 变绿" });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const result = await execPromise;
    const text = result.content[0].text;
    expect(text).toContain("确认 CI 失败，已停止轮询");
    // 报文 text 来自 formatUntilFailure（stderr 优先）；业务失败 stderr 空时为 message。
    // 失败表格 stdout 已在判定内部使用，不再重复断言其文本形态。
    // 只探测一次就终止：报文只报告第 1 次，且轮询已收尾不留计时器
    expect(text).toContain("第 1 次探测确认");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gh pr checks transport 错误（stderr 非空）不判终态，预算内重试后可成功", async () => {
    const tool = findWait();
    let calls = 0;
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ProbeCallback) => {
      calls += 1;
      if (calls < 3) {
        const err = new Error("proxyconnect") as Error & { code: number; stdout: string; stderr: string };
        err.code = 1;
        err.stdout = "";
        err.stderr = 'Post "https://api.github.com/graphql": proxyconnect tcp: connection refused';
        cb(err, { stdout: "", stderr: err.stderr });
      } else {
        cb(null, { stdout: "check\tpass\t1m\thttps://example.invalid/job/2", stderr: "" });
      }
    });
    const execPromise = tool.execute("t1", { seconds: 300, until: "gh pr checks 1604", reason: "等 CI 变绿" });
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await execPromise;
    // transport 错误重试后成功——不提前终止
    expect(result.content[0].text).toContain("until 条件通过");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gh pr checks NONE（stdout 无 bucket 行）不判终态，重试到预算耗尽", async () => {
    const tool = findWait();
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ProbeCallback) => {
      const err = new Error("no checks") as Error & { code: number; stdout: string; stderr: string };
      err.code = 1;
      err.stdout = "no checks reported on 'main'";
      err.stderr = "";
      cb(err, { stdout: "no checks reported on 'main'", stderr: "" });
    });
    const execPromise = tool.execute("t1", { seconds: 25, until: "gh pr checks 1604", reason: "等 CI 注册" });
    await vi.advanceTimersByTimeAsync(25_000);
    const result = await execPromise;
    // NONE 形态：stdout 无 bucket 行 → 不判终态，重试到预算耗尽后返回超时报文
    expect(result.content[0].text).toContain("until 条件未通过（共 3 次探测");
    expect(result.content[0].text).not.toContain("确认 CI 失败");
  });

  it("Review-1640 反例：文件探活 exit 1（未就绪可恢复）不判终态，第 3 次探测成功", async () => {
    const tool = findWait();
    mockProbeSequence(1, "", "file ready", 2);
    const execPromise = tool.execute("t1", { seconds: 60, until: "test -f /tmp/ready-flag", reason: "等文件出现" });
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await execPromise;
    expect(result.content[0].text).toContain("until 条件通过");
    expect(result.content[0].text).toContain("file ready");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("非 gh 命令持续 exit 1 到预算耗尽返回超时报文（不提前终止）", async () => {
    const tool = findWait();
    mockProbeAlwaysFail(1, "not found");
    const execPromise = tool.execute("t1", { seconds: 25, until: "test -f /tmp/never" });
    await vi.advanceTimersByTimeAsync(25_000);
    const result = await execPromise;
    expect(result.content[0].text).toContain("until 条件未通过（共 3 次探测");
    expect(result.content[0].text).not.toContain("确认 CI 失败");
  });

  it("CI pending（gh 约定 exit 8）后在同一次 wait 内重试，第三次成功并返回实际耗时", async () => {
    const tool = findWait();
    // gh pr checks 裸命令三态约定：8 = checks pending（gh ≥2.89 实测语义）
    mockProbeSequence(8, "pending", "CI green", 2);
    const execPromise = tool.execute("t1", { seconds: 30, until: "gh pr checks 1604", reason: "等 CI 变绿" });
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await execPromise;
    expect(result.content[0].text).toContain("第 3 次探测，已等待 20 秒");
    expect(result.content[0].text).toContain("CI green");
    expect(execFileMock.mock.calls[0][0]).toBe("gh");
    expect(execFileMock.mock.calls[0][1]).toEqual(["pr", "checks", "1604"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pending（exit 8）重试后转为真实业务失败时，立即终止并报告最后一次探测", async () => {
    const tool = findWait();
    let first = true;
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ProbeCallback) => {
      const fail = ghFailProbe();
      cb(first ? failWithCode(8, "pending") : fail, first ? { stdout: "", stderr: "" } : { stdout: fail.stdout, stderr: "" });
      first = false;
    });
    const execPromise = tool.execute("t1", { seconds: 300, until: "gh pr checks 1604" });
    // 第一次探测（pending）后进入 10s 间隔；推进 10s 触发第二次探测（业务失败）即终止
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await execPromise;
    const text = result.content[0].text;
    expect(text).toContain("确认 CI 失败，已停止轮询");
    expect(text).toContain("第 2 次探测确认");
    expect(vi.getTimerCount()).toBe(0);
  });
});
