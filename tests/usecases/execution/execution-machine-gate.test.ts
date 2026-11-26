import { describe, it, expect } from "vitest";
import { gateExecutionMachine } from "@usecases/execution/execution-machine-gate";
import type { ExecutionMachinePoolSnapshot } from "@usecases/ports/execution-machine";

function poolWith(machines: ExecutionMachinePoolSnapshot["machines"]): () => Promise<ExecutionMachinePoolSnapshot> {
  return async () => ({ machines });
}

const TWO_MACHINE_POOL = poolWith([
  { id: "node-a", name: "中枢本机", online: true, lastSeenAt: null },
  { id: "dev-box", name: "开发机", online: false, lastSeenAt: "2026-11-25T14:02:00Z" },
]);

describe("execution-machine-gate: 三失败路径 + 通过路径", () => {
  it("缺参：报错含必选语义声明、fail-closed 声明与机器池全量清单", async () => {
    const result = await gateExecutionMachine(undefined, TWO_MACHINE_POOL);
    expect(result.ok).toBe(false);
    const text = result.ok ? "" : result.message;
    expect(text).toContain("缺少必选参数 machine");
    expect(text).toContain("fail-closed");
    expect(text).toContain("- node-a（中枢本机，在线");
    expect(text).toContain("- dev-box（开发机，离线");
    expect(text).toContain("list_execution_machines");
  });

  it("空串参数：同缺参路径（形态校验拒绝）", async () => {
    const result = await gateExecutionMachine("", TWO_MACHINE_POOL);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain("缺少必选参数 machine");
  });

  it("指定机器不在池中：报错含指定 id 与重试指引", async () => {
    const result = await gateExecutionMachine("ghost-machine", TWO_MACHINE_POOL);
    expect(result.ok).toBe(false);
    const text = result.ok ? "" : result.message;
    expect(text).toContain('"ghost-machine" 不在机器池中');
    expect(text).toContain("不自动换机");
    expect(text).toContain("- node-a（中枢本机，在线");
  });

  it("指定机器离线：报错标注离线与 lastSeen", async () => {
    const result = await gateExecutionMachine("dev-box", TWO_MACHINE_POOL);
    expect(result.ok).toBe(false);
    const text = result.ok ? "" : result.message;
    expect(text).toContain('"dev-box"');
    expect(text).toContain('当前离线');
    expect(text).toContain("lastSeen 2026-11-25T14:02:00Z");
    expect(text).toContain("不自动换机");
  });

  it("指定在线机器：通过并携带规范化 machineId", async () => {
    const result = await gateExecutionMachine("node-a", TWO_MACHINE_POOL);
    expect(result).toEqual({ ok: true, machineId: "node-a" });
  });

  it("池快照回调抛错：fail-loud 拒绝执行且不吞异常文本", async () => {
    const broken = async () => { throw new Error("pool projection exploded"); };
    const result = await gateExecutionMachine("node-a", broken);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain("pool projection exploded");
  });

  it("池回调缺省：降级为形态校验 + 指向感知工具的提示", async () => {
    const missing = await gateExecutionMachine(undefined);
    expect(missing.ok).toBe(false);
    expect(missing.ok ? "" : missing.message).toContain("list_execution_machines");
    const okShape = await gateExecutionMachine("node-a");
    expect(okShape).toEqual({ ok: true, machineId: "node-a" });
  });
});
