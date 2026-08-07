import { describe, it, expect } from "vitest";
import { createTools, type ToolContext } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { OtterToolClient } from "@interface-adapters/agent-runtime/otter-tool-client";
import { DomainError } from "@entities/errors";

function makeSpeakTool(
  participants: Array<{ otterId: string; otterName: string }>,
  options: { currentMessageId?: string; startSpeakingError?: Error; turnAssistantText?: string } = {},
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

  const ctx: ToolContext = {
    client, otterId: "otter-self", conversationId: "conv-1",
    currentMessageId: options.currentMessageId ?? "msg-1",
    ...(options.turnAssistantText !== undefined && { getTurnAssistantText: () => options.turnAssistantText! }),
  };
  const speak = createTools(ctx).find(t => t.name === "speak")!;
  return { speak, speakingCalls };
}

const PARTICIPANTS = [
  { otterId: "otter-self", otterName: "小獭" },
  { otterId: "otter-big", otterName: "大獭" },
];

describe("speak 工具发言石目标校验", () => {
  it("合法目标（在场名字与 'user'）正常提交，结果带 terminate 终止 loop", async () => {
    const { speak, speakingCalls } = makeSpeakTool(PARTICIPANTS);

    const r1 = await speak.execute("c1", { body: "给大獭", talkingStonePassedTo: ["大獭"] });
    expect(r1.content[0].text).toContain("发言已提交成功");
    expect(r1.terminate).toBe(true);
    /** resolve 后传给 startSpeaking 的是 otterId（系统侧 name->id 映射） */
    expect(speakingCalls[0].talkingStonePassedTo).toEqual(["otter-big"]);

    const r2 = await speak.execute("c2", { body: "交还人类", talkingStonePassedTo: ["user"] });
    expect(r2.content[0].text).toContain("发言已提交成功");
    expect(r2.terminate).toBe(true);
    expect(speakingCalls[1].talkingStonePassedTo).toEqual(["user"]);
  });

  it("非法目标返回错误并附可用名单（纯名字，无 otterId），不提交发言，不终止 loop（可重试）", async () => {
    const { speak, speakingCalls } = makeSpeakTool(PARTICIPANTS);

    const res = await speak.execute("c1", { body: "给不存在的人", talkingStonePassedTo: ["不存在的獭"] });
    const text = res.content[0].text;
    expect(text).toContain("[错误]");
    expect(text).toContain("不存在的獭");
    expect(text).toContain("大獭");
    expect(text).not.toContain("otter-big");
    expect(text).toContain("'user'");
    expect(res.terminate).toBeUndefined();
    expect(speakingCalls).toHaveLength(0);
  });

  it("传给自己仍然被拒绝，不终止 loop", async () => {
    const { speak, speakingCalls } = makeSpeakTool(PARTICIPANTS);
    const res = await speak.execute("c1", { body: "自言自语", talkingStonePassedTo: ["小獭"] });
    expect(res.content[0].text).toContain("[错误]");
    expect(res.content[0].text).toContain("小獭");
    expect(res.terminate).toBeUndefined();
    expect(speakingCalls).toHaveLength(0);
  });

  it("body 为空或发言石为空时返回错误，不终止 loop", async () => {
    const { speak, speakingCalls } = makeSpeakTool(PARTICIPANTS);

    const r1 = await speak.execute("c1", { body: "  ", talkingStonePassedTo: ["大獭"] });
    expect(r1.content[0].text).toContain("[错误]");
    expect(r1.terminate).toBeUndefined();

    const r2 = await speak.execute("c2", { body: "内容", talkingStonePassedTo: [] });
    expect(r2.content[0].text).toContain("[错误]");
    expect(r2.terminate).toBeUndefined();
    expect(speakingCalls).toHaveLength(0);
  });

  it("currentMessageId 未设置时返回系统错误，不终止 loop", async () => {
    const { speak, speakingCalls } = makeSpeakTool(PARTICIPANTS, { currentMessageId: "" });
    const res = await speak.execute("c1", { body: "内容", talkingStonePassedTo: ["大獭"] });
    expect(res.content[0].text).toContain("[错误]");
    expect(res.terminate).toBeUndefined();
    expect(speakingCalls).toHaveLength(0);
  });

  it("startSpeaking 声明失败时返回错误，不终止 loop", async () => {
    const { speak, speakingCalls } = makeSpeakTool(PARTICIPANTS, { startSpeakingError: new Error("db locked") });
    const res = await speak.execute("c1", { body: "内容", talkingStonePassedTo: ["大獭"] });
    expect(res.content[0].text).toContain("[错误] 发言声明失败");
    expect(res.terminate).toBeUndefined();
    expect(speakingCalls).toHaveLength(0);
  });

  // F20260806cbsx: CAS 冲突（已 speaking/completed）→ 幂等终结
  it("startSpeaking CAS 冲突（DomainError kind=conflict）时返回终态信号 + terminate:true", async () => {
    const { speak, speakingCalls } = makeSpeakTool(PARTICIPANTS, {
      startSpeakingError: new DomainError("Cannot start speaking for message with status: speaking", "conflict"),
    });
    const res = await speak.execute("c1", { body: "内容", talkingStonePassedTo: ["大獭"] });
    expect(res.content[0].text).toContain("本回合发言已提交，无需重复调用 speak");
    expect(res.content[0].text).toContain("请停止调用任何工具");
    expect(res.terminate).toBe(true);
    expect(speakingCalls).toHaveLength(0);
  });

  // 非 conflict 的 DomainError（如 validation）仍走原来的错误+重试路径
  it("startSpeaking validation 错误仍返回错误+重试，不终止", async () => {
    const { speak, speakingCalls } = makeSpeakTool(PARTICIPANTS, {
      startSpeakingError: new DomainError("talkingStonePassedTo must be non-empty", "validation"),
    });
    const res = await speak.execute("c1", { body: "内容", talkingStonePassedTo: ["大獭"] });
    expect(res.content[0].text).toContain("[错误] 发言声明失败");
    expect(res.content[0].text).toContain("请重试");
    expect(res.terminate).toBeUndefined();
    expect(speakingCalls).toHaveLength(0);
  });
});

