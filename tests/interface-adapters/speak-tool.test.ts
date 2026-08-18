import { describe, it, expect } from "vitest";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ToolContext } from "@usecases/ports/agent-tools";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";
import { DomainError } from "@entities/errors";

function makeTools(
  participants: Array<{ otterId: string; otterName: string }>,
  options: { currentMessageId?: string; startSpeakingError?: Error; turnAssistantText?: string; pendingDispatches?: Map<string, string> } = {},
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
    ...(options.pendingDispatches !== undefined && {
      pendingDispatches: options.pendingDispatches,
      dispatchWarningShown: false,
    }),
    speakBodyBuffer: [],
    pendingYieldTargets: [],
  };
  const tools = createTools(ctx);
  const speak = tools.find(t => t.name === "speak")!;
  const yieldTool = tools.find(t => t.name === "yield")!;
  return { speak, yield: yieldTool, speakingCalls, ctx };
}

const PARTICIPANTS = [
  { otterId: "otter-self", otterName: "小獭" },
  { otterId: "otter-big", otterName: "大獭" },
];

describe("speak 工具 — 纯内容输出", () => {
  it("累积 body 到 buffer，terminate=false，不调 startSpeaking", async () => {
    const { speak, speakingCalls, ctx } = makeTools(PARTICIPANTS);
    const res = await speak.execute("c1", { body: "我正在分析需求" });
    expect(res.content[0].text).toContain("已记录发言");
    expect(res.terminate).toBe(false);
    expect(speakingCalls).toHaveLength(0);
    expect(ctx.speakBodyBuffer).toEqual(["我正在分析需求"]);
  });

  it("多次调用累积 body", async () => {
    const { speak, speakingCalls, ctx } = makeTools(PARTICIPANTS);
    await speak.execute("c1", { body: "第一段" });
    await speak.execute("c2", { body: "第二段" });
    expect(ctx.speakBodyBuffer).toEqual(["第一段", "第二段"]);
    expect(speakingCalls).toHaveLength(0);
  });

  it("body 为空时返回错误", async () => {
    const { speak, speakingCalls } = makeTools(PARTICIPANTS);
    const res = await speak.execute("c1", { body: "  " });
    expect(res.content[0].text).toContain("[错误]");
    expect(res.terminate).toBeUndefined();
    expect(speakingCalls).toHaveLength(0);
  });

  it("currentMessageId 未设置时返回系统错误", async () => {
    const { speak } = makeTools(PARTICIPANTS, { currentMessageId: "" });
    const res = await speak.execute("c1", { body: "内容" });
    expect(res.content[0].text).toContain("[错误]");
    expect(res.terminate).toBeUndefined();
  });

  it("返回 __speakIntermediate 信号用于 SSE 推送", async () => {
    const { speak } = makeTools(PARTICIPANTS);
    const res = await speak.execute("c1", { body: "进展" });
    expect(res.details?.__speakIntermediate).toBe(true);
    expect(res.details?.body).toBe("进展");
  });
});

describe("yield 工具 — 行动权移交", () => {
  it("合法目标正常交棒，terminate=true，body 来自 speakBodyBuffer", async () => {
    const { speak, yield: y, speakingCalls, ctx } = makeTools(PARTICIPANTS);
    ctx.speakBodyBuffer = ["分析结果", "结论"];
    const res = await y.execute("c1", { to: ["大獭"] });
    expect(res.content[0].text).toContain("交棒成功");
    expect(res.terminate).toBe(true);
    expect(speakingCalls).toHaveLength(1);
    expect(speakingCalls[0].body).toBe("分析结果\n\n结论");
    expect(speakingCalls[0].talkingStonePassedTo).toEqual(["otter-big"]);
    expect(ctx.speakBodyBuffer).toEqual([]);
  });

  it("传给 user 正常交棒", async () => {
    const { yield: y, speakingCalls } = makeTools(PARTICIPANTS);
    const res = await y.execute("c1", { to: ["user"] });
    expect(res.terminate).toBe(true);
    expect(speakingCalls[0].talkingStonePassedTo).toEqual(["user"]);
  });

  it("非法目标返回错误", async () => {
    const { yield: y, speakingCalls } = makeTools(PARTICIPANTS);
    const res = await y.execute("c1", { to: ["不存在的獭"] });
    expect(res.content[0].text).toContain("[错误]");
    expect(res.content[0].text).toContain("不存在的獭");
    expect(res.terminate).toBeUndefined();
    expect(speakingCalls).toHaveLength(0);
  });

  it("传给自己被拒绝", async () => {
    const { yield: y, speakingCalls } = makeTools(PARTICIPANTS);
    const res = await y.execute("c1", { to: ["小獭"] });
    expect(res.content[0].text).toContain("[错误]");
    expect(res.content[0].text).toContain("小獭");
    expect(res.terminate).toBeUndefined();
    expect(speakingCalls).toHaveLength(0);
  });

  it("空目标返回错误", async () => {
    const { yield: y, speakingCalls } = makeTools(PARTICIPANTS);
    const res = await y.execute("c1", { to: [] });
    expect(res.content[0].text).toContain("[错误]");
    expect(res.content[0].text).toContain("交棒目标不能为空");
    expect(res.terminate).toBeUndefined();
    expect(speakingCalls).toHaveLength(0);
  });

  it("currentMessageId 未设置时返回系统错误", async () => {
    const { yield: y } = makeTools(PARTICIPANTS, { currentMessageId: "" });
    const res = await y.execute("c1", { to: ["大獭"] });
    expect(res.content[0].text).toContain("[错误]");
    expect(res.terminate).toBeUndefined();
  });

  it("startSpeaking 失败时返回错误", async () => {
    const { yield: y, speakingCalls } = makeTools(PARTICIPANTS, { startSpeakingError: new Error("db locked") });
    const res = await y.execute("c1", { to: ["大獭"] });
    expect(res.content[0].text).toContain("[错误] 交棒失败");
    expect(res.terminate).toBeUndefined();
    expect(speakingCalls).toHaveLength(0);
  });

  it("CAS 冲突时返回终态信号 + terminate:true", async () => {
    const { yield: y, speakingCalls } = makeTools(PARTICIPANTS, {
      startSpeakingError: new DomainError("Cannot start speaking for message with status: speaking", "conflict"),
    });
    const res = await y.execute("c1", { to: ["大獭"] });
    expect(res.content[0].text).toContain("本回合发言已提交");
    expect(res.terminate).toBe(true);
    expect(speakingCalls).toHaveLength(0);
  });

  it("累积 buffer 为空时 body 为空字符串", async () => {
    const { yield: y, speakingCalls, ctx } = makeTools(PARTICIPANTS);
    expect(ctx.speakBodyBuffer).toEqual([]);
    await y.execute("c1", { to: ["大獭"] });
    expect(speakingCalls[0].body).toBe("");
  });
});

