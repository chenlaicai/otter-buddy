/**
 * 执行机壳（machine-scoped coding tools）行为测试：
 * schema 面（machine 字段）、三失败路径、env 重建 + 代理委托真链、代理守卫、
 * prepareArguments 的 machine 保全。
 *
 * 真链走 LocalExecutionMachine + NodeWorkspaceGateway（tmpdir），bash 真跑子进程
 * ——env 重建是否真实生效由「echo 输出经代理 env 流回 api.output」兑付。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolDiagnostic, ToolExecutionApi } from "@earendil-works/pi-durable";
import { createMachineScopedCodingTools } from "@frameworks/agent/machine-scoped-coding-tools";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";
import { LocalExecutionMachine } from "@frameworks/execution/local-execution-machine";
import { ExecutionMachineRegistry } from "@usecases/execution/execution-machine-registry";
import type { ExecutionMachinePoolSnapshot } from "@usecases/ports/execution-machine";

function poolWithOnline(localOnline: boolean): () => Promise<ExecutionMachinePoolSnapshot> {
  return async () => ({
    machines: [
      { id: "local", name: "中枢本机", online: localOnline, lastSeenAt: null, local: true },
      { id: "dev-box", name: "开发机", online: false, lastSeenAt: "2026-11-25T14:02:00Z" },
    ],
    currentMachineId: "local",
  });
}

/** 代理守卫过得了的完整假 api（关键面齐全；env 由代理替换）。 */
function fakeApi(): ToolExecutionApi<never> & { diagnostics: ToolDiagnostic[]; outputs: string[] } {
  const stub = {
    taskId: "task-1",
    conversationId: "conv-1",
    callId: "call-1",
    registry: {},
    agent: async () => { throw new Error("agent not expected in wrapper tests"); },
    models: {},
    env: undefined,
    now: () => Date.now(),
    output: (chunk: string) => { stub.outputs.push(String(chunk)); },
    outputWindow: undefined,
    retainedOutput: () => ({ text: stub.outputs.join(""), truncated: false }),
    diagnostic: (d: ToolDiagnostic) => { stub.diagnostics.push(d); },
    details: async () => undefined,
    commit: async () => undefined,
    memo: async () => undefined,
    createTask: async () => "child-task",
    getTask: async () => undefined,
    waitForTask: async () => undefined,
    conversation: {},
    snapshot: async () => undefined,
    snapshotAsOf: async () => undefined,
    watchDoc: async () => () => undefined,
    executeTool: async () => undefined,
    diagnostics: [] as ToolDiagnostic[],
    outputs: [] as string[],
  };
  return stub as unknown as ToolExecutionApi<never> & { diagnostics: ToolDiagnostic[]; outputs: string[] };
}

