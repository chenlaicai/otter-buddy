/**
 * F20260901sgp0 P0: yield 工具 level 参数测试。
 *
 * 测试：
 * - yield level 参数透传到 startSpeaking 的 signalLevel/signalMeta
 * - HALT 权限约束：小獭投 HALT 被拒绝，大獭/用户放行
 * - level 默认值为 NORMAL
 */
import { describe, it, expect } from "vitest";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ToolContext } from "@usecases/ports/agent-tools";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";

function makeToolsForYield(
  options: {
    otterType?: "big" | "small";
    otterId?: string;
  } = {},
) {
  const speakingCalls: Array<{ talkingStonePassedTo: string[]; signalLevel?: string; signalMeta?: string }> = [];
  const otterType = options.otterType ?? "big";
  const otterId = options.otterId ?? "otter-self";

  const client = {
    otter: {
      getById: async (id: string) => ({
        id,
        name: otterType === "big" ? "大獭" : "小獭",
        type: otterType,
        status: "active",
      }),
    },
    conversation: {
      participant: {
        getActive: async () => [
          { otterId: "otter-self", otterName: "小獭" },
          { otterId: "otter-big", otterName: "大獭" },
          { otterId: "user", otterName: "搭档" },
        ],
      },
      message: {
        getById: async () => ({
          id: "msg-1", status: "streaming", turnId: "turn-1",
          segments: [{ body: "已有内容" }],
        }),
        startSpeaking: async (_id: string, input: { talkingStonePassedTo: string[]; signalLevel?: string; signalMeta?: string }) => {
          speakingCalls.push(input);
        },
      },
    },
    dispatch: {
      createRecord: async () => ({ id: "dispatch-1" }),
      updateRecord: async () => {},
      queryRecords: async () => [],
    },
  } as unknown as OtterToolClient;

  const ctx: ToolContext = {
    client,
    otterId,
    conversationId: "conv-1",
    currentMessageId: "msg-1",
  };

  const tools = createTools(ctx);
  return {
    yield: tools.find(t => t.name === "yield")!,
    speakingCalls,
  };
}

describe("yield level 参数（F20260901sgp0 P0）", () => {
  describe("level 透传", () => {
    it("默认 level=NORMAL（不传 level 参数）", async () => {
      const { yield: yieldTool, speakingCalls } = makeToolsForYield();
      const res = await yieldTool.execute("c1", { to: ["大獭"] });
      expect(res.content[0].text).toContain("交棒成功");
      expect(speakingCalls).toHaveLength(1);
      expect(speakingCalls[0].signalLevel).toBe("NORMAL");
      expect(speakingCalls[0].signalMeta).toBeUndefined(); // NORMAL 不写 meta
    });

    it("显式 level=NORMAL", async () => {
      const { yield: yieldTool, speakingCalls } = makeToolsForYield();
      await yieldTool.execute("c1", { to: ["大獭"], level: "NORMAL" });
      expect(speakingCalls[0].signalLevel).toBe("NORMAL");
      expect(speakingCalls[0].signalMeta).toBeUndefined();
    });

    it("level=URGENT 透传 signalLevel + signalMeta", async () => {
      const { yield: yieldTool, speakingCalls } = makeToolsForYield();
      await yieldTool.execute("c1", { to: ["大獭"], level: "URGENT", reason: "方向反了" });
      expect(speakingCalls[0].signalLevel).toBe("URGENT");
      expect(speakingCalls[0].signalMeta).toBeDefined();
      const meta = JSON.parse(speakingCalls[0].signalMeta!);
      expect(meta.level).toBe("URGENT");
      expect(meta.reason).toBe("方向反了");
    });

    it("level=HALT 大獭可投", async () => {
      const { yield: yieldTool, speakingCalls } = makeToolsForYield({ otterType: "big", otterId: "otter-big" });
      const res = await yieldTool.execute("c1", { to: ["小獭"], level: "HALT", reason: "停下" });
      expect(res.content[0].text).toContain("交棒成功");
      expect(speakingCalls[0].signalLevel).toBe("HALT");
      const meta = JSON.parse(speakingCalls[0].signalMeta!);
      expect(meta.level).toBe("HALT");
      expect(meta.reason).toBe("停下");
    });
  });

  describe("HALT 权限约束", () => {
    it("小獭投 HALT 被拒绝", async () => {
      const { yield: yieldTool, speakingCalls } = makeToolsForYield({ otterType: "small" });
      const res = await yieldTool.execute("c1", { to: ["大獭"], level: "HALT", reason: "停下" });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("小獭不允许投递 HALT");
      expect(speakingCalls).toHaveLength(0); // 未调用 startSpeaking
    });

    it("小獭投 NORMAL 正常通过", async () => {
      const { yield: yieldTool, speakingCalls } = makeToolsForYield({ otterType: "small" });
      const res = await yieldTool.execute("c1", { to: ["大獭"], level: "NORMAL" });
      expect(res.content[0].text).toContain("交棒成功");
      expect(speakingCalls).toHaveLength(1);
    });

    it("小獭投 URGENT 正常通过", async () => {
      const { yield: yieldTool, speakingCalls } = makeToolsForYield({ otterType: "small" });
      const res = await yieldTool.execute("c1", { to: ["大獭"], level: "URGENT", reason: "急事" });
      expect(res.content[0].text).toContain("交棒成功");
      expect(speakingCalls[0].signalLevel).toBe("URGENT");
    });

    it("level 参数大小写不敏感", async () => {
      const { yield: yieldTool, speakingCalls } = makeToolsForYield({ otterType: "big", otterId: "otter-big" });
      await yieldTool.execute("c1", { to: ["小獭"], level: "halt", reason: "停下" });
      expect(speakingCalls[0].signalLevel).toBe("HALT");
    });
  });
});
