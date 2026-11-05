import type { JsonObject } from "@earendil-works/pi-durable";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ToolResponse } from "@usecases/ports/agent-tools";

export type LegacyTool = {
  name: string;
  label: string;
  description: string;
  parameters: object;
  prepareArguments?: (args: unknown) => Record<string, unknown>;
  execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResponse>;
};

/** Every Otter/MCP side effect is unsafe to replay. A fresh invoke is explicit. */
export function toDurableTool(tool: LegacyTool): ToolRegistration<any> {
  return defineTool<any>({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    replay: "unsafe",
    prepareArguments: tool.prepareArguments,
    execute: async (args, api: ToolExecutionApi, context) => {
      const response = await tool.execute(api.callId, args, context.abortSignal);
      return {
        output: response.content,
        details: response.details as never,
        isError: response.isError ?? false,
        control: { terminate: response.terminate ?? false },
      };
    },
  });
}

export function asJsonObject(args: Record<string, unknown>): JsonObject {
  return args as JsonObject;
}