describe("machine-scoped-coding-tools", () => {
  let tmpDir: string;
  let runner: ExecutionMachineRegistry;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "machine-scoped-tools-"));
    runner = new ExecutionMachineRegistry();
    runner.register(new LocalExecutionMachine(new NodeWorkspaceGateway(tmpDir)));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const buildDeps = (online = true) => ({
    machinePool: poolWithOnline(online),
    resolveMachine: (id: string) => runner.resolve(id),
    sessionCwd: () => tmpDir,
    conversationId: () => "conv-1",
  });

  const findTool = (name: string, online = true) => {
    const extension = createMachineScopedCodingTools(buildDeps(online));
    const tool = (extension.tools ?? []).find(t => t.name === name);
    expect(tool).toBeDefined();
    return tool!;
  };

  it("四个 SDK 工具均被壳化，schema 含 machine 字段与必选语义描述", () => {
    const extension = createMachineScopedCodingTools(buildDeps());
    const names = (extension.tools ?? []).map(t => t.name);
    expect(names).toEqual(["bash", "read", "write", "edit"]);
    for (const tool of extension.tools ?? []) {
      const props = (tool.parameters as { properties: Record<string, { description?: string }> }).properties;
      expect(props.machine).toBeDefined();
      expect(props.machine.description).toContain("REQUIRED");
    }
  });

  it("bash 保留原工具的结构化输出 schema 与 tail 输出上限", () => {
    const bash = findTool("bash") as unknown as { structuredOutputSchema?: object; outputLimits?: { retain?: string } };
    expect(bash.structuredOutputSchema).toBeDefined();
    expect(bash.outputLimits?.retain).toBe("tail");
  });

  it("缺 machine：isError 报错含机器池清单（自纠错信息）", async () => {
    const bash = findTool("bash");
    const api = fakeApi();
    const result = await bash.execute({ command: "echo hi" } as never, api, BACKGROUND_CONTEXT);
    expect(result.isError).toBe(true);
    const text = ((result as { output?: Array<{ text?: string }> }).output ?? []).map(b => b.text ?? "").join("");
    expect(text).toContain("缺少必选参数 machine");
    expect(text).toContain("- local（中枢本机，在线");
    expect(text).toContain("- dev-box（开发机，离线");
  });

  it("指定未知机器：isError 报错含指定 id 与清单，不静默换机", async () => {
    const bash = findTool("bash");
    const result = await bash.execute({ command: "echo hi", machine: "ghost" } as never, fakeApi(), BACKGROUND_CONTEXT);
    expect(result.isError).toBe(true);
    const text = ((result as { output?: Array<{ text?: string }> }).output ?? []).map(b => b.text ?? "").join("");
    expect(text).toContain('"ghost" 不在机器池中');
  });

  it("指定离线机器：isError 报错标注离线", async () => {
    const bash = findTool("bash");
    const result = await bash.execute({ command: "echo hi", machine: "dev-box" } as never, fakeApi(), BACKGROUND_CONTEXT);
    expect(result.isError).toBe(true);
    const text = ((result as { output?: Array<{ text?: string }> }).output ?? []).map(b => b.text ?? "").join("");
    expect(text).toContain('"dev-box"');
    expect(text).toContain('当前离线');
  });

  it("在线机器：env 重建 + 代理委托真链生效——bash 在目标机 env 跑出输出，落点 diagnostic 记录", async () => {
    const bash = findTool("bash");
    const api = fakeApi();
    const result = await bash.execute({ command: "echo machine-scoped-ok", machine: "local" } as never, api, BACKGROUND_CONTEXT);
    expect(result.isError).toBeFalsy();
    const structured = (result as { structuredOutput?: { output?: string; exitCode?: number } }).structuredOutput;
    expect(structured?.output).toContain("machine-scoped-ok");
    expect(structured?.exitCode).toBe(0);
    expect(api.diagnostics.some(d => d.code === "execution_machine" && d.message.includes("local"))).toBe(true);
  });

  it("resolveMachine 抛错（校验后机器恰好下线的 TOCTOU 窗口）：异常向上传播（fail-closed 吵闹失败）", async () => {
    const deps = {
      ...buildDeps(),
      resolveMachine: () => { throw new Error("Execution machine not registered: local"); },
    };
    const extension = createMachineScopedCodingTools(deps);
    const bash = (extension.tools ?? []).find(t => t.name === "bash")!;
    await expect(
      bash.execute({ command: "echo hi", machine: "local" } as never, fakeApi(), BACKGROUND_CONTEXT),
    ).rejects.toThrow("not registered");
  });

  it("代理 api 守卫：spread 丢关键成员时吵闹失败（SDK 内部形态变更防护）", async () => {
    const bash = findTool("bash");
    const api = fakeApi();
    delete (api as unknown as Record<string, unknown>).commit; // 模拟 SDK 改形态后 spread 丢成员
    await expect(
      bash.execute({ command: "echo hi", machine: "local" } as never, api, BACKGROUND_CONTEXT),
    ).rejects.toThrow("lost api members");
  });

  it("write 真链：machine 落点写文件成功（文件变更队列经代理 env 正常工作）", async () => {
    const write = findTool("write");
    const result = await write.execute(
      { path: path.join(tmpDir, "scoped-write.txt"), content: "written-via-machine-scoped-shell", machine: "local" } as never,
      fakeApi(),
      BACKGROUND_CONTEXT,
    );
    expect(result.isError).toBeFalsy();
    await expect(fs.readFile(path.join(tmpDir, "scoped-write.txt"), "utf8")).resolves.toBe("written-via-machine-scoped-shell");
  });

  it("edit 的 prepareArguments 透传：单 edit 形态修复后 machine 字段保全", () => {
    const edit = findTool("edit") as unknown as { prepareArguments?: (raw: unknown) => Record<string, unknown> };
    expect(edit.prepareArguments).toBeDefined();
    const repaired = edit.prepareArguments!({ path: "a.md", oldText: "x", newText: "y", machine: "local" });
    expect(Array.isArray(repaired.edits)).toBe(true);
    expect(repaired.machine).toBe("local");
  });

  it("edit 的 prepareArguments：多 edit 形态原样通过且 machine 保全", () => {
    const edit = findTool("edit") as unknown as { prepareArguments?: (raw: unknown) => Record<string, unknown> };
    const repaired = edit.prepareArguments!({
      path: "a.md",
      edits: [{ oldText: "x", newText: "y" }],
      machine: "dev-box",
    });
    expect((repaired.edits as unknown[]).length).toBe(1);
    expect(repaired.machine).toBe("dev-box");
  });
});
