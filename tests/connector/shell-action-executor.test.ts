import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";
import { SqliteActionLedger } from "@frameworks/execution/ledger/sqlite-action-ledger";
import { ShellActionExecutor } from "../../src/connector/shell-action-executor";
import type { ShellOutputSkipSpec } from "@entities/execution/connector-protocol";

/**
 * ShellActionExecutor 真执行测试（真 NodeExecutionEnv + 真 SqliteActionLedger +
 * 临时 dataRoot）——成功/流式/取消/超时/窗口/幂等/下线全链；
 * 台账行（status/resultSummary/归因）为机器侧真相源断言面。
 */

interface OutputFrame {
  actionId: string;
  stream: "stdout" | "stderr";
  text: string;
  skipped?: ShellOutputSkipSpec;
}

async function makeExecutor(opts: { withLedger?: boolean } = {}) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "shell-exec-test-"));
  const gateway = new NodeWorkspaceGateway(dataRoot);
  const ledger = opts.withLedger === false
    ? null
    : new SqliteActionLedger(path.join(dataRoot, "action-ledger.sqlite"), { deviceId: "shell-test" });
  const outputFrames: OutputFrame[] = [];
  const executor = new ShellActionExecutor({
    ledger,
    resolveWorkspaceRoot: conversationId => gateway.getWorkspacePath(conversationId),
    sendOutput: data => { outputFrames.push(data); },
    log: () => {},
  });
  return { dataRoot, gateway, ledger, executor, outputFrames };
}

