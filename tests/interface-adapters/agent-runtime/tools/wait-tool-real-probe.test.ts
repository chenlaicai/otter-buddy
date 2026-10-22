import { describe, expect, it } from "vitest";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ToolContext } from "@usecases/ports/agent-tools";

describe("F20261022wtpr wait 真实子进程输出边界", () => {
  it("stdout 超过 2KB 仍按 exit 0 判就绪，返回上下文截断而非 maxBuffer 杀进程", async () => {
    const tool = createTools({
      client: {},
      otterId: "otter-1",
      conversationId: "conv-1",
      currentMessageId: "msg-1",
    } as unknown as ToolContext).find((candidate) => candidate.name === "wait");
    expect(tool).toBeDefined();

    const result = await tool!.execute("real-large-output", {
      seconds: 5,
      until: "head -c 5000 README.md",
    });
    const text = result.content[0].text;
    expect(text).toContain("until 条件通过（第 1 次探测");
    expect(text).not.toContain("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    const output = text.split("苏醒检查（head）输出：")[1];
    expect(output.length).toBe(2048);
    expect(output).toContain("# Otter Buddy");
  });
});
