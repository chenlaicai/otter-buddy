import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Logger } from "@usecases/ports/logger";
import { rankToolsByQuery } from "./tool-search-tool";

/** tool_search 检索语料的最小面（BM25 只用 name/description/parameters） */
export type ToolSearchCandidate = { name: string; description?: string; parameters?: unknown };

/**
 * Native deferred tool loading; BM25 stays otter-owned, activation is durable control.
 *
 * 候选集只含 deferred 工具（deferred customTools + deferred MCP extraTools），与 SDK 版
 * tool_search 语义一致（candidates = agent.deferred）——loaded 清单只含未激活工具；direct 工具
 * 已直接 offer，不重复搜进 loaded。候选集用 getter 延迟求值：MCP extraTools 在 open() 阶段才就位，
 * 构造时固定数组会漏掉它们。
 */
export class DurableToolSearch {
  constructor(private readonly candidates: () => ReadonlyArray<ToolSearchCandidate>, private readonly logger: Logger) {}
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
        const candidates = this.candidates().filter(t => t.name !== "tool_search");
        const hits = rankToolsByQuery(query, candidates, typeof args.limit === "number" ? args.limit : 8);
        const names = hits.map(hit => hit.name);
        this.logger.debug("durable tool_search activated tools", { names });
        return { output: [{ type: "text", text: JSON.stringify({ tools: hits, loaded: names }) }], control: { addTools: names } };
      },
    });
  }
}
