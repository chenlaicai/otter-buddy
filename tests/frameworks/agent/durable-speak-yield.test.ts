import { createTestExecutionMachineRegistry } from "../../helpers/execution-machine";
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DurableSession } from "../../../src/frameworks/agent/durable-session";
import { DurableEventStream } from "../../../src/frameworks/agent/durable-event-stream";
import { createInvokeRegister } from "../../../src/frameworks/agent/tool-builder";
import { createEventHandler } from "../../../src/frameworks/agent/agent-event-utils";
import { createTools } from "../../../src/interface-adapters/agent-runtime/tools/tool-factory";
import type { ToolContext } from "../../../src/usecases/ports/agent-tools";
import type { OtterToolClient } from "../../../src/usecases/ports/otter-tool-client";
import type { Logger } from "../../../src/usecases/ports/logger";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

describe("#1837 durable invoke 直出文本纠错后 speak→yield", () => {
  it("普通文本+yield 收到专项错误；随后 speak 落库并允许交棒", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-durable-speak-yield-"));
    const faux = fauxProvider({});
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("这是只有模型自己可见的草稿"),
        fauxToolCall("yield", { to: ["大獭"] }, { id: "yield-before-speak" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("speak", { body: "正式发言" }, { id: "speak-after-error" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("yield", { to: ["大獭"] }, { id: "yield-after-speak" }), { stopReason: "toolUse" }),
    ]);

    const entries: Array<{ type: "speak" | "yield"; id: string; body?: string }> = [];
    const client = {
      conversation: {
        participant: { getActive: async () => [{ otterId: "big", otterName: "大獭", status: "active" }] },
        entry: {
          createSpeakEntry: async ({ body }: { body: string }) => {
            const entry = { id: "speak-entry-1", entryType: "speak", sequenceNum: 1, createdAt: new Date().toISOString() };
            entries.push({ type: "speak", id: entry.id, body });
            return entry;
          },
          createYieldEntry: async () => {
            const entry = { id: "yield-entry-1" };
            entries.push({ type: "yield", id: entry.id });
            return { yieldEntry: entry, invokeEndEntry: { id: "invoke-end-1" } };
          },
        },
      },
      otter: { getById: async () => ({ id: "big", name: "大獭", type: "big", color: null }) },
      dispatch: { markDispatched: async () => {} },
    } as unknown as OtterToolClient;
    const register = createInvokeRegister();
    const ctx: ToolContext = {
      client, otterId: "big", conversationId: "conv", currentMessageId: "message", currentInvokeId: "invoke-scheduled",
      getTurnAssistantText: () => register.turnText.text,
    };
    const customTools = createTools(ctx).filter(tool => tool.name === "speak" || tool.name === "yield").map(tool => ({ ...tool, label: tool.name }));
    const session = await DurableSession.open({
      executionMachines: createTestExecutionMachineRegistry(),
      otterId: "big", file: path.join(dir, "session.sqlite"), models, model: faux.getModel(), cwd: tmpdir(), logger,
      register, invokeId: "invoke-scheduled", context: BACKGROUND_CONTEXT,
      tools: { codingTools: [], customTools },
    });
    const events: Array<{ type?: string; toolName?: string }> = [];
    const stream = new DurableEventStream(createEventHandler(undefined, event => events.push(event as { type?: string }), register.turnText));
    await session.prompt("scheduled task", undefined, stream, BACKGROUND_CONTEXT);

    expect(entries).toEqual([
      { type: "speak", id: "speak-entry-1", body: "正式发言" },
      { type: "yield", id: "yield-entry-1" },
    ]);
    expect(ctx.lastSpeakMessageId).toBeUndefined();
    expect(events.filter(event => event.type === "tool_execution_end").map(event => event.toolName)).toEqual(["yield", "speak", "yield"]);
    const context = await session.rawContext(BACKGROUND_CONTEXT);
    const results = context.entries.filter(entry => entry.kind === "pi.tool-result").map(entry => entry.model?.[0] as { toolName?: string; isError?: boolean; content?: Array<{ text?: string }> });
    expect(results[0]).toMatchObject({ toolName: "yield", isError: true });
    expect(results[0].content?.[0].text).toContain("speak(body)");
    expect(results[1]).toMatchObject({ toolName: "speak", isError: false });
    expect(results[2]).toMatchObject({ toolName: "yield", isError: false });
    await session.close(BACKGROUND_CONTEXT);
  });
});

describe("#1837 durable watch 新 invoke 边界", () => {
  it("初始视图只发射本轮边界后的 entries，不回放历史 speak", async () => {
    const events: Array<{ type?: string; toolName?: string; toolCallId?: string }> = [];
    const stream = new DurableEventStream(event => events.push(event as { type?: string; toolName?: string }), undefined, 10);
    const assistant = (id: number, callId: string) => ({
      id, kind: "pi.assistant",
      model: [{ role: "assistant", content: [{ type: "toolCall", id: callId, name: "speak", arguments: { body: callId } }] }],
    });
    await stream.apply({ entries: [assistant(10, "historical-speak"), assistant(11, "current-speak")] } as never, []);
    expect(events.filter(event => event.type === "tool_execution_start").map(event => event.toolCallId)).toEqual(["current-speak"]);
  });
});
