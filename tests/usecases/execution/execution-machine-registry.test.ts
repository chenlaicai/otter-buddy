import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ExecutionMachineRegistry } from "@usecases/execution/execution-machine-registry";
import { LocalExecutionMachine } from "@frameworks/execution/local-execution-machine";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";

describe("ExecutionMachineRegistry", () => {
  let dataDir: string;
  let registry: ExecutionMachineRegistry;
  const conversationId = "execution-machine-test";

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "execution-machine-registry-"));
    const workspace = new NodeWorkspaceGateway(dataDir);
    registry = new ExecutionMachineRegistry();
    registry.register(new LocalExecutionMachine(workspace));
    await workspace.ensureWorkspace(conversationId);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("缺省与显式 local 走同一本机工作区行为", async () => {
    await registry.run({
      type: "workspace.write",
      input: { conversationId, relativePath: "report/result.txt", content: "local-result" },
    });
    const explicit = await registry.run({
      type: "workspace.read",
      input: { conversationId, relativePath: "report/result.txt" },
    }, "local");

    expect(explicit).toBe("local-result");
    expect(await readFile(path.join(dataDir, "workspaces", conversationId, "report", "result.txt"), "utf8")).toBe("local-result");
    expect(await registry.run({ type: "workspace.path", input: { conversationId } })).toBe(
      path.join(dataDir, "workspaces", conversationId),
    );
  });

  it("未知目标 fail-closed，且不产生文件副作用", async () => {
    await expect(registry.run({
      type: "workspace.write",
      input: { conversationId, relativePath: "must-not-exist.txt", content: "no" },
    }, "ghost")).rejects.toThrow("Execution machine not registered: ghost");

    await expect(readFile(path.join(dataDir, "workspaces", conversationId, "must-not-exist.txt"), "utf8")).rejects.toThrow();
  });

  it("重复 ID 注册被拒绝", () => {
    const duplicate = new LocalExecutionMachine(new NodeWorkspaceGateway(dataDir));
    expect(() => registry.register(duplicate)).toThrow("Execution machine already registered: local");
  });
});