/** F20260804hcob: html-card 写在 speak 之外的检测拦截 */
describe("speak 工具 html-card 位置校验", () => {
  it("assistant 文本含 html-card 围栏而 body 没有：拒绝、不提交、不终止，错误信息指导移入 body", async () => {
    const { speak, speakingCalls } = makeSpeakTool(PARTICIPANTS, {
      turnAssistantText: "方案如下：\n```html-card title=\"方案\"\n<div>...</div>\n```\n请查看。",
    });
    const res = await speak.execute("c1", { body: "详细方案已用 HTML 卡片呈现，请查看。", talkingStonePassedTo: ["user"] });
    const text = res.content[0].text;
    expect(text).toContain("[错误]");
    expect(text).toContain("html-card");
    expect(text).toContain("body");
    expect(res.terminate).toBeUndefined();
    expect(speakingCalls).toHaveLength(0);
  });

  it("assistant 文本和 body 都含 html-card 围栏：正常提交", async () => {
    const { speak, speakingCalls } = makeSpeakTool(PARTICIPANTS, {
      turnAssistantText: "```html-card title=\"草稿\"\n<div>draft</div>\n```",
    });
    const res = await speak.execute("c1", {
      body: "方案：\n```html-card title=\"方案\"\n<div>final</div>\n```",
      talkingStonePassedTo: ["user"],
    });
    expect(res.content[0].text).toContain("发言已提交成功");
    expect(res.terminate).toBe(true);
    expect(speakingCalls).toHaveLength(1);
  });

  it("body 用 ~~~ 围栏（渲染侧合法卡片）：与 ``` 草稿混用时正常提交，不误拒", async () => {
    const { speak, speakingCalls } = makeSpeakTool(PARTICIPANTS, {
      turnAssistantText: "```html-card title=\"草稿\"\n<div>draft</div>\n```",
    });
    const res = await speak.execute("c1", {
      body: "方案：\n~~~html-card title=\"方案\"\n<div>final</div>\n~~~",
      talkingStonePassedTo: ["user"],
    });
    expect(res.content[0].text).toContain("发言已提交成功");
    expect(res.terminate).toBe(true);
    expect(speakingCalls).toHaveLength(1);
  });

  it("assistant 文本用 ~~~ 围栏写卡片而 body 没有：同样拒绝", async () => {
    const { speak, speakingCalls } = makeSpeakTool(PARTICIPANTS, {
      turnAssistantText: "方案如下：\n~~~html-card title=\"方案\"\n<div>x</div>\n~~~",
    });
    const res = await speak.execute("c1", { body: "方案已用卡片呈现。", talkingStonePassedTo: ["user"] });
    expect(res.content[0].text).toContain("[错误]");
    expect(res.terminate).toBeUndefined();
    expect(speakingCalls).toHaveLength(0);
  });

  it("assistant 文本只有 html-card-reply 回执围栏：不误伤，正常提交", async () => {
    const { speak, speakingCalls } = makeSpeakTool(PARTICIPANTS, {
      turnAssistantText: "我解析一下这张 ```html-card-reply 回执的内容。",
    });
    const res = await speak.execute("c1", { body: "回执已确认。", talkingStonePassedTo: ["user"] });
    expect(res.content[0].text).toContain("发言已提交成功");
    expect(res.terminate).toBe(true);
    expect(speakingCalls).toHaveLength(1);
  });

  it("未注入 getTurnAssistantText（其他调用方）：行为不变，正常提交", async () => {
    const { speak, speakingCalls } = makeSpeakTool(PARTICIPANTS);
    const res = await speak.execute("c1", { body: "普通发言", talkingStonePassedTo: ["user"] });
    expect(res.content[0].text).toContain("发言已提交成功");
    expect(res.terminate).toBe(true);
    expect(speakingCalls).toHaveLength(1);
  });
});
