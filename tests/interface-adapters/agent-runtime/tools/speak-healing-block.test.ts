/**
 * issue #1842（F20261111hrepl）：speak 工具层的 healing 非法块失败可见性。
 *
 * 验收：非法 healing 协议块 → errorResponse 返回模型（isError）+ entry 未创建 + 未落账（原子阻断）；
 * 合法 JSON 单对象 → entry 创建 + repo.create 落账 + body 剥离。
 * 证明「一次 speak 要么完整落账+发出，要么报错不落账」，无部分成功。
 */
import { describe, it, expect, vi } from "vitest";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ToolContext, AgentTool } from "@usecases/ports/agent-tools";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";

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

describe("issue #1842 speak 层失败可见（原子性）", () => {
  it("非法 healing 块：errorResponse 返回模型且 entry 未创建、未落账", async () => {
    const { fn, calls } = makeSpeakEntryMock();
    const { repo, creates } = makeRepo();
    const speak = findSpeak(createTools(makeCtx(fn), repo));
    const res = await speak.execute("call-1", { body: '工作完成\n<healing>\n{"description":"缺 type"}\n</healing>' });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("非法 healing 协议块");
    expect(calls).toHaveLength(0);
    expect(creates).toHaveLength(0);
  });

  it("合法 JSON 单对象：entry 创建 + repo.create 落账 + body 剥离", async () => {
    const { fn, calls } = makeSpeakEntryMock();
    const { repo, creates } = makeRepo();
    const speak = findSpeak(createTools(makeCtx(fn), repo));
    await speak.execute("call-1", { body: '工作完成\n<healing>\n{"type":"runtime_status_mismatch","description":"休息中但实际运行"}\n</healing>' });

    expect(calls).toHaveLength(1);
    expect(calls[0].body).toContain("工作完成");
    expect(calls[0].body).not.toContain("<healing>");
    expect(creates).toHaveLength(1);
    expect((creates[0] as { errorType: string }).errorType).toBe("runtime_status_mismatch");
  });

  it("description 值中的 type 文本不绕过必填校验：entry 与落账均为零", async () => {
    const { fn, calls } = makeSpeakEntryMock();
    const { repo, creates } = makeRepo();
    const speak = findSpeak(createTools(makeCtx(fn), repo));
    const res = await speak.execute("call-1", { body: `工作完成\n<healing>[issues]
- severity: high
  description: 工具输出包含 type: runtime_status_mismatch 字样
[/issues]</healing>` });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("type");
    expect(calls).toHaveLength(0);
    expect(creates).toHaveLength(0);
  });
});
