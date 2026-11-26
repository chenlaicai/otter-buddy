import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ExecutionMachineRegistry } from "@usecases/execution/execution-machine-registry";
import { WorkspaceActionExecutor } from "@frameworks/execution/workspace-action-executor";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";
import type { ActionRunOptions, ExecutionAction, ExecutionActionResult, ExecutionActionType, ExecutionMachine } from "@usecases/ports/execution-machine";

/** executor 测试机器（统一注册制下 Registry 测试的内联真跑机器——run 委托
 *  WorkspaceActionExecutor，与 connector 设备侧执行栈同构）。 */
function executorMachine(id: string, dataDir: string): ExecutionMachine {
  const executor = new WorkspaceActionExecutor(new NodeWorkspaceGateway(dataDir));
  return {
    id,
    name: id,
    createExecutionEnvironment: () => { throw new Error("env face not under test here"); },
    async run<K extends ExecutionActionType>(
      action: ExecutionAction<K>,
      _target?: string,
      options?: ActionRunOptions,
    ): Promise<ExecutionActionResult<K>> {
      return executor.run(action, options) as Promise<ExecutionActionResult<K>>;
    },
  };
}

describe("ExecutionMachineRegistry (uniform registration)", () => {
  let dataDir: string;
  let registry: ExecutionMachineRegistry;
  const conversationId = "execution-machine-test";

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "execution-machine-registry-"));
    const workspace = new NodeWorkspaceGateway(dataDir);
    registry = new ExecutionMachineRegistry();
    registry.register(executorMachine("node-a", dataDir));
    await workspace.ensureWorkspace(conversationId);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("显式目标路由到对应机器的工作区行为", async () => {
    await registry.run({
      type: "workspace.write",
      input: { conversationId, relativePath: "report/result.txt", content: "scoped-result" },
    }, "node-a");
    const read = await registry.run({
      type: "workspace.read",
      input: { conversationId, relativePath: "report/result.txt" },
    }, "node-a");

    expect(read).toBe("scoped-result");
    expect(await readFile(path.join(dataDir, "workspaces", conversationId, "report", "result.txt"), "utf8")).toBe("scoped-result");
    expect(await registry.run({ type: "workspace.path", input: { conversationId } }, "node-a")).toBe(
      path.join(dataDir, "workspaces", conversationId),
    );
  });

  it("无参 resolve fail-closed（统一注册制：无默认机——漏网路径吵着失败）", () => {
    expect(() => registry.resolve()).toThrow(/no default machine/i);
    expect(() => registry.resolve(undefined)).toThrow(/no default machine/i);
  });

  it("未知目标 fail-closed，且不产生文件副作用", async () => {
    await expect(registry.run({
      type: "workspace.write",
      input: { conversationId, relativePath: "must-not-exist.txt", content: "no" },
    }, "ghost")).rejects.toThrow("Execution machine not registered: ghost");

    await expect(readFile(path.join(dataDir, "workspaces", conversationId, "must-not-exist.txt"), "utf8")).rejects.toThrow();
  });

  it("重复 ID 注册被拒绝", () => {
    const duplicate = executorMachine("node-a", dataDir);
    expect(() => registry.register(duplicate)).toThrow("Execution machine already registered: node-a");
  });

  it("replace 顶替语义（同 id 后到者顶替前者——设备重连投影刷新）", async () => {
    registry.replace(executorMachine("node-a", dataDir));
    // 顶替后的新机器真跑（write → read 全链经替换后实例）
    await registry.run({ type: "workspace.write", input: { conversationId, relativePath: "replace-proof.txt", content: "replaced" } }, "node-a");
    const result = await registry.run({ type: "workspace.read", input: { conversationId, relativePath: "replace-proof.txt" } }, "node-a");
    expect(result).toBe("replaced");
  });
});
