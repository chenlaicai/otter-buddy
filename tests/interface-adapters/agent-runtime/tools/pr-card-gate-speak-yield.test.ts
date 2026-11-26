/**
 * PR 卡片闸事故 PR 呈递拍板机械闸——speak 辅闸与 yield 主闸的工具层集成。
 *
 * 验收（issue 原文）：
 * - 给一个"要呈递 PR"的回合，speak 里不写卡片 → guard 拦下并要求补卡；补了才放行；
 * - 拆条规避（单条不共现、累计共现）由 yield 主闸兜住；
 * - 检视獭 yield 回大獭（to 不含 user）不触发主闸；
 * - 已合入通报（过去式）不拦。
 */
import { describe, it, expect } from "vitest";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ToolContext, AgentTool } from "@usecases/ports/agent-tools";

interface SpeakEntryParams { body: string; conversationId: string; invokeId: string; otterId: string }

const DECISION_CARD = [
  "```html-card title=\"PR 1960 合入决策\"",
  "<div>残留与后续：无残留</div>",
  "<script>document.getElementById('btn').onclick = () => otterCard.submit({ summary: '1960合入', data: { pr: 1960 } });</script>",
  "```",
].join("\n");

function makeCtx(speakEntryMock?: (params: SpeakEntryParams) => Promise<unknown>): { ctx: ToolContext; speakCalls: SpeakEntryParams[]; yieldCalls: unknown[] } {
  const speakCalls: SpeakEntryParams[] = [];
  const yieldCalls: unknown[] = [];
  const ctx = {
    client: {
      conversation: {
        entry: {
          createSpeakEntry: speakEntryMock ?? (async (params: SpeakEntryParams) => {
            speakCalls.push(params);
            return { id: `e${speakCalls.length}`, entryType: "speak", body: params.body, sequenceNum: speakCalls.length, createdAt: new Date().toISOString() };
          }),
          createYieldEntry: async (params: unknown) => {
            yieldCalls.push(params);
            return {
              yieldEntry: { id: "y1" },
              invokeEndEntry: { id: "ie1" },
              invoke: { metadata: {} },
            };
          },
        },
        participant: {
          getActive: async () => [
            { otterId: "otter-1", otterName: "大獭" },
            { otterId: "otter-2", otterName: "kimi检视獭" },
          ],
        },
      },
      dispatch: { markDispatched: async () => undefined },
      otter: { getById: async () => ({ id: "otter-1", name: "大獭" }) },
    },
    otterId: "otter-1",
    conversationId: "conv-1",
    currentMessageId: "msg-1",
    currentInvokeId: "invoke-1",
    speakBodiesThisTurn: [] as string[],
  } as unknown as ToolContext;
  return { ctx, speakCalls, yieldCalls };
}

function findTool(tools: AgentTool[], name: string): AgentTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`${name} tool not found`);
  return t;
}

