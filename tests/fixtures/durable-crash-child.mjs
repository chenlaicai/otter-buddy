/* global process, setTimeout */
import { DurableSession } from "../../dist/src/frameworks/agent/durable-session.js";
import { DurableEventStream } from "../../dist/src/frameworks/agent/durable-event-stream.js";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import fs from "node:fs";

const file = process.argv[2];
const marker = `${file}.tool-started`;
const calls = `${file}.calls`;
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage(fauxToolCall("side_effect", {}, { id: "crash-call" }), { stopReason: "toolUse" })]);
const session = await DurableSession.open({
  otterId: "crash-test", file, models, model: faux.getModel(), cwd: process.cwd(),
  logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
  register: { currentInvokeId: "crash-invoke" }, invokeId: "crash-invoke", context: BACKGROUND_CONTEXT,
  tools: { codingTools: [], customTools: [{ name: "side_effect", label: "test", description: "test", parameters: { type: "object" }, execute: async () => {
    fs.appendFileSync(calls, "call\n");
    fs.writeFileSync(marker, "started");
    await new Promise(() => {});
  } }] },
});
void session.prompt("crash", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
while (!fs.existsSync(marker)) await new Promise(resolve => setTimeout(resolve, 10));
