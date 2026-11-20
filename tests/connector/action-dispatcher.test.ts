import { describe, expect, it } from "vitest";
import { ConnectorActionDispatcher } from "../../src/connector/action-dispatcher";
import type { ShellExecutorLike, ShellRunOutcome } from "../../src/connector/shell-action-executor";
import type { ActionRecord } from "@entities/execution/action-record";
import type { ConnectorFrame } from "@entities/execution/connector-protocol";
import type { AnyExecutionAction } from "@usecases/ports/execution-machine";
import type { FileExecutorLike } from "../../src/connector/file-action-executor";

/**
 * connector 侧动作分发器单测——
 * 幂等快路径（台账已 succeeded 不重执行）/白名单拒/执行回执/台账读失败降级；
 * 协议 v2：shell.exec 路由（结局映射/errorCode/spill 透传）、action.cancel 接线。
 */

type ResultFrame = Extract<ConnectorFrame, { type: "action.result" }>["data"];

function requestFrame(actionId: string, type: string, input: Record<string, unknown>) {
  return { v: 2, type: "action.request", seq: 1, sid: "s1", data: { actionId, action: { type, input } } } as const;
}

function makeDeps(opts: {
  existing?: ActionRecord | null;
  ledgerError?: boolean;
  executorImpl?: (action: AnyExecutionAction, options?: { actionId?: string }) => Promise<unknown>;
  shell?: ShellExecutorLike;
  file?: FileExecutorLike;
} = {}) {
  const sent: ResultFrame[] = [];
  const executorCalls: Array<{ type: string; actionId?: string }> = [];
  const deps = {
    executor: {
      run: async (action: AnyExecutionAction, options?: { actionId?: string }) => {
        executorCalls.push({ type: action.type, actionId: options?.actionId });
        if (opts.executorImpl) return opts.executorImpl(action, options);
        return "ok";
      },
    },
    ...(opts.shell ? { shell: opts.shell } : {}),
    ...(opts.file ? { file: opts.file } : {}),
    ledger: {
      getByActionId: async () => {
        if (opts.ledgerError) throw new Error("db locked");
        return opts.existing ?? null;
      },
      settled: [] as Array<{ actionId: string; verdict: unknown }>,
      settle: async (actionId: string, verdict: unknown) => {
        deps.ledger.settled.push({ actionId, verdict });
      },
    },
    send: (data: ResultFrame) => { sent.push(data); },
    log: () => {},
  };
  return { deps, sent, executorCalls, dispatcher: new ConnectorActionDispatcher(deps) };
}

function ledgerRow(status: ActionRecord["status"], resultSummary: string | null = null): ActionRecord {
  return {
    actionId: "a-1", deviceId: "conn-1", onlineSessionId: null, invokeId: null, conversationId: null,
    toolCallId: null, source: "workspace", kind: "workspace.write", target: "c1/b.txt", contentHash: null,
    contentBytes: null, status, error: null, resultSummary, bootEpoch: 1, pid: null, startedAt: "2026-11-18T00:00:00Z", settledAt: null,
  };
}

