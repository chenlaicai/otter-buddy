/**
 * F20261113hlprm：healing 从 body 文本标签改为 speak 独立参数。
 *
 * 验收：
 * - 非法 healing 参数 → errorResponse 返回模型（isError）+ entry 未创建 + 未落账（原子阻断）；
 * - 合法 healing 参数 → entry 创建 + repo.create 落账 + body 原样（无标签可漏）。
 * 证明「一次 speak 要么完整落账+发出，要么报错不落账」，无部分成功。
 */
import { describe, it, expect, vi } from "vitest";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ToolContext, AgentTool } from "@usecases/ports/agent-tools";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { SignalEventRepository } from "@usecases/signal/signal-event-repository";

interface SpeakEntryParams { body: string; conversationId: string; invokeId: string; otterId: string }

function makeCtx(createSpeakEntry: (params: SpeakEntryParams) => Promise<unknown>): ToolContext {
  return {
    client: {
      conversation: { entry: { createSpeakEntry } },
    },
    otterId: "otter-1",
    conversationId: "conv-1",
    currentMessageId: "msg-1",
    currentInvokeId: "invoke-1",
  } as unknown as ToolContext;
}

function makeRepo(): { repo: HealingEventRepository; creates: Array<Record<string, unknown>> } {
  const creates: Array<Record<string, unknown>> = [];
  const repo = {
    create: vi.fn(async (e: Record<string, unknown>) => { creates.push(e); }),
  } as unknown as HealingEventRepository;
  return { repo, creates };
}

function findSpeak(tools: AgentTool[]): AgentTool {
  const speak = tools.find(t => t.name === "speak");
  if (!speak) throw new Error("speak tool not found");
  return speak;
}

function makeSpeakEntryMock(): { fn: (params: SpeakEntryParams) => Promise<unknown>; calls: SpeakEntryParams[] } {
  const calls: SpeakEntryParams[] = [];
  const fn = async (params: SpeakEntryParams) => {
    calls.push(params);
    return { id: "e1", entryType: "speak", body: params.body, sequenceNum: 1, createdAt: new Date().toISOString() };
  };
  return { fn, calls };
}

describe("F20261113hlprm speak healing 参数（原子性）", () => {
  it("非法 healing 参数（缺 type）：errorResponse 返回模型且 entry 未创建、未落账", async () => {
    const { fn, calls } = makeSpeakEntryMock();
    const { repo, creates } = makeRepo();
    const speak = findSpeak(createTools(makeCtx(fn), repo));
    const res = await speak.execute("call-1", { body: "工作完成", healing: [{ description: "缺 type" }] });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("type");
    expect(calls).toHaveLength(0);
    expect(creates).toHaveLength(0);
  });

  it("type 不在白名单：error 且 entry 未创建、未落账", async () => {
    const { fn, calls } = makeSpeakEntryMock();
    const { repo, creates } = makeRepo();
    const speak = findSpeak(createTools(makeCtx(fn), repo));
    const res = await speak.execute("call-1", { body: "工作完成", healing: [{ type: "不存在的类型", description: "d" }] });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("白名单");
    expect(calls).toHaveLength(0);
    expect(creates).toHaveLength(0);
  });

  it("severity 非法：error 且未落账", async () => {
    const { fn, calls } = makeSpeakEntryMock();
    const { repo, creates } = makeRepo();
    const speak = findSpeak(createTools(makeCtx(fn), repo));
    const res = await speak.execute("call-1", { body: "工作完成", healing: [{ type: "tool_failure", severity: "critical", description: "d" }] });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("severity");
    expect(calls).toHaveLength(0);
    expect(creates).toHaveLength(0);
  });

  it("合法 healing 参数：entry 创建 + repo.create 落账 + body 原样", async () => {
    const { fn, calls } = makeSpeakEntryMock();
    const { repo, creates } = makeRepo();
    const speak = findSpeak(createTools(makeCtx(fn), repo));
    await speak.execute("call-1", { body: "工作完成", healing: [{ type: "runtime_status_mismatch", description: "休息中但实际运行" }] });

    expect(calls).toHaveLength(1);
    expect(calls[0].body).toBe("工作完成");
    expect(creates).toHaveLength(1);
    expect((creates[0] as { errorType: string }).errorType).toBe("runtime_status_mismatch");
    expect((creates[0] as { severity: string }).severity).toBe("low");
  });

  it("severity 缺省 low，suggestion 可选透传", async () => {
    const { fn, calls } = makeSpeakEntryMock();
    const { repo, creates } = makeRepo();
    const speak = findSpeak(createTools(makeCtx(fn), repo));
    await speak.execute("call-1", { body: "x", healing: [{ type: "tool_use_feedback", description: "[tool:wait] 难用", suggestion: "改文档" }] });

    expect(calls).toHaveLength(1);
    expect(creates).toHaveLength(1);
    expect((creates[0] as { severity: string }).severity).toBe("low");
    expect((creates[0] as { suggestion: string }).suggestion).toBe("改文档");
  });

  it("不传 healing：正常发言且不落账", async () => {
    const { fn, calls } = makeSpeakEntryMock();
    const { repo, creates } = makeRepo();
    const speak = findSpeak(createTools(makeCtx(fn), repo));
    await speak.execute("call-1", { body: "工作完成" });

    expect(calls).toHaveLength(1);
    expect(creates).toHaveLength(0);
  });
});

describe("F20261113sgnpr speak signal 参数（跨参数原子性）", () => {
  function makeSignalRepo(): { repo: SignalEventRepository; creates: Array<Record<string, unknown>> } {
    const creates: Array<Record<string, unknown>> = [];
    const repo = {
      create: vi.fn(async (e: Record<string, unknown>) => { creates.push(e); }),
    } as unknown as SignalEventRepository;
    return { repo, creates };
  }

  it("合法 healing + 非法 signal：healing 也不落账、entry 未创建（全有或全无）", async () => {
    const { fn, calls } = makeSpeakEntryMock();
    const { repo: healingRepo, creates: healingCreates } = makeRepo();
    const { repo: signalRepo, creates: signalCreates } = makeSignalRepo();
    const ctx = { ...makeCtx(fn), signalRepo };
    const speak = findSpeak(createTools(ctx, healingRepo));
    const res = await speak.execute("call-1", {
      body: "工作完成",
      healing: [{ type: "tool_failure", description: "d" }],
      signal: [{ type: "halt", severity: "high", payload: "伪造" }],
    });

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(healingCreates).toHaveLength(0); // 关键：healing 未部分落账
    expect(signalCreates).toHaveLength(0);
  });

  it("合法 healing + 合法 signal：两者都落账、entry 创建一次", async () => {
    const { fn, calls } = makeSpeakEntryMock();
    const { repo: healingRepo, creates: healingCreates } = makeRepo();
    const { repo: signalRepo, creates: signalCreates } = makeSignalRepo();
    const ctx = { ...makeCtx(fn), signalRepo };
    const speak = findSpeak(createTools(ctx, healingRepo));
    const res = await speak.execute("call-1", {
      body: "汇报",
      healing: [{ type: "tool_failure", description: "d" }],
      signal: [{ type: "blocked", severity: "high", payload: "卡住" }],
    });

    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(healingCreates).toHaveLength(1);
    expect(signalCreates).toHaveLength(1);
    expect((signalCreates[0] as { type: string }).type).toBe("blocked");
  });
});
