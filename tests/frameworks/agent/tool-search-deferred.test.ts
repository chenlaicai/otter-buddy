/**
 * #1894 回归：tool_search 只检索 deferred 工具，加载后跨 prompt 与跨 reopen 均可调用。
 *
 * 根因（修复前）：
 * 1. DurableSession.prompt() 每轮 configure(agentChange()) 把 state.tools 重置为初始激活集，
 *    覆盖 tool_search control.addTools 的加载结果——下一 invoke 调用报 tool_unavailable。
 * 2. open()/prompt() 全量 configure 同样覆盖 addTools 加载——冷启动重开复现 not available；
 *    而完全不 configure 又会让重开后的 model/thinkingLevel/cwd 沿用旧 AgentDoc（检视 delta 发现 1）。
 * 3. DurableToolSearch 检索全量 customTools（含 direct 工具），loaded 清单虚报；候选集不含 deferred MCP。
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

function makeCustomTools(onTerminology: () => void, withDeferred = true) {
  const tools = [
    {
      name: "speak", label: "speak", description: "发言工具：向搭档说话",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text" as const, text: "spoke" }], details: {} }),
    },
  ];
  if (withDeferred) {
    tools.push({
      name: "add_terminology", label: "add_terminology", description: "术语入库：记录项目域术语定义",
      parameters: { type: "object", properties: {} },
      execute: async () => { onTerminology(); return { content: [{ type: "text" as const, text: "terminology-ok" }], details: {} }; },
    });
  }
  return tools;
}

interface OpenInit {
  file: string;
  responses: Responses;
  mcp?: DurableSessionOptions["mcp"];
  customTools?: ReturnType<typeof makeCustomTools>;
  toolExposure?: Record<string, "direct" | "deferred">;
  model?: DurableSessionOptions["model"];
  models?: DurableSessionOptions["models"];
  cwd?: string;
}

async function openSession(init: OpenInit) {
  const { file, responses } = init;
  const faux = fauxProvider({});
  faux.setResponses(responses);
  const models = init.models ?? createModels();
  if (init.models === undefined) (models as ReturnType<typeof createModels>).setProvider(faux.provider);
  let deferredCalls = 0;
  const session = await DurableSession.open({
    otterId: "otter", file, models, model: init.model ?? faux.getModel(), cwd: init.cwd ?? tmpdir(), logger,
    executionMachines: createTestExecutionMachineRegistry(),
    register: createInvokeRegister(), invokeId: "invoke-test", context: BACKGROUND_CONTEXT,
    tools: {
      codingTools: [],
      ...(init.toolExposure ? { toolExposure: init.toolExposure } : { toolExposure: { add_terminology: "deferred" } }),
      customTools: init.customTools ?? makeCustomTools(() => { deferredCalls++; }),
    },
    ...(init.mcp ? { mcp: init.mcp } : {}),
  });
  return { session, faux, getDeferredCalls: () => deferredCalls };
}

describe("#1894: tool_search deferred 加载与清单一致性", () => {
  it("同一 prompt 内 tool_search 加载后下一轮可调用 deferred 工具", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-deferred-"));
    const { session, getDeferredCalls } = await openSession({
      file: path.join(dir, "session.sqlite"),
      responses: [
        fauxAssistantMessage([fauxToolCall("tool_search", { query: "术语 入库" }, { id: "search-1" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("add_terminology", {}, { id: "term-1" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ],
    });
    await session.prompt("load and use", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    expect(getDeferredCalls()).toBe(1);
    await session.close(BACKGROUND_CONTEXT);
  });

  it("跨 prompt（下一 invoke）调用已加载 deferred 工具仍可执行", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-deferred-"));
    const file = path.join(dir, "session.sqlite");
    const { session, getDeferredCalls } = await openSession({
      file,
      responses: [
        fauxAssistantMessage([fauxToolCall("tool_search", { query: "术语 入库" }, { id: "search-1" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("loaded"),
        fauxAssistantMessage([fauxToolCall("add_terminology", {}, { id: "term-2" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ],
    });
    await session.prompt("load it", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    await session.prompt("use it", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    expect(getDeferredCalls()).toBe(1);
    await session.close(BACKGROUND_CONTEXT);
  });

  it("冷启动重开同一 durable 库后已加载 deferred 工具仍可调用（检视发现 1 回归）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-deferred-"));
    const file = path.join(dir, "session.sqlite");
    // 第一次 open + prompt：tool_search 加载 add_terminology
    const first = await openSession({
      file,
      responses: [
        fauxAssistantMessage([fauxToolCall("tool_search", { query: "术语 入库" }, { id: "search-1" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("loaded"),
      ],
    });
    await first.session.prompt("load it", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    await first.session.close(BACKGROUND_CONTEXT);

    // 第二次 open（重开同一 file）——修复前 open() 的 configure 会把加载抹掉
    const second = await openSession({
      file,
      responses: [
        fauxAssistantMessage([fauxToolCall("add_terminology", {}, { id: "term-3" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ],
    });
    await second.session.prompt("use it", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    const ctx = await second.session.rawContext(BACKGROUND_CONTEXT);
    const hasUnavailable = ctx.entries.some(e => e.kind === "pi.tool-result" && JSON.stringify((e as { model?: unknown }).model).includes("is not available"));
    expect(hasUnavailable).toBe(false);
    await second.session.close(BACKGROUND_CONTEXT);
  });

  it("direct 工具不被搜进 loaded（根因 2 回归）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-deferred-"));
    const { session } = await openSession({
      file: path.join(dir, "session.sqlite"),
      responses: [
        fauxAssistantMessage([fauxToolCall("tool_search", { query: "发言" }, { id: "search-1" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ],
    });
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
    const { session } = await openSession({
      file: path.join(dir, "session.sqlite"),
      responses: [
        fauxAssistantMessage([fauxToolCall("tool_search", { query: "echo" }, { id: "search-1" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ],
      mcp: {
        registrations: async () => mcpTools,
        instructions: () => "",
        close: async () => {},
      },
    });
    await session.prompt("search mcp tool", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    const ctx = await session.rawContext(BACKGROUND_CONTEXT);
    const toolResult = ctx.entries.find(e => e.kind === "pi.tool-result");
    const content = (toolResult as { model?: Array<{ content?: Array<{ type?: string; text?: string }> }> }).model?.[0]?.content?.[0]?.text ?? "";
    expect(content).toContain("mcp__fake__echo");
    await session.close(BACKGROUND_CONTEXT);
  });

  it("MCP-only session（无 custom deferred）也注册 tool_search 并可检索 deferred MCP（检视 delta 发现 2 回归）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-deferred-"));
    const mcpTools: ToolRegistration[] = [defineTool<any>({
      name: "mcp__fake__echo",
      description: "[MCP fake] echo 回显工具",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      replay: "unsafe",
      deferred: true,
      execute: async () => ({ output: [{ type: "text", text: "echo-ok" }] }),
    })];
    // customTools 全 direct（无 deferred）——旧代码 deferredTools.length===0 不会注册 tool_search
    const { session } = await openSession({
      file: path.join(dir, "session.sqlite"),
      responses: [
        fauxAssistantMessage([fauxToolCall("tool_search", { query: "echo" }, { id: "search-1" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ],
      customTools: makeCustomTools(() => {}, false),
      toolExposure: {},
      mcp: {
        registrations: async () => mcpTools,
        instructions: () => "",
        close: async () => {},
      },
    });
    await session.prompt("search mcp-only tool", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    const ctx = await session.rawContext(BACKGROUND_CONTEXT);
    const toolResult = ctx.entries.find(e => e.kind === "pi.tool-result");
    const content = (toolResult as { model?: Array<{ content?: Array<{ type?: string; text?: string }> }> }).model?.[0]?.content?.[0]?.text ?? "";
    expect(content).toContain("mcp__fake__echo");
    await session.close(BACKGROUND_CONTEXT);
  });

  it("重开时 model 刷新生效，已加载 deferred 工具仍可调用（检视 delta 发现 1 回归）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-deferred-"));
    const file = path.join(dir, "session.sqlite");

    // 第一次 open：faux-a 模型，加载 deferred
    const fauxA = fauxProvider({});
    const modelsA = createModels();
    modelsA.setProvider(fauxA.provider);
    fauxA.setResponses([
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "术语 入库" }, { id: "search-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("loaded"),
    ]);
    const first = await openSession({ file, responses: [], models: modelsA, model: fauxA.getModel() });
    await first.session.prompt("load it", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    await first.session.close(BACKGROUND_CONTEXT);

    // 第二次 open：faux-b 模型（与 faux-a 不同 provider）——修复前 AgentDoc 沿用旧 model-a，
    // 当前 models 注册表里没有 faux-a，模型解析失败；修复后刷新为 model-b，正常返回。
    const fauxB = fauxProvider({});
    const modelsB = createModels();
    modelsB.setProvider(fauxB.provider);
    fauxB.setResponses([
      fauxAssistantMessage([fauxToolCall("add_terminology", {}, { id: "term-5" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("from-b"),
    ]);
    const second = await openSession({ file, responses: [], models: modelsB, model: fauxB.getModel() });
    await second.session.prompt("use after reopen with new model", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    expect(second.session.turnText).toBe("from-b");
    const ctx = await second.session.rawContext(BACKGROUND_CONTEXT);
    const hasUnavailable = ctx.entries.some(e => e.kind === "pi.tool-result" && JSON.stringify((e as { model?: unknown }).model).includes("is not available"));
    expect(hasUnavailable).toBe(false);
    await second.session.close(BACKGROUND_CONTEXT);
  });
});