describe("#1952 speak 辅闸（落库前拦截）", () => {
  it("呈递待拍板无卡 → 拒绝落库，回执含补卡模板", async () => {
    const { ctx, speakCalls } = makeCtx();
    const speak = findTool(createTools(ctx), "speak");
    const res = await speak.execute("c1", { body: "#1960 检视完成，待你拍板，CI 全绿" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("决策卡");
    expect(res.content[0].text).toContain("otterCard.submit");
    expect(speakCalls).toHaveLength(0);
  });

  it("同措辞带决策卡 → 放行落库，body 进本回合累计", async () => {
    const { ctx, speakCalls } = makeCtx();
    const speak = findTool(createTools(ctx), "speak");
    const body = `#1960 检视完成，待你拍板\n${DECISION_CARD}`;
    const res = await speak.execute("c1", { body });

    expect(res.isError).toBeUndefined();
    expect(speakCalls).toHaveLength(1);
    expect(ctx.speakBodiesThisTurn).toHaveLength(1);
  });

  it("检视报告（评价措辞）无卡 → 放行——窄表不收「可以合入」", async () => {
    const { ctx, speakCalls } = makeCtx();
    const speak = findTool(createTools(ctx), "speak");
    const res = await speak.execute("c1", { body: "对抗检视 #1959 通过，可以合入，无阻塞项，回执见 PR review" });

    expect(res.isError).toBeUndefined();
    expect(speakCalls).toHaveLength(1);
  });
});

describe("#1952 yield 主闸（交棒前拦截）", () => {
  it("拆条规避：speak 单条不触发辅闸，yield to user 时累计命中 → 拒绝交棒", async () => {
    const { ctx, yieldCalls } = makeCtx();
    const tools = createTools(ctx);
    const speak = findTool(tools, "speak");
    const yieldTool = findTool(tools, "yield");

    await speak.execute("c1", { body: "#1960 检视完成，CI 四 job 绿，29/29 测试过" });
    await speak.execute("c2", { body: "证据齐了，可以合入了，等你" });
    const res = await yieldTool.execute("c3", { to: ["user"], reason: "PR #1960 待拍板" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("决策卡");
    expect(yieldCalls).toHaveLength(0);
  });

  it("#2013 决策卡未披露残留 → yield 仍被拦（卡在场也要交代没做完的部分）", async () => {
    const { ctx, yieldCalls } = makeCtx();
    const tools = createTools(ctx);
    const speak = findTool(tools, "speak");
    const yieldTool = findTool(tools, "yield");

    await speak.execute("c1", { body: "#1960 可以合入了" });
    await speak.execute("c2", { body: DECISION_CARD.replace("残留与后续：无残留", "验证：CI 全绿") });
    const res = await yieldTool.execute("c3", { to: ["user"], reason: "PR #1960 待拍板" });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("残留");
    expect(yieldCalls).toHaveLength(0);
  });

  it("补决策卡后 yield → 放行", async () => {
    const { ctx, yieldCalls } = makeCtx();
    const tools = createTools(ctx);
    const speak = findTool(tools, "speak");
    const yieldTool = findTool(tools, "yield");

    await speak.execute("c1", { body: "#1960 可以合入了" });
    await speak.execute("c2", { body: DECISION_CARD });
    const res = await yieldTool.execute("c3", { to: ["user"], reason: "PR #1960 待拍板" });

    expect(res.isError).toBeUndefined();
    expect(yieldCalls).toHaveLength(1);
  });

  it("检视獭 yield 回大獭（to 不含 user）→ 主闸不触发", async () => {
    const { ctx, yieldCalls } = makeCtx();
    const tools = createTools(ctx);
    const speak = findTool(tools, "speak");
    const yieldTool = findTool(tools, "yield");

    await speak.execute("c1", { body: "对抗检视 #1959 通过，可以合入" });
    const res = await yieldTool.execute("c2", { to: ["大獭"] });

    expect(res.isError).toBeUndefined();
    expect(yieldCalls).toHaveLength(1);
  });

  it("已合入通报 yield to user → 过去式剔除放行", async () => {
    const { ctx, yieldCalls } = makeCtx();
    const tools = createTools(ctx);
    const speak = findTool(tools, "speak");
    const yieldTool = findTool(tools, "yield");

    await speak.execute("c1", { body: "PR #1954 已合入 main（4ffcb5ab），收尾完毕" });
    const res = await yieldTool.execute("c2", { to: ["user"], reason: "#1954 已交付，转下一个" });

    expect(res.isError).toBeUndefined();
    expect(yieldCalls).toHaveLength(1);
  });

  it("speakBodiesThisTurn 未注入（旧装配）→ fail-open 放行不抛异常", async () => {
    const { ctx, yieldCalls } = makeCtx();
    delete (ctx as Partial<ToolContext>).speakBodiesThisTurn;
    const tools = createTools(ctx);
    const speak = findTool(tools, "speak");
    const yieldTool = findTool(tools, "yield");

    await speak.execute("c1", { body: "#1960 可以合入了" });
    const res = await yieldTool.execute("c2", { to: ["user"], reason: "待拍板" });

    expect(res.isError).toBeUndefined();
    expect(yieldCalls).toHaveLength(1);
  });
});
