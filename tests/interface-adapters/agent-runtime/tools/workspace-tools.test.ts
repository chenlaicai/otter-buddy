/**
 * workspace 工具面测试：machine 必选参数（gate 三态）+ 网关安全边界透传 + 落点标记。
 * 用真实 NodeWorkspaceGateway 走 tmpdir，覆盖工具层参数校验 + 网关安全边界的透传。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createWorkspaceTools } from "@interface-adapters/agent-runtime/tools/workspace-tools";
import { executorNodeMachine } from "../../../helpers/execution-machine";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";
import { ExecutionMachineRegistry } from "@usecases/execution/execution-machine-registry";
import type { ActionRunner } from "@usecases/ports/execution-machine";
import type { ToolContext } from "@usecases/ports/agent-tools";

describe("workspace-tools: machine 必选 + 安全边界透传", () => {
  let tmpDir: string;
  let gw: NodeWorkspaceGateway;
  let runner: ExecutionMachineRegistry;
  const convId = "test-conv-del";
  const ctx = {
    conversationId: convId,
    otterId: "otter-1",
    currentMessageId: "m1",
    listExecutionMachines: async () => ({
      machines: [
        { id: "node-a", name: "中枢本机", online: true, lastSeenAt: null },
        { id: "dev-box", name: "开发机", online: false, lastSeenAt: "2026-11-25T14:02:00Z" },
      ],
    }),
  } as unknown as ToolContext;

  const findTool = (name: string) => {
    const tools = createWorkspaceTools(ctx, runner);
    const tool = tools.find((t) => t.name === name);
    expect(tool).toBeDefined();
    return tool!;
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-tools-test-"));
    gw = new NodeWorkspaceGateway(tmpDir);
    runner = new ExecutionMachineRegistry();
    runner.register(executorNodeMachine("node-a", tmpDir));
    await gw.ensureWorkspace(convId);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("createWorkspaceTools 注册 5 个工具且全部含 machine 参数", () => {
    const tools = createWorkspaceTools(ctx, runner);
    expect(tools.map((t) => t.name)).toEqual([
      "workspace_info",
      "workspace_list",
      "workspace_read",
      "workspace_write",
      "workspace_delete",
    ]);
    for (const tool of tools) {
      const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
      expect(props.machine).toBeDefined();
      expect((tool.parameters as { required?: string[] }).required ?? []).not.toContain("machine");
    }
  });

  it("缺 machine：报错含可用机器清单（自纠错），动作不执行", async () => {
    await gw.writeFile(convId, "keep.txt", "keep");
    const del = findTool("workspace_delete");
    const result = await del.execute("c1", { path: "keep.txt" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("缺少必选参数 machine");
    expect(result.content[0].text).toContain("- node-a（中枢本机，在线");
    // 动作未执行（防误删兜底）
    expect(await gw.readFile(convId, "keep.txt")).toBe("keep");
  });

  it("未知机器：报错含指定 id 与清单，不静默换机", async () => {
    const list = findTool("workspace_list");
    const result = await list.execute("c1", { path: ".", machine: "ghost" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"ghost" 不在机器池中');
    expect(result.content[0].text).toContain("不自动换机");
  });

  it("离线机器：报错标注离线", async () => {
    const list = findTool("workspace_list");
    const result = await list.execute("c1", { path: ".", machine: "dev-box" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"dev-box"');
    expect(result.content[0].text).toContain('当前离线');
  });

  it("显式 machine 经 ActionRunner 第二参（targetOverride）透传", async () => {
    let captured: string | undefined;
    const stubRunner: ActionRunner = {
      run: async (action, target) => {
        captured = target;
        if (action.type === "workspace.exists") return true;
        if (action.type === "workspace.list") return [];
        if (action.type === "workspace.path") return "/stub/ws";
        return undefined as never;
      },
    };
    const tools = createWorkspaceTools(ctx, stubRunner);
    const info = tools.find((t) => t.name === "workspace_info")!;
    const result = await info.execute("c1", { machine: "node-a" });
    expect(captured).toBe("node-a");
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).machine).toBe("node-a");
  });

  it("workspace_info：JSON 携带 machine 字段", async () => {
    const info = findTool("workspace_info");
    const result = await info.execute("c1", { machine: "node-a" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.machine).toBe("node-a");
    expect(typeof parsed.path).toBe("string");
    expect(Array.isArray(parsed.entries)).toBe(true);
  });

  it("workspace_list：落点行 + entries", async () => {
    await gw.writeFile(convId, "a.txt", "a");
    const list = findTool("workspace_list");
    const result = await list.execute("c1", { path: ".", machine: "node-a" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text.startsWith("machine: node-a\n")).toBe(true);
    expect(result.content[0].text).toContain("a.txt");
  });

  it("workspace_read：内容原样返回，不加落点前缀（内容可直接解析）", async () => {
    await gw.writeFile(convId, "data.json", JSON.stringify({ k: "v" }));
    const read = findTool("workspace_read");
    const result = await read.execute("c1", { path: "data.json", machine: "node-a" });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({ k: "v" });
  });

  it("workspace_write：落点行 + 写入确认，真实落盘", async () => {
    const write = findTool("workspace_write");
    const result = await write.execute("c1", { path: "out.txt", content: "payload", machine: "node-a" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text.startsWith("machine: node-a\n")).toBe(true);
    expect(await gw.readFile(convId, "out.txt")).toBe("payload");
  });

  it("workspace_delete：删除文件返回落点行 + 确认", async () => {
    await gw.writeFile(convId, "tmp.txt", "junk");
    const del = findTool("workspace_delete");
    const result = await del.execute("c1", { path: "tmp.txt", machine: "node-a" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text.startsWith("machine: node-a\n")).toBe(true);
    expect(result.content[0].text).toContain("已删除文件");
    await expect(gw.readFile(convId, "tmp.txt")).rejects.toThrow();
  });

  it("删除空目录：返回已删除目录确认", async () => {
    await gw.writeFile(convId, "dir/.keep", "x");
    await gw.deletePath(convId, "dir/.keep");
    const del = findTool("workspace_delete");
    const result = await del.execute("c1", { path: "dir", machine: "node-a" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("已删除目录");
  });

  it("非空目录不传 recursive：错误响应带补救提示", async () => {
    await gw.writeFile(convId, "tree/a.txt", "a");
    const del = findTool("workspace_delete");
    const result = await del.execute("c1", { path: "tree", machine: "node-a" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("recursive");
    expect(await gw.readFile(convId, "tree/a.txt")).toBe("a");
  });

  it("recursive=true 整树删除非空目录", async () => {
    await gw.writeFile(convId, "tree/a.txt", "a");
    await gw.writeFile(convId, "tree/sub/b.txt", "b");
    const del = findTool("workspace_delete");
    const result = await del.execute("c1", { path: "tree", recursive: true, machine: "node-a" });
    expect(result.isError).toBeFalsy();
    await expect(gw.readFile(convId, "tree/a.txt")).rejects.toThrow();
  });

  it("空 path：拒绝并说明工作区根不可删", async () => {
    const del = findTool("workspace_delete");
    const result = await del.execute("c1", { path: "", machine: "node-a" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("不能为空");
  });

  it("路径穿越：错误响应（网关边界透传）", async () => {
    const del = findTool("workspace_delete");
    const result = await del.execute("c1", { path: "../victim.txt", recursive: true, machine: "node-a" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Path traversal");
  });

  it("目标不存在：错误响应", async () => {
    const del = findTool("workspace_delete");
    const result = await del.execute("c1", { path: "ghost.txt", machine: "node-a" });
    expect(result.isError).toBe(true);
  });

  it("池回调缺省（旧装配）：缺 machine 仍拦截，降级文案指向感知工具", async () => {
    const bareCtx = { conversationId: convId, otterId: "otter-1", currentMessageId: "m1" } as unknown as ToolContext;
    const tools = createWorkspaceTools(bareCtx, runner);
    const list = tools.find((t) => t.name === "workspace_list")!;
    const result = await list.execute("c1", { path: "." });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("list_execution_machines");
  });
});
