import { describe, expect, it } from "vitest";
import { composePrompt } from "@frameworks/agent/prompt-composer";

const scope = { otterId: "otter", conversationId: "conversation", otterType: "big" } as const;
const assets = {
  systemPrompt: "SYSTEM",
  skillsPrompt: "SKILLS",
  revisions: { system: "system-revision", skills: "skills-revision" },
};

describe("PromptComposer", () => {
  it("内部档以 SYSTEM/身份/Skill/任务/MCP 的单一路径渲染，并给出内容 revision", () => {
    const composed = composePrompt({
      scope, identity: "IDENTITY", assets, taskConfig: {
        systemPrompt: "TASK",
        reminders: [{ content: "LOW", priority: "low" }, { content: "HIGH", priority: "high" }],
      }, mcpInstructions: "MCP",
    });

    expect(composed.text).toBe([
      "SYSTEM", "IDENTITY", "SKILLS", "TASK\n\n<system-reminder>\nHIGH\n</system-reminder>\n\n<system-reminder>\nLOW\n</system-reminder>", "MCP",
    ].join("\n\n"));
    expect(composed.sections.map(section => section.kind)).toEqual(["system", "identity", "skills", "task", "mcp"]);
    expect(composed.sections.every(section => /^[a-f0-9]{64}$/.test(section.revision) && section.bytes > 0)).toBe(true);
    expect(composePrompt({ scope, identity: "IDENTITY", assets, taskConfig: "TASK", mcpInstructions: "MCP" }).revision)
      .not.toBe(composed.revision);
  });

  it("restricted 只渲染中性身份、公开任务和公开 MCP，安全覆盖固定最后", () => {
    const composed = composePrompt({
      scope: { ...scope, externalProfile: "restricted" },
      externalTaskConfig: { instructions: "PUBLIC", reminders: [{ content: "REMINDER" }] },
      publicMcpInstructions: "PUBLIC_MCP",
    });

    expect(composed.text).toContain("PUBLIC");
    expect(composed.text).toContain("REMINDER");
    expect(composed.text).toContain("PUBLIC_MCP");
    expect(composed.text).not.toContain("SYSTEM");
    expect(composed.sections.map(section => section.kind)).toEqual(["identity", "task", "mcp", "safety"]);
    expect(composed.text.lastIndexOf("受限外部会话安全边界")).toBeGreaterThan(composed.text.indexOf("PUBLIC_MCP"));
  });

  it("restricted 缺省公开任务时仍是安全最简面", () => {
    const composed = composePrompt({ scope: { ...scope, externalProfile: "restricted" } });
    expect(composed.sections.map(section => section.kind)).toEqual(["identity", "safety"]);
    expect(composed.text).toContain("当前外部会话的助理");
    expect(composed.text).toContain("受限外部会话安全边界");
  });
});
