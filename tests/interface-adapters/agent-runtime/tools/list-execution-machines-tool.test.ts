/**
 * list_execution_machines 工具单测。
 *
 * F20261125expot PR-1 感知层：注册条件 = ctx.listExecutionMachines 注入；
 * 返回 ExecutionMachinePoolSnapshot JSON；数据源故障 fail-loud（isError）。
 */
import { describe, it, expect } from "vitest";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ToolContext } from "@usecases/ports/agent-tools";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";
import type { ExecutionMachinePoolSnapshot } from "@usecases/ports/execution-machine";

function makeCtx(options?: { pool?: () => Promise<ExecutionMachinePoolSnapshot> }): ToolContext {
  return {
    client: {} as OtterToolClient,
    otterId: "otter-1",
    conversationId: "conv-1",
    currentMessageId: "msg-1",
    ...(options?.pool ? { listExecutionMachines: options.pool } : {}),
  };
}

const SNAPSHOT: ExecutionMachinePoolSnapshot = {
  machines: [
    { id: "local", name: "hub-local", online: true, lastSeenAt: null },
    { id: "dev-111", name: "旧笔记本", online: true, lastSeenAt: "2026-11-25T02:00:00Z" },
    { id: "dev-222", name: "台式机", online: false, lastSeenAt: null },
  ],
  currentMachineId: "local",
};

function findTool(ctx: ToolContext) {
  const tools = createTools(ctx);
  return { all: tools, tool: tools.find((t) => t.name === "list_execution_machines") };
}

describe("list_execution_machines 工具", () => {
  it("ctx.listExecutionMachines 注入时注册", () => {
    const { tool } = findTool(makeCtx({ pool: async () => SNAPSHOT }));
    expect(tool).toBeDefined();
  });

  it("ctx.listExecutionMachines 缺省时不注册（旧装配零变化）", () => {
    const { tool } = findTool(makeCtx());
    expect(tool).toBeUndefined();
  });

  it("返回机器池快照 JSON（local + 设备含在线状态与最近在线时间）", async () => {
    const { tool } = findTool(makeCtx({ pool: async () => SNAPSHOT }));
    const result = await tool!.execute("call-1", {});
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(SNAPSHOT);
    expect(parsed.machines[0].online).toBe(true);
    expect(parsed.machines[2].online).toBe(false);
    expect(parsed.machines[2].lastSeenAt).toBeNull();
  });

  it("数据源故障 → isError 且错误文本含失败原因（fail-loud，不吞数据源异常）", async () => {
    const { tool } = findTool(
      makeCtx({
        pool: async () => {
          throw new Error("db unavailable");
        },
      }),
    );
    const result = await tool!.execute("call-2", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("db unavailable");
  });

  it("无参数调用合法（parameters 空 schema；多余参数不报错也不消费）", async () => {
    const { tool } = findTool(makeCtx({ pool: async () => SNAPSHOT }));
    const result = await tool!.execute("call-3", { unexpected: true });
    expect(result.isError).toBeFalsy();
  });
});
