import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Logger } from "@usecases/ports/logger";
import { rankToolsByQuery } from "./tool-search-tool";
import type { LegacyTool } from "./durable-tool-registry";

/** Native deferred tool loading; BM25 stays otter-owned, activation is durable control. */
export class DurableToolSearch {
  constructor(private readonly tools: LegacyTool[], private readonly logger: Logger) {}
  registration(): ToolRegistration<any> {
    return defineTool<any>({
      name: "tool_search",
      description: "Search deferred tools by keyword. Call this before using a tool that is not currently declared.",
      parameters: {
        type: "object", properties: { query: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 50 } }, required: ["query"], additionalProperties: false,
      },
      replay: "unsafe",
      executionMode: "sequential",
      execute: async (args) => {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) return { output: [{ type: "text", text: "query must be a non-empty string" }], isError: true };
        const hits = rankToolsByQuery(query, this.tools.filter(t => t.name !== "tool_search"), typeof args.limit === "number" ? args.limit : 8);
        const names = hits.map(hit => hit.name);
        this.logger.debug("durable tool_search activated tools", { names });
        return { output: [{ type: "text", text: JSON.stringify({ tools: hits, loaded: names }) }], control: { addTools: names } };
      },
    });
  }
}
