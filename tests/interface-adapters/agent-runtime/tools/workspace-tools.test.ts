/**
 * #1484：workspace_delete 工具面测试（临时件回收机械路径）。
 * 用真实 NodeWorkspaceGateway 走 tmpdir，覆盖工具层参数校验 + 网关安全边界的透传。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createWorkspaceTools } from "@interface-adapters/agent-runtime/tools/workspace-tools";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";
import type { ToolContext } from "@usecases/ports/agent-tools";

describe("workspace-tools: workspace_delete（#1484）", () => {
  let tmpDir: string;
  let gw: NodeWorkspaceGateway;
  const convId = "test-conv-del";
  const ctx = { conversationId: convId, otterId: "otter-1", currentMessageId: "m1" } as unknown as ToolContext;

  const findTool = () => {
    const tools = createWorkspaceTools(ctx, gw);
    const del = tools.find((t) => t.name === "workspace_delete");
    expect(del).toBeDefined();
    return del!;
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-tools-test-"));
    gw = new NodeWorkspaceGateway(tmpDir);
    await gw.ensureWorkspace(convId);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("createWorkspaceTools 注册 5 个工具且含 workspace_delete", () => {
    const tools = createWorkspaceTools(ctx, gw);
    expect(tools.map((t) => t.name)).toEqual([
      "workspace_info",
      "workspace_list",
      "workspace_read",
      "workspace_write",
      "workspace_delete",
    ]);
  });

  it("删除文件：返回已删除文件确认", async () => {
    await gw.writeFile(convId, "tmp.txt", "junk");
    const del = findTool();
    const result = await del.execute("c1", { path: "tmp.txt" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("已删除文件");
    expect(result.content[0].text).toContain("tmp.txt");
    await expect(gw.readFile(convId, "tmp.txt")).rejects.toThrow();
  });

  it("删除空目录：返回已删除目录确认", async () => {
    await gw.writeFile(convId, "dir/.keep", "x");
    await gw.deletePath(convId, "dir/.keep");
    const del = findTool();
    const result = await del.execute("c1", { path: "dir" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("已删除目录");
  });

  it("非空目录不传 recursive：错误响应带补救提示", async () => {
    await gw.writeFile(convId, "tree/a.txt", "a");
    const del = findTool();
    const result = await del.execute("c1", { path: "tree" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("recursive");
    // 文件仍在（防误删）
    expect(await gw.readFile(convId, "tree/a.txt")).toBe("a");
  });

  it("recursive=true 整树删除非空目录", async () => {
    await gw.writeFile(convId, "tree/a.txt", "a");
    await gw.writeFile(convId, "tree/sub/b.txt", "b");
    const del = findTool();
    const result = await del.execute("c1", { path: "tree", recursive: true });
    expect(result.isError).toBeFalsy();
    await expect(gw.readFile(convId, "tree/a.txt")).rejects.toThrow();
  });

  it("空 path：拒绝并说明工作区根不可删", async () => {
    const del = findTool();
    const result = await del.execute("c1", { path: "" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("不能为空");
  });

  it("路径穿越：错误响应（网关边界透传）", async () => {
    const del = findTool();
    const result = await del.execute("c1", { path: "../victim.txt", recursive: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Path traversal");
  });

  it("目标不存在：错误响应", async () => {
    const del = findTool();
    const result = await del.execute("c1", { path: "ghost.txt" });
    expect(result.isError).toBe(true);
  });
});