describe("speak + yield 联合流程", () => {
  it("多次 speak + yield：累积 body 正确拼接", async () => {
    const { speak, yield: y, speakingCalls, ctx } = makeTools(PARTICIPANTS);
    await speak.execute("c1", { body: "需求分析" });
    await speak.execute("c2", { body: "方案设计" });
    expect(ctx.speakBodyBuffer).toEqual(["需求分析", "方案设计"]);
    const res = await y.execute("c3", { to: ["大獭"] });
    expect(res.terminate).toBe(true);
    expect(speakingCalls[0].body).toBe("需求分析\n\n方案设计");
    expect(ctx.speakBodyBuffer).toEqual([]);
  });
});

describe("yield 工具 html-card 位置校验", () => {
  it("assistant 文本含 html-card 围栏而 buffer 没有：拒绝（speak 阶段拦截）", async () => {
    const { speak } = makeTools(PARTICIPANTS, {
      turnAssistantText: "方案如下：\n```html-card title=\"方案\"\n<div>...</div>\n```\n请查看。",
    });
    const res = await speak.execute("c1", { body: "详细方案已用 HTML 卡片呈现，请查看。" });
    expect(res.content[0].text).toContain("[错误]");
    expect(res.content[0].text).toContain("html-card");
  });
});

describe("yield 工具待派工票据软守卫（C9）", () => {
  const WITH_SMALL = [...PARTICIPANTS, { otterId: "otter-small", otterName: "报告獭" }];
  const freshTickets = () => new Map<string, string>([["otter-small", "报告獭"]]);

  it("有未派工票据时 yield 传 user：返回提醒、不提交", async () => {
    const { yield: y, speakingCalls, ctx } = makeTools(WITH_SMALL, { pendingDispatches: freshTickets() });
    const res = await y.execute("c1", { to: ["user"] });
    const text = res.content[0].text;
    expect(text).toContain("[系统状态]");
    expect(text).toContain("报告獭");
    expect(res.terminate).toBeUndefined();
    expect(speakingCalls).toHaveLength(0);
    expect(ctx.dispatchWarningShown).toBe(true);
  });

  it("提醒后再次 yield 原路由：放行提交", async () => {
    const { yield: y, speakingCalls, ctx } = makeTools(WITH_SMALL, { pendingDispatches: freshTickets() });
    await y.execute("c1", { to: ["user"] });
    const res = await y.execute("c2", { to: ["user"] });
    expect(res.content[0].text).toContain("交棒成功");
    expect(res.terminate).toBe(true);
    expect(speakingCalls).toHaveLength(1);
  });

  it("yield 覆盖票据则直接提交，无需二次提醒", async () => {
    const { yield: y, speakingCalls, ctx } = makeTools(WITH_SMALL, { pendingDispatches: freshTickets() });
    const res = await y.execute("c1", { to: ["报告獭"] });
    expect(res.content[0].text).toContain("交棒成功");
    expect(res.terminate).toBe(true);
    expect(ctx.pendingDispatches!.size).toBe(0);
  });

  it("startSpeaking 失败时票据保留", async () => {
    const tickets = freshTickets();
    const { yield: y, speakingCalls, ctx } = makeTools(WITH_SMALL, {
      pendingDispatches: tickets,
      startSpeakingError: new Error("db locked"),
    });
    const res = await y.execute("c1", { to: ["报告獭"] });
    expect(res.content[0].text).toContain("[错误] 交棒失败");
    expect(speakingCalls).toHaveLength(0);
    expect(ctx.pendingDispatches!.has("otter-small")).toBe(true);
  });

  it("未注入 pendingDispatches：no-op 回归", async () => {
    const { yield: y, speakingCalls } = makeTools(WITH_SMALL);
    const res = await y.execute("c1", { to: ["user"] });
    expect(res.content[0].text).toContain("交棒成功");
    expect(res.terminate).toBe(true);
    expect(speakingCalls).toHaveLength(1);
  });
});
