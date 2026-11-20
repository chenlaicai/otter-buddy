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
import { createTestExecutionMachineRegistry } from "../../helpers/execution-machine";
import { SqliteActionLedger } from "@frameworks/execution/ledger/sqlite-action-ledger";
import type { Logger } from "@usecases/ports/logger";
import { ConversationActionRouter } from "@usecases/execution/conversation-action-router";
import type { ExecutionMachine } from "@usecases/ports/execution-machine";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

describe("durable coding tools through LocalExecutionMachine", () => {
  it("真实 write/bash/read 均在本机执行且保持结果可观察", { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "durable-local-machine-"));
    const file = path.join(dir, "nested", "result.txt");
    const faux = fauxProvider({});
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: file, content: "local-file-ok" }, { id: "write-call" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf local-bash-ok", timeout: 5 }, { id: "bash-call" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: file }, { id: "read-call" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("local-tools-complete"),
    ]);
    const session = await DurableSession.open({
      otterId: "otter",
      file: path.join(dir, "session.sqlite"),
      models,
      model: faux.getModel(),
      cwd: dir,
      executionMachines: createTestExecutionMachineRegistry(dir),
      logger,
      register: createInvokeRegister(),
      invokeId: "invoke-local-machine",
      context: BACKGROUND_CONTEXT,
      tools: { codingTools: ["write", "bash", "read"], customTools: [] },
    });

    try {
      const events: unknown[] = [];
      await session.prompt("exercise local tools", undefined, new DurableEventStream(event => events.push(event)), BACKGROUND_CONTEXT);

      expect(await readFile(file, "utf8")).toBe("local-file-ok");
      expect(session.turnText).toBe("local-tools-complete");
      const toolResults = JSON.stringify(events.filter(event => (event as { type?: string }).type === "tool_execution_end"));
      expect(toolResults).toContain("local-bash-ok");
      expect(toolResults).toContain("local-file-ok");
    } finally {
      await session.close(BACKGROUND_CONTEXT);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("F20261116actlg：真实 write/bash 副作用入账（invoke/toolCall 归属经 ALS 穿透 SDK 执行链）", { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "durable-ledger-"));
    const file = path.join(dir, "ledger-attrib.txt");
    const faux = fauxProvider({});
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: file, content: "ledger-content" }, { id: "ledger-write-call" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf ledger-bash", timeout: 5 }, { id: "ledger-bash-call" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const ledger = new SqliteActionLedger(path.join(dir, "actions.db"));
    const session = await DurableSession.open({
      otterId: "otter-ledger",
      file: path.join(dir, "session.sqlite"),
      models,
      model: faux.getModel(),
      cwd: dir,
      executionMachines: createTestExecutionMachineRegistry(dir, ledger),
      logger,
      register: createInvokeRegister(),
      invokeId: "invoke-ledger-1",
      context: BACKGROUND_CONTEXT,
      tools: { codingTools: ["write", "bash"], customTools: [] },
      haltRegistry: { takeForBlock: () => [], isHalted: () => false },
    });

    try {
      // 生产路径：pi-session-factory execute 包 otterInvokeStorage.run 后调 prompt；
      // 直呼测试需同样包作用域，invoke/toolCall 归属才能穿透 SDK 执行链进台账。
      const { otterInvokeStorage } = await import("@frameworks/agent/model-runtime-registry");
      await otterInvokeStorage.run({ otterId: "otter-ledger", otterPromptConfig: "", identityPrefix: "" } as never, () =>
        session.prompt("exercise ledger attribution", undefined, new DurableEventStream(() => undefined), BACKGROUND_CONTEXT),
      );
      const rows = await ledger.listByInvoke("invoke-ledger-1");
      expect(rows).toHaveLength(2);
      const writeRow = rows.find(r => r.kind === "file.write");
      const execRow = rows.find(r => r.kind === "shell.exec");
      expect(writeRow?.toolCallId).toBe("ledger-write-call");
      expect(writeRow?.status).toBe("succeeded");
      expect(writeRow?.actionId).toBe(`ledger-write-call:${ledger.bootEpoch}:1`);
      expect(execRow?.toolCallId).toBe("ledger-bash-call");
      expect(execRow?.status).toBe("succeeded");
      expect(JSON.parse(execRow?.resultSummary ?? "{}")).toMatchObject({ exitCode: 0 });
      expect(await readFile(file, "utf8")).toBe("ledger-content");
    } finally {
      await session.close(BACKGROUND_CONTEXT);
      ledger.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("SDK bash 按 ALS 业务对话选择执行机，物理写入设备侧目录", { timeout: 20_000 }, async () => {
    const hubDir = await mkdtemp(path.join(tmpdir(), "durable-hub-"));
    const deviceDir = await mkdtemp(path.join(tmpdir(), "durable-device-"));
    const registry = createTestExecutionMachineRegistry(hubDir);
    const deviceLocal = createTestExecutionMachineRegistry(deviceDir);
    let envConversationId: string | undefined;
    const remote: ExecutionMachine = {
      id: "connector-b",
      run: (action, target, options) => deviceLocal.run(action, target, options),
      createExecutionEnvironment: (_cwd, conversationId) => {
        envConversationId = conversationId;
        return deviceLocal.resolve().createExecutionEnvironment(deviceDir, conversationId);
      },
    };
    registry.register(remote);
    const router = new ConversationActionRouter(registry, {
      getExecutionMachineId: async id => id === "business-c" ? "connector-b" : null,
    });
    const faux = fauxProvider({});
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf remote-sdk > proof.txt", timeout: 5 }, { id: "remote-bash-call" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("remote-complete"),
    ]);
    const session = await DurableSession.open({
      otterId: "otter-remote",
      file: path.join(hubDir, "session.sqlite"),
      models,
      model: faux.getModel(),
      cwd: hubDir,
      executionMachines: router,
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
