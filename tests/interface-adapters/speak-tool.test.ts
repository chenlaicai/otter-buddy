import { describe, it, expect } from "vitest";
import { createTools, type ToolContext } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { OtterToolClient } from "@interface-adapters/agent-runtime/otter-tool-client";

function makeSpeakTool(
  participants: Array<{ otterId: string; otterName: string }>,
  options: { currentMessageId?: string; startSpeakingError?: Error } = {},
) {
  const speakingCalls: Array<{ body: string; talkingStonePassedTo: string[] }> = [];
  const client = {
    conversation: {
      participant: {
        getActive: async () => participants.map(p => ({ otterId: p.otterId, otterName: p.otterName })),
      },
      message: {
        startSpeaking: async (_id: string, input: { body: string; talkingStonePassedTo: string[] }) => {
          if (options.startSpeakingError) throw options.startSpeakingError;
          speakingCalls.push(input);
        },
      },
    },
  } as unknown as OtterToolClient;

  const ctx: ToolContext = { client, otterId: "otter-self", conversationId: "conv-1", currentMessageId: options.currentMessageId ?? "msg-1" };
  const speak = createTools(ctx).find(t => t.name === "speak")!;
  return { speak, speakingCalls };
}

const PARTICIPANTS = [
  { otterId: "otter-self", otterName: "小獭" },
  { otterId: "otter-big", otterName: "大獭" },
];

describe("speak 工具发言石目标校验", () => {
  it("合法目标（在场 otterId 与 'user'）正常提交，结果带 terminate 终止 loop", async () => {
    const { speak, speakingCalls } = makeSpeakTool(PARTICIPANTS);

    const r1 = await speak.execute("c1", { body: "给大獭", talkingStonePassedTo: ["otter-big"] });
    expect(r1.content[0].text).toContain("发言已提交成功");
    expect(r1.terminate).toBe(true);
    expect(speakingCalls[0].talkingStonePassedTo).toEqual(["otter-big"]);

    const r2 = await speak.execute("c2", { body: "交还人类", talkingStonePassedTo: ["user"] });
    expect(r2.content[0].text).toContain("发言已提交成功");
    expect(r2.terminate).toBe(true);
    expect(speakingCalls[1].talkingStonePassedTo).toEqual(["user"]);
  });

  it("非法目标返回错误并附可用名单，不提交发言，不终止 loop（可重试）", async () => {
    const { speak, speakingCalls } = makeSpeakTool(PARTICIPANTS);

    const res = await speak.execute("c1", { body: "给不存在的人", talkingStonePassedTo: ["otter-ghost"] });
    const text = res.content[0].text;
    expect(text).toContain("[错误]");
    expect(text).toContain("otter-ghost");
    expect(text).toContain("大獭(otter-big)");
    expect(text).toContain("'user'");
    expect(res.terminate).toBeUndefined();
    expect(speakingCalls).toHaveLength(0);
  });

  it("传给自己仍然被拒绝，不终止 loop", async () => {
    const { speak, speakingCalls } = makeSpeakTool(PARTICIPANTS);
    const res = await speak.execute("c1", { body: "自言自语", talkingStonePassedTo: ["otter-self"] });
    expect(res.content[0].text).toContain("[错误]");
    expect(res.terminate).toBeUndefined();
    expect(speakingCalls).toHaveLength(0);
  });

  it("body 为空或发言石为空时返回错误，不终止 loop", async () => {
    const { speak, speakingCalls } = makeSpeakTool(PARTICIPANTS);

    const r1 = await speak.execute("c1", { body: "  ", talkingStonePassedTo: ["otter-big"] });
    expect(r1.content[0].text).toContain("[错误]");
    expect(r1.terminate).toBeUndefined();

    const r2 = await speak.execute("c2", { body: "内容", talkingStonePassedTo: [] });
    expect(r2.content[0].text).toContain("[错误]");
    expect(r2.terminate).toBeUndefined();
    expect(speakingCalls).toHaveLength(0);
  });

  it("currentMessageId 未设置时返回系统错误，不终止 loop", async () => {
    const { speak, speakingCalls } = makeSpeakTool(PARTICIPANTS, { currentMessageId: "" });
    const res = await speak.execute("c1", { body: "内容", talkingStonePassedTo: ["otter-big"] });
    expect(res.content[0].text).toContain("[错误]");
    expect(res.terminate).toBeUndefined();
    expect(speakingCalls).toHaveLength(0);
  });

  it("startSpeaking 声明失败时返回错误，不终止 loop", async () => {
    const { speak, speakingCalls } = makeSpeakTool(PARTICIPANTS, { startSpeakingError: new Error("db locked") });
    const res = await speak.execute("c1", { body: "内容", talkingStonePassedTo: ["otter-big"] });
    expect(res.content[0].text).toContain("[错误] 发言声明失败");
    expect(res.terminate).toBeUndefined();
    expect(speakingCalls).toHaveLength(0);
  });
});
