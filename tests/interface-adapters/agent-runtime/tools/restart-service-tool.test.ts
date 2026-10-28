import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@usecases/ports/agent-tools";

const execute = vi.hoisted(() => vi.fn());
vi.mock("@frameworks/agent/restart-service-executor", () => ({ runRestartService: execute }));

import { createRestartServiceTool } from "@interface-adapters/agent-runtime/tools/tool-factory";

const ctx = { otterId: "otter-test", conversationId: "conversation-test" } as ToolContext;

describe("restart_service 受控脚本边界", () => {
  it("执行结果原样映射；工具 schema 不暴露 PID 或 --add", async () => {
    execute.mockResolvedValue({ isError: false, text: "no listener" });
    const tool = createRestartServiceTool(ctx);
    expect(tool.parameters.properties).not.toHaveProperty("pid");
    expect(tool.parameters.properties).not.toHaveProperty("add");
    const result = await tool.execute("restart", { port: 65534, projectDir: "/tmp/owned-project" });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("no listener");
  });

  it("脚本失败保留错误语义", async () => {
    execute.mockResolvedValueOnce({ isError: true, text: "归属校验失败" });
    const result = await createRestartServiceTool(ctx).execute("failed", { port: 3100 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("归属校验失败");
  });

  it("相对 projectDir 在执行副作用前拒绝", async () => {
    execute.mockClear();
    const result = await createRestartServiceTool(ctx).execute("bad-path", { port: 3100, projectDir: "relative" });
    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});