describe("ConnectorActionDispatcher", () => {
  it("白名单外动作类型 → failed 回执（执行能力白名单：六动作 + shell.exec + file.* 族）", async () => {
    const { dispatcher, sent } = makeDeps();
    await dispatcher.handleActionRequest(requestFrame("a-x", "agent.run", { path: "/etc/passwd" }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.status).toBe("failed");
    expect(sent[0]!.error).toContain("unsupported action type");
  });

  it("file.* 路由：file 执行器结局直通（succeeded 值 / failed errorCode+errorPath）", async () => {
    const file: FileExecutorLike = {
      run: async (type, input) => {
        if (type === "file.read") return { status: "succeeded", result: `content:${String(input.path)}` };
        return { status: "failed", errorCode: "not_found", error: "ENOENT", errorPath: String(input.path) };
      },
      closeAllResources: async () => {},
    };
    const { dispatcher, sent } = makeDeps({ file });
    await dispatcher.handleActionRequest(requestFrame("f-1", "file.read", { conversationId: "c1", path: "/d/a.txt" }));
    expect(sent[0]).toMatchObject({ actionId: "f-1", status: "succeeded", result: "content:/d/a.txt" });
    await dispatcher.handleActionRequest(requestFrame("f-2", "file.write", { conversationId: "c1", path: "/d/no/a.txt" }));
    // FileError code 直通 + errorPath 随 result.path 回传（hub 还原 SDK FileError）
    expect(sent[1]).toMatchObject({ actionId: "f-2", status: "failed", errorCode: "not_found", result: { path: "/d/no/a.txt" } });
  });

  it("file.* 无 file 执行器装配 → failed/unsupported（防御纵深：hub 版本闸外第二道）", async () => {
    const { dispatcher, sent } = makeDeps(); // 未装 file
    await dispatcher.handleActionRequest(requestFrame("f-no", "file.read", { conversationId: "c1", path: "a.txt" }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.status).toBe("failed");
    expect(sent[0]!.error).toContain("no file executor");
  });

  it("file 写类幂等快路径：台账已 succeeded → 回 null 不重执行（与活体 void 语义一致）", async () => {
    const existing = ledgerRow("succeeded", JSON.stringify({ bytes: 5 }));
    existing.kind = "file.write";
    const file: FileExecutorLike = {
      run: async () => { throw new Error("must not re-execute"); },
      closeAllResources: async () => {},
    };
    const { dispatcher, sent } = makeDeps({ existing, file });
    await dispatcher.handleActionRequest(requestFrame("f-dup", "file.write", { conversationId: "c1", path: "a.txt", content: "x" }));
    expect(sent[0]).toMatchObject({ actionId: "f-dup", status: "succeeded", result: null });
  });

  it("shell.exec 无 shell 执行器装配 → failed/unsupported（防御纵深：hub 版本闸外第二道）", async () => {
    const { dispatcher, sent } = makeDeps(); // 未装 shell
    await dispatcher.handleActionRequest(requestFrame("a-no-shell", "shell.exec", { conversationId: "c1", command: "echo hi" }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.status).toBe("failed");
    expect(sent[0]!.error).toContain("no shell executor");
  });

  it("幂等快路径：台账已 succeeded → 不重执行；write 类回 null（活体 void 语义，m5）", async () => {
    const { dispatcher, sent, executorCalls } = makeDeps({
      existing: ledgerRow("succeeded", JSON.stringify({ bytes: 3 })),
    });
    await dispatcher.handleActionRequest(requestFrame("a-1", "workspace.write", { conversationId: "c1", relativePath: "b.txt", content: "xyz" }));
    expect(executorCalls).toHaveLength(0); // 未重执行
    expect(sent[0]!.status).toBe("succeeded");
    expect(sent[0]!.result).toBeNull(); // write 活体 result 为 void → 快路径归一 null（不回 {bytes}）
  });

  it("幂等快路径：delete 类回记录的 {deleted}（与活体结果一致）", async () => {
    const { dispatcher, sent } = makeDeps({
      existing: { ...ledgerRow("succeeded", JSON.stringify({ deleted: "file" })), kind: "workspace.delete" },
    });
    await dispatcher.handleActionRequest(requestFrame("a-1", "workspace.delete", { conversationId: "c1", relativePath: "b.txt" }));
    expect(sent[0]!.status).toBe("succeeded");
    expect(sent[0]!.result).toEqual({ deleted: "file" });
  });

  it("台账无行 → 正常执行 → succeeded + 执行结果；actionId 透传 executor（台账记账锚）", async () => {
    const { dispatcher, sent, executorCalls } = makeDeps();
    await dispatcher.handleActionRequest(requestFrame("a-2", "workspace.read", { conversationId: "c1", relativePath: "a.txt" }));
    expect(executorCalls).toEqual([{ type: "workspace.read", actionId: "a-2" }]);
    expect(sent[0]!.status).toBe("succeeded");
    expect(sent[0]!.result).toBe("ok");
  });

  it("台账非终态/其他状态（running/unknown/interrupted）→ 照常执行（executor 内部 dedupe 兜底真冲突）", async () => {
    for (const status of ["running", "unknown", "interrupted", "failed"] as const) {
      const { dispatcher, executorCalls } = makeDeps({ existing: ledgerRow(status) });
      await dispatcher.handleActionRequest(requestFrame("a-1", "workspace.exists", { conversationId: "c1" }));
      expect(executorCalls).toHaveLength(1); // 走执行
    }
  });

  it("执行抛错 → failed 回执带 error", async () => {
    const { dispatcher, sent } = makeDeps({
      executorImpl: async () => { throw new Error("ENOENT: a.txt"); },
    });
    await dispatcher.handleActionRequest(requestFrame("a-3", "workspace.read", { conversationId: "c1", relativePath: "a.txt" }));
    expect(sent[0]!.status).toBe("failed");
    expect(sent[0]!.error).toContain("ENOENT");
  });

  it("M1（检视）：自杀收尾——在途动作立即落 interrupted（不等执行完成）", async () => {
    let releaseExecution: () => void = () => {};
    const gate = new Promise<void>(resolve => { releaseExecution = resolve; });
    const { dispatcher, deps, sent } = makeDeps({
      executorImpl: async () => { await gate; return "late-success"; },
    });
    // 动作在途（执行挂起）
    const done = dispatcher.handleActionRequest(requestFrame("m1-kill-1", "workspace.write", { conversationId: "c1", relativePath: "a.txt", content: "x" }));
    await new Promise(r => setTimeout(r, 0));
    expect(dispatcher.inflightCount).toBe(1);
    // SIGTERM 自杀收尾：在途立即 settle interrupted
    await dispatcher.markInflightInterrupted();
    expect(deps.ledger.settled).toEqual([
      { actionId: "m1-kill-1", verdict: { status: "interrupted", error: "connector shutting down (graceful offline)" } },
    ]);
    // 执行随后完成：回执照发（socket 已关时被丢弃——由 send 层负责），台账 settle succeeded 被 ledger 幂等拦（真 ledger 语义，此处 fake 只验证顺序）
    releaseExecution();
    await done;
    expect(sent[sent.length - 1]!.status).toBe("succeeded"); // 回执面不撒谎（送达层已死则丢弃）
  });

  it("台账读失败 → 降级执行（记账降级语义：台账缺席动作照常执行）", async () => {
    const { dispatcher, sent, executorCalls } = makeDeps({ ledgerError: true });
    await dispatcher.handleActionRequest(requestFrame("a-4", "workspace.exists", { conversationId: "c1" }));
    expect(executorCalls).toHaveLength(1);
    expect(sent[0]!.status).toBe("succeeded");
  });
});

describe("ConnectorActionDispatcher — shell.exec（协议 v2）", () => {
  /** fake shell 执行器：记录调用，按剧本回结局 */
  function fakeShell(script: (input: unknown, options: { actionId: string }) => Promise<ShellRunOutcome>) {
    const calls: Array<{ input: unknown; actionId: string }> = [];
    const cancelled: string[] = [];
    const shell: ShellExecutorLike = {
      run: async (input, options) => {
        calls.push({ input, actionId: options.actionId });
        return script(input, options);
      },
      cancel: (actionId) => { cancelled.push(actionId); return true; },
      shutdown: async () => {},
    };
    return { shell, calls, cancelled };
  }

  it("成功结局 → succeeded + result 透传（exitCode/spillPath）", async () => {
    const { shell, calls } = fakeShell(async () => ({ status: "succeeded", result: { exitCode: 0, spillPath: "/tmp/spill.log" } }));
    const { dispatcher, sent, executorCalls } = makeDeps({ shell });
    await dispatcher.handleActionRequest(requestFrame("sh-1", "shell.exec", { conversationId: "c1", command: "echo hi" }));
    expect(calls).toEqual([{ input: { conversationId: "c1", command: "echo hi" }, actionId: "sh-1" }]); // actionId 透传（台账记账锚）
    expect(executorCalls).toHaveLength(0); // 不走六动作执行器
    expect(sent[0]).toMatchObject({ actionId: "sh-1", status: "succeeded", result: { exitCode: 0, spillPath: "/tmp/spill.log" } });
  });

  it("interrupted 结局（abort/timeout）→ interrupted + errorCode 透传", async () => {
    const { shell } = fakeShell(async () => ({ status: "interrupted", errorCode: "timeout", error: "timeout:5" }));
    const { dispatcher, sent } = makeDeps({ shell });
    await dispatcher.handleActionRequest(requestFrame("sh-2", "shell.exec", { conversationId: "c1", command: "sleep 99", timeout: 5 }));
    expect(sent[0]).toMatchObject({ actionId: "sh-2", status: "interrupted", error: "timeout:5", errorCode: "timeout" });
  });

  it("failed 结局（spawn_error 等）→ failed + errorCode + 失败时 result 带 spill 诊断路径", async () => {
    const { shell } = fakeShell(async () => ({ status: "failed", errorCode: "spawn_error", error: "Working directory does not exist", spillPath: "/tmp/partial.log" }));
    const { dispatcher, sent } = makeDeps({ shell });
    await dispatcher.handleActionRequest(requestFrame("sh-3", "shell.exec", { conversationId: "c1", command: "x" }));
    expect(sent[0]).toMatchObject({
      actionId: "sh-3", status: "failed", errorCode: "spawn_error",
      result: { spillPath: "/tmp/partial.log" },
    });
  });

  it("幂等快路径：shell.exec 台账已 succeeded → 不重执行，回已记录 {exitCode}", async () => {
    const { shell, calls } = fakeShell(async () => ({ status: "succeeded", result: { exitCode: 0 } }));
    const existing: ActionRecord = {
      ...ledgerRow("succeeded", JSON.stringify({ exitCode: 7 })),
      kind: "shell.exec", target: "echo hi",
    };
    const { dispatcher, sent } = makeDeps({ shell, existing });
    await dispatcher.handleActionRequest(requestFrame("a-1", "shell.exec", { conversationId: "c1", command: "echo hi" }));
    expect(calls).toHaveLength(0); // 未重执行
    expect(sent[0]).toMatchObject({ status: "succeeded", result: { exitCode: 7 } });
  });

  it("action.cancel → 委托 shell.cancel；不直接宣称成功（终态只信 action.result）", () => {
    const { shell, cancelled } = fakeShell(async () => ({ status: "succeeded", result: { exitCode: 0 } }));
    const { dispatcher, sent } = makeDeps({ shell });
    dispatcher.handleActionCancel({ actionId: "sh-9" });
    expect(cancelled).toEqual(["sh-9"]);
    expect(sent).toHaveLength(0); // cancel 不产生回执帧
  });

  it("shell 执行器抛异常（契约外） → failed 回执兑底", async () => {
    const { shell } = fakeShell(async () => { throw new Error("unexpected boom"); });
    const { dispatcher, sent } = makeDeps({ shell });
    await dispatcher.handleActionRequest(requestFrame("sh-4", "shell.exec", { conversationId: "c1", command: "x" }));
    expect(sent[0]!.status).toBe("failed");
    expect(sent[0]!.error).toContain("unexpected");
  });
});
