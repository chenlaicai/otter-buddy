/**
 * #1894 回归：tool_search 加载 deferred 工具后，跨 prompt（下一 invoke）仍可调用。
 *
 * 根因（修复前）：DurableSession.prompt() 每轮 `configure(this.agentChange())` 把 state.tools 重置为
 * 初始激活集（deferred 工具被重新过滤掉），覆盖了 tool_search `control.addTools` 的加载结果；
 * 下一 invoke 模型调用该工具得到 `Tool <name> is not available`。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DurableSession } from "../../../src/frameworks/agent/durable-session";
import { DurableEventStream } from "../../../src/frameworks/agent/durable-event-stream";
import { createInvokeRegister } from "../../../src/frameworks/agent/tool-builder";
import { createTestExecutionMachineRegistry } from "../../helpers/execution-machine";
import type { Logger } from "../../../src/usecases/ports/logger";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

async function openWithDeferred(file: string, responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const faux = fauxProvider({});
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  let deferredCalls = 0;
  const session = await DurableSession.open({
    otterId: "otter", file, models, model: faux.getModel(), cwd: tmpdir(), logger,
    executionMachines: createTestExecutionMachineRegistry(),
    register: createInvokeRegister(), invokeId: "invoke-test", context: BACKGROUND_CONTEXT,
    tools: {
      codingTools: [],
      toolExposure: { add_terminology: "deferred" },
      customTools: [
        {
          name: "speak", label: "speak", description: "发言工具：向搭档说话",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [{ type: "text" as const, text: "spoke" }], details: {} }),
        },
        {
          name: "add_terminology", label: "add_terminology", description: "术语入库：记录项目域术语定义",
          parameters: { type: "object", properties: {} },
          execute: async () => { deferredCalls++; return { content: [{ type: "text" as const, text: "terminology-ok" }], details: {} }; },
        },
      ],
    },
  });
  return { session, getDeferredCalls: () => deferredCalls };
}

describe("#1894: tool_search 加载的 deferred 工具跨 prompt 失效", () => {
  it("同一 prompt 内 tool_search 加载后下一轮可调用 deferred 工具", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-deferred-"));
    const { session, getDeferredCalls } = await openWithDeferred(path.join(dir, "session.sqlite"), [
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "术语 入库" }, { id: "search-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("add_terminology", {}, { id: "term-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("load and use", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    expect(getDeferredCalls()).toBe(1);
    await session.close(BACKGROUND_CONTEXT);
  });

  it("跨 prompt（下一 invoke）调用已加载 deferred 工具仍可执行（#1894 修复）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-deferred-"));
    const file = path.join(dir, "session.sqlite");
    const { session, getDeferredCalls } = await openWithDeferred(file, [
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "术语 入库" }, { id: "search-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("loaded"),
      fauxAssistantMessage([fauxToolCall("add_terminology", {}, { id: "term-2" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("load it", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    await session.prompt("use it", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    // 修复前：prompt 2 开头 configure 重置 state.tools（toolsRemoved: add_terminology），
    // 模型调用得到 tool_unavailable，工具不执行（calls=0）。修复后应真正执行。
    expect(getDeferredCalls()).toBe(1);
    await session.close(BACKGROUND_CONTEXT);
  });
});
