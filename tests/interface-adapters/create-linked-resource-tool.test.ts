import { describe, it, expect } from "vitest";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ToolContext } from "@usecases/ports/agent-tools";
import { FACT_CONTENT_MAX_LENGTH } from "@usecases/conversation/manage-key-info";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";

function makeLinkedResourceTool() {
  const linkCalls: Array<{ content?: string }> = [];
  const client = {
    conversation: {
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

/** 检视处置 D2(a)（PR #1396 delta 第 2 轮）：speak 调用点集成测试——
 *  守护 autoRegisterPlayableCards 挂钩不回退：含 html-card-play 围栏的 speak body
 *  必须登记 fact，且 content 摘要 = extractPlayableCardSummary 输出（script 源码不漏入）。 */
function makeSpeakToolForPlayableCard() {
  const linkCalls: Array<{ title?: string; content?: string; category?: string }> = [];
  const client = {
    conversation: {
      entry: {
        createSpeakEntry: async (input: { body: string }) => ({
          id: "entry-1", entryType: "speak", sequenceNum: 1, createdAt: "2026-10-09T00:00:00Z",
          body: input.body,
        }),
      },
    },
    resource: {
      link: async (input: { title?: string; content?: string; category?: string }) => {
        linkCalls.push(input);
        return { id: "res-1", resourceType: "fact", status: "active", groupId: null };
      },
    },
  } as unknown as OtterToolClient;

  const ctx: ToolContext = {
    client, otterId: "otter-1", conversationId: "conv-1",
    currentMessageId: "msg-1", currentInvokeId: "invoke-1",
  };
  const tool = createTools(ctx).find(t => t.name === "speak")!;
  return { tool, linkCalls };
}

describe("speak 活类卡自动登记（调用点守卫，issue #1401 当场修）", () => {
  it("含 html-card-play 围栏的 speak 登记 fact，摘要先剥 script 源码", async () => {
    const { tool, linkCalls } = makeSpeakToolForPlayableCard();

    const body = '开场。\n```html-card-play title="镜湖"\n<div>镜湖开场文案</div><script>var S = { hp:100 };</script>\n```';
    const res = await tool.execute("c1", { body });

    expect(res.content[0].text).toContain("已记录发言");
    expect(linkCalls).toHaveLength(1);
    expect(linkCalls[0].title).toContain("镜湖");
    expect(linkCalls[0].category).toBe("playable-card");
    expect(linkCalls[0].content).toContain("镜湖开场文案");
    expect(linkCalls[0].content).not.toContain("hp:100");
    expect(linkCalls[0].content).not.toContain("var S");
  });

  it("无 html-card-play 围栏的 speak 不登记", async () => {
    const { tool, linkCalls } = makeSpeakToolForPlayableCard();

    await tool.execute("c1", { body: '普通发言。\n```html-card title="普卡"\n<div>x</div>\n```' });

    expect(linkCalls).toHaveLength(0);
  });
});
