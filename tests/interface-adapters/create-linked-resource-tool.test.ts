import { describe, it, expect } from "vitest";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ToolContext } from "@usecases/ports/agent-tools";
import { FACT_CONTENT_MAX_LENGTH } from "@usecases/conversation/manage-key-info";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";

function makeLinkedResourceTool() {
  const linkCalls: Array<{ content?: string }> = [];
  const client = {
    conversation: {
      getActiveTurnNumber: async () => 1,
    },
    resource: {
      link: async (input: { content?: string }) => {
        linkCalls.push(input);
        return { id: "res-1", resourceType: "fact", status: "active", groupId: null };
      },
    },
  } as unknown as OtterToolClient;

  const ctx: ToolContext = {
    client, otterId: "otter-1", conversationId: "conv-1", currentMessageId: "msg-1",
  };
  const tool = createTools(ctx).find(t => t.name === "create_linked_resource")!;
  return { tool, linkCalls };
}

describe("create_linked_resource 工具层 fact content 长度校验", () => {
  it("content 超过 500 字符时返回错误，且不调用 resource.link", async () => {
    const { tool, linkCalls } = makeLinkedResourceTool();

    const res = await tool.execute("c1", {
      resourceType: "fact",
      title: "超长 fact",
      content: "x".repeat(FACT_CONTENT_MAX_LENGTH + 1),
    });

    const text = res.content[0].text;
    expect(text).toContain("[错误]");
    expect(text).toContain("不能超过 500 字符");
    expect(text).toContain("resourceType='file'");
    expect(linkCalls).toHaveLength(0);
  });

  it("content 恰好 500 字符时正常创建", async () => {
    const { tool, linkCalls } = makeLinkedResourceTool();

    const res = await tool.execute("c1", {
      resourceType: "fact",
      title: "边界 fact",
      content: "x".repeat(FACT_CONTENT_MAX_LENGTH),
    });

    expect(res.content[0].text).toContain("Linked resource created: res-1");
    expect(linkCalls).toHaveLength(1);
  });

  it("纯空白 content 时返回错误，且不调用 resource.link", async () => {
    const { tool, linkCalls } = makeLinkedResourceTool();

    const res = await tool.execute("c1", {
      resourceType: "fact",
      title: "空白 fact",
      content: "   \t\n ",
    });

    const text = res.content[0].text;
    expect(text).toContain("[错误]");
    expect(text).toContain("content 不能为空");
    expect(linkCalls).toHaveLength(0);
  });

  it("file 类型资源不受长度限制影响", async () => {
    const { tool, linkCalls } = makeLinkedResourceTool();

    const res = await tool.execute("c1", {
      resourceType: "file",
      url: "/path/to/file.txt",
      title: "文件资源",
    });

    expect(res.content[0].text).toContain("Linked resource created: res-1");
    expect(linkCalls).toHaveLength(1);
  });
});

describe("create_linked_resource 工具层 F20260829gvid groupId 必填校验（#580）", () => {
  it("worktree 类型缺 groupId 时返回错误，且不调用 resource.link", async () => {
    const { tool, linkCalls } = makeLinkedResourceTool();

    const res = await tool.execute("c1", {
      resourceType: "worktree",
      url: "/wt/feature-x",
      title: "无组 worktree",
    });

    const text = res.content[0].text;
    expect(text).toContain("[错误]");
    expect(text).toContain("必须提供 groupId");
    expect(text).toContain("F20260829");
    expect(linkCalls).toHaveLength(0);
  });

  it("branch 类型纯空白 groupId 视为漏传", async () => {
    const { tool, linkCalls } = makeLinkedResourceTool();

    const res = await tool.execute("c1", {
      resourceType: "branch",
      url: "feature/x",
      groupId: "  ",
    });

    expect(res.content[0].text).toContain("[错误]");
    expect(res.content[0].text).toContain("必须提供 groupId");
    expect(linkCalls).toHaveLength(0);
  });

  it("pr 类型带 groupId 正常创建", async () => {
    const { tool, linkCalls } = makeLinkedResourceTool();

    const res = await tool.execute("c1", {
      resourceType: "pr",
      url: "https://github.com/x/y/pull/1",
      groupId: "F20260829gvid",
    });

    expect(res.content[0].text).toContain("Linked resource created: res-1");
    expect(linkCalls).toHaveLength(1);
  });

  it("url 类型不带 groupId 仍可创建（散点资源维持可选）", async () => {
    const { tool, linkCalls } = makeLinkedResourceTool();

    const res = await tool.execute("c1", {
      resourceType: "url",
      url: "https://example.com",
    });

    expect(res.content[0].text).toContain("Linked resource created: res-1");
    expect(linkCalls).toHaveLength(1);
  });
});
