import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DurableSession } from "@frameworks/agent/durable-session";
import { DurableEventStream } from "@frameworks/agent/durable-event-stream";
import { createInvokeRegister } from "@frameworks/agent/tool-builder";
import { createTestExecutionMachineRegistry, inlineNodeMachine } from "../../helpers/execution-machine";
import type { Logger } from "@usecases/ports/logger";
import type { ExecutionMachine, ExecutionMachinePoolSnapshot } from "@usecases/ports/execution-machine";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

/**
 * 统一注册制下的 SDK 工具链集成（真链）：
 * - machine 壳形态：SDK 四工具带必选 machine 参数 → gate → 显式 resolve → env 重建真跑
 * - 默认 env 是占位（方法调用 fail-closed）——真执行全部经壳重建，占位 env 从不被执行
 * - 远程机器 env 的 conversationId 传递（invoke 级 ALS 上下文）
 */

function poolWith(machines: Array<{ id: string; online?: boolean }>): () => Promise<ExecutionMachinePoolSnapshot> {
  return async () => ({
    machines: machines.map(m => ({ id: m.id, name: m.id, online: m.online ?? true, lastSeenAt: null })),
  });
}

describe("durable coding tools through machine-scoped shells (uniform registration)", () => {
  it("真实 write/bash/read 经 machine 壳落显式机器执行且结果可观察（默认 env 为占位不被执行）", { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "durable-scoped-machine-"));
    const file = path.join(dir, "nested", "result.txt");
    const faux = fauxProvider({});
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: file, content: "scoped-file-ok", machine: "test-node" }, { id: "write-call" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf scoped-bash-ok", timeout: 5, machine: "test-node" }, { id: "bash-call" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: file, machine: "test-node" }, { id: "read-call" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("scoped-tools-complete"),
    ]);
    const session = await DurableSession.open({
      otterId: "otter",
      file: path.join(dir, "session.sqlite"),
      models,
      model: faux.getModel(),
      cwd: dir,
      executionMachines: createTestExecutionMachineRegistry(inlineNodeMachine("test-node")),
      machinePool: poolWith([{ id: "test-node" }]),
      logger,
      register: createInvokeRegister(),
      invokeId: "invoke-scoped-machine",
      context: BACKGROUND_CONTEXT,
      tools: { codingTools: ["write", "bash", "read"], customTools: [] },
    });

    try {
      const events: unknown[] = [];
      await session.prompt("exercise machine-scoped tools", undefined, new DurableEventStream(event => events.push(event)), BACKGROUND_CONTEXT);

      expect(await readFile(file, "utf8")).toBe("scoped-file-ok");
      expect(session.turnText).toBe("scoped-tools-complete");
      const toolResults = JSON.stringify(events.filter(event => (event as { type?: string }).type === "tool_execution_end"));
      expect(toolResults).toContain("scoped-bash-ok");
      expect(toolResults).toContain("scoped-file-ok");
      // 落点标记（diagnostic）：model-visible 通道可见实际执行机器
      expect(JSON.stringify(events)).toContain("execution machine: test-node");
    } finally {
      await session.close(BACKGROUND_CONTEXT);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("缺 machine 的 SDK 工具调用 fail-closed 报错（占位 env 不兜底）", { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "durable-scoped-gate-"));
    const faux = fauxProvider({});
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf should-not-run", timeout: 5 }, { id: "bash-no-machine" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("gate-complete"),
    ]);
    const session = await DurableSession.open({
      otterId: "otter-gate",
      file: path.join(dir, "session.sqlite"),
      models,
      model: faux.getModel(),
      cwd: dir,
      executionMachines: createTestExecutionMachineRegistry(inlineNodeMachine("test-node")),
      machinePool: poolWith([{ id: "test-node" }]),
      logger,
      register: createInvokeRegister(),
      invokeId: "invoke-scoped-gate",
      context: BACKGROUND_CONTEXT,
      tools: { codingTools: ["bash"], customTools: [] },
      haltRegistry: { takeForBlock: () => [], isHalted: () => false },
    });
    try {
      const events: unknown[] = [];
      await session.prompt("bash without machine", undefined, new DurableEventStream(event => events.push(event)), BACKGROUND_CONTEXT);
      const toolResults = JSON.stringify(events.filter(event => (event as { type?: string }).type === "tool_execution_end"));
      expect(toolResults).toContain("缺少必选参数 machine");
      expect(toolResults).toContain("test-node");
      expect(toolResults).not.toContain("should-not-run");
    } finally {
      await session.close(BACKGROUND_CONTEXT);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("SDK bash 按显式 machine 选择执行机，物理写入目标机器目录（conversationId 传递远程 env）", { timeout: 20_000 }, async () => {
    const hubDir = await mkdtemp(path.join(tmpdir(), "durable-hub-"));
    const deviceDir = await mkdtemp(path.join(tmpdir(), "durable-device-"));
    const registry = createTestExecutionMachineRegistry(inlineNodeMachine("hub-node"));
    const deviceEnv = inlineNodeMachine("connector-b");
    let envConversationId: string | undefined;
    const remote: ExecutionMachine = {
      id: "connector-b",
      name: "connector-b",
      run: deviceEnv.run.bind(deviceEnv),
      createExecutionEnvironment: (_cwd, conversationId) => {
        envConversationId = conversationId;
        return deviceEnv.createExecutionEnvironment(deviceDir, conversationId);
      },
    };
    registry.register(remote);
    const faux = fauxProvider({});
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf remote-sdk > proof.txt", timeout: 5, machine: "connector-b" }, { id: "remote-bash-call" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("remote-complete"),
    ]);
    const session = await DurableSession.open({
      otterId: "otter-remote",
      file: path.join(hubDir, "session.sqlite"),
      models,
      model: faux.getModel(),
      cwd: hubDir,
      executionMachines: registry,
      machinePool: poolWith([{ id: "hub-node" }, { id: "connector-b" }]),
      logger,
      register: createInvokeRegister(),
      invokeId: "invoke-remote-machine",
      context: BACKGROUND_CONTEXT,
      tools: { codingTools: ["bash"], customTools: [] },
      haltRegistry: { takeForBlock: () => [], isHalted: () => false },
    });
    try {
      const { otterInvokeStorage } = await import("@frameworks/agent/model-runtime-registry");
      const events: unknown[] = [];
      await otterInvokeStorage.run({
        otterId: "otter-remote", otterPromptConfig: "", identityPrefix: "", currentConversationId: "business-c",
      }, () => session.prompt("run remotely", undefined, new DurableEventStream(event => events.push(event)), BACKGROUND_CONTEXT));
      expect(JSON.stringify(events)).not.toContain('"isError":true');
      expect(envConversationId).toBe("business-c");
      expect(await readFile(path.join(deviceDir, "proof.txt"), "utf8")).toBe("remote-sdk");
      await expect(readFile(path.join(hubDir, "proof.txt"), "utf8")).rejects.toThrow();
    } finally {
      await session.close(BACKGROUND_CONTEXT);
      await rm(hubDir, { recursive: true, force: true });
      await rm(deviceDir, { recursive: true, force: true });
    }
  });
});