describe("ShellActionExecutor", () => {
  let ctx: Awaited<ReturnType<typeof makeExecutor>>;
  beforeEach(async () => {
    ctx = await makeExecutor();
  });
  afterEach(async () => {
    await ctx.executor.shutdown("test teardown").catch(() => {});
    ctx.ledger?.close();
    await rm(ctx.dataRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("崩溃恢复入账：真实 spawn 后 running 行记录动作 PGID 与 OS 启动时间", async () => {
    const pending = ctx.executor.run(
      { conversationId: "c1", command: [process.execPath, "-e", "setTimeout(() => {}, 30000)"] },
      { actionId: "sh-process-identity" },
    );
    try {
      let row = await ctx.ledger!.getByActionId("sh-process-identity");
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && (!row?.processStartedAt || row.pid === process.pid)) {
        await new Promise(resolve => setTimeout(resolve, 20));
        row = await ctx.ledger!.getByActionId("sh-process-identity");
      }
      expect(row).toMatchObject({ status: "running", processStartedAt: expect.any(String) });
      expect(row!.pid).toEqual(expect.any(Number));
      expect(row!.pid).not.toBe(process.pid);
      // SDK 在 POSIX 以 detached 建立独立进程组：组长 PID 即后续 boot sweep 的精确回收目标。
      expect(() => process.kill(-row!.pid!, 0)).not.toThrow();
    } finally {
      ctx.executor.cancel("sh-process-identity");
      await pending;
    }
  });

  it("成功：exitCode 0 → succeeded；stdout 实时流回；台账落 succeeded + exitCode + 会话归因", async () => {
    const outcome = await ctx.executor.run(
      { conversationId: "c1", command: "echo hello-remote", invokeId: "inv-1", toolCallId: "tool-bash-1" },
      { actionId: "sh-ok-1" },
    );
    expect(outcome).toMatchObject({ status: "succeeded", result: { exitCode: 0 } });
    const texts = ctx.outputFrames.filter(f => f.actionId === "sh-ok-1");
    expect(texts.length).toBeGreaterThanOrEqual(1);
    expect(texts.every(f => f.stream === "stdout")).toBe(true);
    expect(texts.map(f => f.text).join("")).toContain("hello-remote");
    // 台账：机器侧真相源
    const row = await ctx.ledger!.getByActionId("sh-ok-1");
    expect(row).toMatchObject({
      status: "succeeded", kind: "shell.exec", conversationId: "c1", invokeId: "inv-1", toolCallId: "tool-bash-1",
    });
    expect(JSON.parse(row!.resultSummary!)).toMatchObject({ exitCode: 0 });
  });

  it("argv 直跑 + env/inheritEnv=false 透传；非零 exitCode 仍 succeeded（跑完是事实，退出码是数据）", async () => {
    // inheritEnv=false 时进程环境只有 input.env（无 PATH）——argv[0] 用绝对路径防 spawn 找不到
    const outcome = await ctx.executor.run(
      { conversationId: "c1", command: [process.execPath, "-e", "process.stdout.write(process.env.T_VAR ?? \"missing\"); process.exit(3)"], env: { T_VAR: "marked" }, inheritEnv: false },
      { actionId: "sh-argv-1" },
    );
    expect(outcome).toMatchObject({ status: "succeeded", result: { exitCode: 3 } });
    expect(ctx.outputFrames.map(f => f.text).join("")).toContain("marked");
  });

  it("cwd 映射：缺省 = 设备工作区根（自动建目录）；相对 cwd 相对设备根解析；不存在的相对 cwd 诚实 failed", async () => {
    const root = ctx.gateway.getWorkspacePath("c-cwd");
    // 缺省 cwd → 设备工作区根（首次使用自动 mkdir——SDK 对不存在 cwd 报 spawn_error）
    const outcome = await ctx.executor.run(
      { conversationId: "c-cwd", command: ["node", "-e", "process.stdout.write(process.cwd())"] },
      { actionId: "sh-cwd-1" },
    );
    expect(outcome.status).toBe("succeeded");
    const printed = ctx.outputFrames.map(f => f.text).join("");
    expect(printed).toBe(await realpath(root));
    // 相对 cwd 已存在于设备根下 → 解析执行
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(root, "sub/dir"), { recursive: true });
    ctx.outputFrames.length = 0;
    const sub = await ctx.executor.run(
      { conversationId: "c-cwd", command: ["node", "-e", "process.stdout.write(process.cwd())"], cwd: "sub/dir" },
      { actionId: "sh-cwd-2" },
    );
    expect(sub.status).toBe("succeeded");
    expect(ctx.outputFrames.map(f => f.text).join("")).toBe(await realpath(path.join(root, "sub/dir")));
    // 不存在的相对 cwd → 不自动建目录（防拼写错误静默落错目录）→ spawn_error
    const missing = await ctx.executor.run(
      { conversationId: "c-cwd", command: "echo x", cwd: "no/such/dir" },
      { actionId: "sh-cwd-3" },
    );
    expect(missing).toMatchObject({ status: "failed", errorCode: "spawn_error" });
  });

  it("stderr 帧按 stream 标注到达", async () => {
    const outcome = await ctx.executor.run(
      { conversationId: "c1", command: ["node", "-e", "process.stdout.write(\"o1\"); process.stderr.write(\"e1\")"] },
      { actionId: "sh-stream-1" },
    );
    expect(outcome.status).toBe("succeeded");
    const frames = ctx.outputFrames.filter(f => f.actionId === "sh-stream-1");
    expect(frames.some(f => f.stream === "stdout" && f.text.includes("o1"))).toBe(true);
    expect(frames.some(f => f.stream === "stderr" && f.text.includes("e1"))).toBe(true);
  });

  it("取消：cancel(actionId) 只 abort 该动作 → interrupted + errorCode=aborted；台账同态", async () => {
    const pending = ctx.executor.run(
      { conversationId: "c1", command: ["node", "-e", "setTimeout(() => {}, 30000)"] },
      { actionId: "sh-cancel-1" },
    );
    await new Promise(r => setTimeout(r, 200)); // 进程起来
    expect(ctx.executor.inflightCount).toBe(1);
    expect(ctx.executor.cancel("sh-cancel-1")).toBe(true);
    const outcome = await pending;
    expect(outcome).toMatchObject({ status: "interrupted", errorCode: "aborted" });
    expect((await ctx.ledger!.getByActionId("sh-cancel-1"))?.status).toBe("interrupted");
    // 未知/已完成动作 cancel → false（no-op）
    expect(ctx.executor.cancel("sh-cancel-1")).toBe(false);
    expect(ctx.executor.cancel("never-seen")).toBe(false);
  });

  it("超时：timeout 杀进程组 → interrupted + errorCode=timeout", async () => {
    const outcome = await ctx.executor.run(
      { conversationId: "c1", command: ["node", "-e", "setTimeout(() => {}, 30000)"], timeout: 1 },
      { actionId: "sh-timeout-1" },
    );
    expect(outcome).toMatchObject({ status: "interrupted", errorCode: "timeout" });
    expect((await ctx.ledger!.getByActionId("sh-timeout-1"))?.status).toBe("interrupted");
  }, 15_000);

  it("spawn 失败（不存在的工作目录）→ failed + errorCode=spawn_error", async () => {
    const outcome = await ctx.executor.run(
      { conversationId: "c1", command: "echo x", cwd: "/nonexistent/dir/that/never/exists" },
      { actionId: "sh-spawn-1" },
    );
    expect(outcome).toMatchObject({ status: "failed", errorCode: "spawn_error" });
    expect((await ctx.ledger!.getByActionId("sh-spawn-1"))?.status).toBe("failed");
  });

  it("非法输入（缺 conversationId）→ failed + invalid_input；空 argv 按 SDK 契约是 spawn_error；零副作用零入账", async () => {
    const bad1 = await ctx.executor.run({ command: "echo x" } as never, { actionId: "sh-bad-1" });
    expect(bad1).toMatchObject({ status: "failed", errorCode: "invalid_input" });
    const bad2 = await ctx.executor.run({ conversationId: "c1", command: [] }, { actionId: "sh-bad-2" });
    expect(bad2).toMatchObject({ status: "failed", errorCode: "spawn_error" });
    expect(await ctx.ledger!.getByActionId("sh-bad-1")).toBeNull();
  });

  it("窗口模式：带 skipped 的块严格超窗（契约）+ 省略计数精确；末段 flush 不丢尾", async () => {
    const outcome = await ctx.executor.run(
      {
        conversationId: "c1",
        // 200 行快吐完 + 采样闸 500ms → 输出全落 pending，进程结算后 flush 一帧定音
        // （确定性验证窗口省略路径；命令本身 << 闸值）
        command: [process.execPath, "-e", "for (let i = 0; i < 200; i++) console.log(`line-${String(i).padStart(3, \"0\")}`)"],
        window: { maxBytes: 1024, maxLines: 10, minIntervalMs: 500, bytesPerSecond: 1e9 },
      },
      { actionId: "sh-win-1" },
    );
    expect(outcome.status).toBe("succeeded");
    const frames = ctx.outputFrames.filter(f => f.actionId === "sh-win-1");
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const kept = frames.map(f => f.text).join("");
    expect(kept).toContain("line-199"); // 尾部完整
    expect(kept).not.toContain("line-000"); // 头部被窗口省略
    // SDK 契约：带 skipped 的块必须严格超窗（被省略文本绝不在调用方保留尾内）
    for (const frame of frames) {
      if (!frame.skipped) continue;
      const frameNewlines = frame.text.split("\n").length - 1;
      expect(Buffer.byteLength(frame.text, "utf-8") > 1024 || frameNewlines > 10).toBe(true);
    }
    // 行窗主导：行边界对齐的最小严格超窗后缀 = 11 行（line-189..199，99 字节），省略头 189 行
    expect(kept).toContain("line-189");
    expect(kept).not.toContain("line-188");
    const skippedTotal = frames.reduce((acc, f) => acc + (f.skipped?.bytes ?? 0), 0);
    const skippedNewlines = frames.reduce((acc, f) => acc + (f.skipped?.newlines ?? 0), 0);
    expect(skippedTotal).toBe(189 * 9); // 省略量精确：头 189 行 × 9 字节
    expect(skippedNewlines).toBe(189);
    // 保留 + 省略 = 全量输出（200 行 × 9 字节 = 1800 字节）
    expect(Buffer.byteLength(kept, "utf-8") + skippedTotal).toBe(200 * 9);
  });

  it("幂等：台账已有同 actionId succeeded 行 → 直接回已记录结果，零副作用", async () => {
    // 首轮真执行落台账
    await ctx.executor.run(
      { conversationId: "c1", command: ["node", "-e", "require(\"fs\").writeFileSync(\"marker.txt\", \"once\")"] },
      { actionId: "sh-idem-1" },
    );
    // 重放同 actionId（不同命令——若被执行会覆写 marker）
    ctx.outputFrames.length = 0;
    const replay = await ctx.executor.run(
      { conversationId: "c1", command: ["node", "-e", "require(\"fs\").writeFileSync(\"marker.txt\", \"twice\")"] },
      { actionId: "sh-idem-1" },
    );
    expect(replay).toMatchObject({ status: "succeeded", result: { exitCode: 0 } });
    const { readFile } = await import("node:fs/promises");
    const marker = await readFile(path.join(ctx.gateway.getWorkspacePath("c1"), "marker.txt"), "utf-8");
    expect(marker).toBe("once"); // 未重执行
  });

  it("下线：shutdown 取消全部在途进程组 → 各动作 interrupted", async () => {
    const p1 = ctx.executor.run(
      { conversationId: "c1", command: ["node", "-e", "setTimeout(() => {}, 30000)"] },
      { actionId: "sh-down-1" },
    );
    const p2 = ctx.executor.run(
      { conversationId: "c2", command: ["node", "-e", "setTimeout(() => {}, 30000)"] },
      { actionId: "sh-down-2" },
    );
    await new Promise(r => setTimeout(r, 200));
    expect(ctx.executor.inflightCount).toBe(2);
    await ctx.executor.shutdown("test shutdown");
    const [o1, o2] = await Promise.all([p1, p2]);
    expect(o1).toMatchObject({ status: "interrupted", errorCode: "aborted" });
    expect(o2).toMatchObject({ status: "interrupted", errorCode: "aborted" });
    expect(ctx.executor.inflightCount).toBe(0);
  }, 15_000);
});
