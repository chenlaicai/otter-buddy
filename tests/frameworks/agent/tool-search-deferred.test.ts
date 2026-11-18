/**
 * #1894 回归：tool_search 只检索 deferred 工具，加载后跨 prompt 与跨 reopen 均可调用。
 *
 * 根因（修复前）：
 * 1. DurableSession.prompt() 每轮 configure(agentChange()) 把 state.tools 重置为初始激活集，
 *    覆盖 tool_search control.addTools 的加载结果——下一 invoke 调用报 tool_unavailable。
 * 2. open() 重开同一 durable 库时显式 configure 同样覆盖 addTools 加载——冷启动重开复现 not available。
 * 3. DurableToolSearch 检索全量 customTools（含 direct 工具），loaded 清单虚报。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DurableSession, type DurableSessionOptions } from "../../../src/frameworks/agent/durable-session";
import { DurableEventStream } from "../../../src/frameworks/agent/durable-event-stream";
import { createInvokeRegister } from "../../../src/frameworks/agent/tool-builder";
import { createTestExecutionMachineRegistry } from "../../helpers/execution-machine";
import type { Logger } from "../../../src/usecases/ports/logger";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

type Responses = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];

function makeCustomTools(onTerminology: () => void) {
  return [
    {
      name: "speak", label: "speak", description: "发言工具：向搭档说话",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text" as const, text: "spoke" }], details: {} }),
    },
    {
      name: "add_terminology", label: "add_terminology", description: "术语入库：记录项目域术语定义",
      parameters: { type: "object", properties: {} },
      execute: async () => { onTerminology(); return { content: [{ type: "text" as const, text: "terminology-ok" }], details: {} }; },
    },
  ];
}

async function openSession(file: string, responses: Responses, opts?: { mcp?: DurableSessionOptions["mcp"] }) {
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
      customTools: makeCustomTools(() => { deferredCalls++; }),
    },
    ...(opts?.mcp ? { mcp: opts.mcp } : {}),
  });
  return { session, getDeferredCalls: () => deferredCalls };
}

describe("#1894: tool_search deferred 加载与清单一致性", () => {
  it("同一 prompt 内 tool_search 加载后下一轮可调用 deferred 工具", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-deferred-"));
    const { session, getDeferredCalls } = await openSession(path.join(dir, "session.sqlite"), [
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "术语 入库" }, { id: "search-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("add_terminology", {}, { id: "term-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("load and use", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    expect(getDeferredCalls()).toBe(1);
    await session.close(BACKGROUND_CONTEXT);
  });

  it("跨 prompt（下一 invoke）调用已加载 deferred 工具仍可执行", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-deferred-"));
    const file = path.join(dir, "session.sqlite");
    const { session, getDeferredCalls } = await openSession(file, [
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "术语 入库" }, { id: "search-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("loaded"),
      fauxAssistantMessage([fauxToolCall("add_terminology", {}, { id: "term-2" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("load it", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    await session.prompt("use it", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    expect(getDeferredCalls()).toBe(1);
    await session.close(BACKGROUND_CONTEXT);
  });

  it("冷启动重开同一 durable 库后已加载 deferred 工具仍可调用（检视发现 1 回归）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-deferred-"));
    const file = path.join(dir, "session.sqlite");
    // 第一次 open + prompt：tool_search 加载 add_terminology
    const first = await openSession(file, [
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "术语 入库" }, { id: "search-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("loaded"),
    ]);
    await first.session.prompt("load it", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    await first.session.close(BACKGROUND_CONTEXT);

    // 第二次 open（重开同一 file，执行体换新）——修复前 open() 的 configure 会把加载抹掉
    const second = await openSession(file, [
      fauxAssistantMessage([fauxToolCall("add_terminology", {}, { id: "term-3" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await second.session.prompt("use it", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    const ctx = await second.session.rawContext(BACKGROUND_CONTEXT);
    const hasUnavailable = ctx.entries.some(e => e.kind === "pi.tool-result" && JSON.stringify((e as { model?: unknown }).model).includes("is not available"));
    expect(hasUnavailable).toBe(false);
    await second.session.close(BACKGROUND_CONTEXT);
  });

  it("direct 工具不被搜进 loaded（根因 2 回归）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-deferred-"));
    const { session } = await openSession(path.join(dir, "session.sqlite"), [
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "发言" }, { id: "search-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("search direct tool", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    const ctx = await session.rawContext(BACKGROUND_CONTEXT);
    const toolResult = ctx.entries.find(e => e.kind === "pi.tool-result");
    const content = (toolResult as { model?: Array<{ content?: Array<{ type?: string; text?: string }> }> }).model?.[0]?.content?.[0]?.text ?? "";
    // speak 是 direct 工具，不在候选集内——搜索「发言」命中的 loaded 应为空
    expect(content).toContain('"loaded":[]');
    await session.close(BACKGROUND_CONTEXT);
  });

  it("deferred MCP 工具在 tool_search 检索面内（检视发现 2 回归）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-deferred-"));
    const mcpTools: ToolRegistration[] = [defineTool<any>({
      name: "mcp__fake__echo",
      description: "[MCP fake] echo 回显工具",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      replay: "unsafe",
      deferred: true,
      execute: async () => ({ output: [{ type: "text", text: "echo-ok" }] }),
    })];
    const { session } = await openSession(path.join(dir, "session.sqlite"), [
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "echo" }, { id: "search-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ], {
      mcp: {
        registrations: async () => mcpTools,
        instructions: () => "",
        close: async () => {},
      },
    });
    await session.prompt("search mcp tool", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    const ctx = await session.rawContext(BACKGROUND_CONTEXT);
    const toolResult = ctx.entries.find(e => e.kind === "pi.tool-result");
    const text = JSON.stringify((toolResult as { model?: unknown }).model);
    expect(text).toContain("mcp__fake__echo");
    await session.close(BACKGROUND_CONTEXT);
  });
});
