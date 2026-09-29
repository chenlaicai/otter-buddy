/**
 * F20260929kws1：保留段简化测试（最近 4 条 speak + 单条截断 + 剥离非 text 块）。
 *
 * 验证节规格（方案文档「验证」节第 2 条）：
 * 1. 切片：含 10 条 assistant text → 只保留最近 4 条；不足 4 条全保留；无 assistant text 不报错
 * 2. 截断：单条 5000 chars → 750+标记+750；≤1500 不动；多 text 块拼接计长（3×600=1800 → 截）
 * 3. 混合块形态（S1 回归）：text 1000 + thinking 3000 + toolCall args 5000 → 序列化不含
 *    thinking/toolCall 内容，总量 ≤6,500 chars（剥块不截 text 的「硬顶」是假的——实证锚）
 * 4. 契约：messagesToSummarize=第 4 条 speak 之前的全部消息；turnPrefixMessages 恒空；isSplitTurn 恒 false
 * 5. 回归：user 消息/注入包/toolResult 不进保留段
 */
import { describe, expect, it } from "vitest";
import {
  serializeKeptWindow,
  sliceSessionEntries,
  setSliceLogger,
  type JsonlSlice,
} from "@frameworks/agent/session-slicer";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// fixture 构造
// ---------------------------------------------------------------------------

let entrySeq = 0;
function makeUserEntry(text: string): SessionEntry {
  return {
    type: "message",
    id: `entry-${entrySeq++}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text }] },
  } as unknown as SessionEntry;
}

/** assistant 消息（可含混合 content 块：text / thinking / toolCall） */
function makeAssistantEntry(blocks: unknown[]): SessionEntry {
  return {
    type: "message",
    id: `entry-${entrySeq++}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "assistant", content: blocks },
  } as unknown as SessionEntry;
}

function textBlock(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

function thinkingBlock(text: string): { type: "thinking"; thinking: string } {
  return { type: "thinking", thinking: text };
}

function toolCallBlock(name: string, args: Record<string, unknown>): { type: "toolCall"; name: string; arguments: Record<string, unknown> } {
  return { type: "toolCall", name, arguments: args };
}

function makeToolResultEntry(): SessionEntry {
  return {
    type: "message",
    id: `entry-${entrySeq++}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "toolResult", content: [{ type: "toolResult", output: "tool result output" }] },
  } as unknown as SessionEntry;
}

/** 中文叙事内容 */
function cn(len: number, seed = "獭海豚协作保留段最近四条speak截断剥离测试中文叙事内容填充"): string {
  const base = seed.repeat(Math.ceil(len / seed.length));
  return base.slice(0, len);
}

/** 从重构造后的 keptEntry 取唯一 text 块文本（断言辅助） */
function keptText(entry: SessionEntry): string {
  const content = (entry as unknown as { message: { content: Array<{ type: string; text: string }> } }).message.content;
  expect(content.length).toBe(1);
  expect(content[0].type).toBe("text");
  return content[0].text;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("F20260929kws1 保留段简化：最近 4 条 speak", () => {
  it("切片：10 条 speak 只保留最近 4 条，user/toolResult 不进保留段", () => {
    const entries: SessionEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(makeUserEntry(`用户消息 ${i}`));
      entries.push(makeAssistantEntry([textBlock(`第 ${i} 条 speak`)]));
      entries.push(makeToolResultEntry());
    }
    const slice = sliceSessionEntries(entries);
    expect(slice).toBeDefined();
    expect(slice!.keptEntries.length).toBe(4);
    const serialized = serializeKeptWindow(slice!);
    // 最近 4 条 speak（#6-#9）在；更早的 speak（#0-#5）不在
    expect(serialized).toContain("第 9 条 speak");
    expect(serialized).toContain("第 6 条 speak");
    expect(serialized).not.toContain("第 5 条 speak");
    // user 消息与 toolResult 不进保留段（截断层只保留 assistant text）
    expect(serialized).not.toContain("[User]");
    expect(serialized).not.toContain("[Tool result]");
    expect(serialized).not.toContain("用户消息 9");
  });

  it("不足 4 条：全保留；无 assistant text（纯工具前世）返回 undefined 不报错", () => {
    const few = [
      makeUserEntry("问"),
      makeAssistantEntry([textBlock("答 1")]),
      makeUserEntry("再问"),
      makeAssistantEntry([textBlock("答 2")]),
    ];
    const slice = sliceSessionEntries(few);
    expect(slice).toBeDefined();
    expect(slice!.keptEntries.length).toBe(2);
    const serialized = serializeKeptWindow(slice!);
    expect(serialized).toContain("答 1");
    expect(serialized).toContain("答 2");

    // 无 assistant text：thinking+toolCall 纯工具轮不是 speak
    const toolOnly = [
      makeUserEntry("干活"),
      makeAssistantEntry([thinkingBlock(cn(200)), toolCallBlock("write", { path: "x" })]),
      makeToolResultEntry(),
    ];
    expect(sliceSessionEntries(toolOnly)).toBeUndefined();

    // 空数组同样安全
    expect(sliceSessionEntries([])).toBeUndefined();
  });

  it("截断：单条 5000 chars → 头 750 + 标记 + 尾 750；≤1500 不动；多块拼接计长", () => {
    const long = `【${"甲".repeat(750)}】中段【${"乙".repeat(3490)}】尾【${"丙".repeat(750)}】`;
    expect(long.length).toBeGreaterThan(4_000);
    const slice = sliceSessionEntries([
      makeUserEntry("汇报"),
      makeAssistantEntry([textBlock(long)]),
    ])!;
    const serialized = serializeKeptWindow(slice);
    expect(serialized).toContain("（截断 ");
    expect(serialized).toContain("原文见前世 session jsonl");
    // 头尾各 750 保留：首尾锚可见
    expect(serialized).toContain("【");
    expect(serialized).toContain("】");
    // 截断后单条 ≤ 750 + 标记（~60） + 750
    const keptEntryText = keptText(slice.keptEntries[0]);
    expect(keptEntryText.length).toBeLessThanOrEqual(750 + 100 + 750);

    // 1500 以下不动：逐字保留
    const short = cn(1_400);
    const sliceShort = sliceSessionEntries([makeUserEntry("q"), makeAssistantEntry([textBlock(short)])])!;
    expect(keptText(sliceShort.keptEntries[0])).toBe(short);

    // 多 text 块拼接计长：3 块 × 600 = 1800 > 1500 → 截（逐块截会放过累积形态）
    const sliceMulti = sliceSessionEntries([
      makeUserEntry("q"),
      makeAssistantEntry([textBlock(cn(600)), textBlock(cn(600)), textBlock(cn(600))]),
    ])!;
    const multiText = keptText(sliceMulti.keptEntries[0]);
    expect(multiText.length).toBeLessThanOrEqual(750 + 100 + 750);
    expect(multiText).toContain("（截断 ");
  });

  it("混合块形态（S1 回归）：剥 thinking/toolCall，总量 ≤6,500 chars", () => {
    const THINKING_MARK = `THINK${"思".repeat(2_995)}MARK`;
    const ARG_MARK = `ARG${"参".repeat(4_996)}MARK`;
    const entries: SessionEntry[] = [];
    for (let i = 0; i < 4; i++) {
      entries.push(makeUserEntry(`指令 ${i}`));
      // 每条消息 text 1000 + thinking 3000 + toolCall args 5000
      entries.push(makeAssistantEntry([
        textBlock(cn(1_000)),
        thinkingBlock(THINKING_MARK),
        toolCallBlock("write", { path: `f${i}.ts`, content: ARG_MARK }),
      ]));
      entries.push(makeToolResultEntry());
    }
    const slice = sliceSessionEntries(entries)!;
    expect(slice.keptEntries.length).toBe(4);
    const serialized = serializeKeptWindow(slice);
    // 不含 thinking 内容与 toolCall 参数 JSON
    expect(serialized).not.toContain("THINK");
    expect(serialized).not.toContain("思");
    expect(serialized).not.toContain("ARG");
    expect(serialized).not.toContain("参数内容");
    expect(serialized).not.toContain("[Assistant thinking]");
    expect(serialized).not.toContain("[Assistant tool calls]");
    // 4 × (text 1000 + 序列化开销) ≤ 6,500（硬顶断言——剥块后结构性不可能超）
    expect(serialized.length).toBeLessThanOrEqual(6_500);
    expect(serialized).toContain("[Assistant]");
  });

  it("契约：messagesToSummarize=第 4 条 speak 之前的全部消息；turnPrefixMessages 恒空；isSplitTurn 恒 false", () => {
    const entries: SessionEntry[] = [];
    for (let i = 0; i < 8; i++) {
      entries.push(makeUserEntry(`用户 ${i}`));
      entries.push(makeAssistantEntry([textBlock(`speak ${i}`)]));
    }
    const slice = sliceSessionEntries(entries)!;
    // 最近 4 条 speak = speak 4..7（index 9,11,13,15）→ 原料 = index 0-8 共 9 条消息（user 0-3 + speak 0-3 + user 4）
    expect(slice.messagesToSummarize.length).toBe(9);
    expect(slice.messagesToSummarize[0]).toMatchObject({ role: "user" });
    // 非空原料 → 叙事合成触发条件成立（agent-invoker 依赖此字段非空）
    expect(slice.messagesToSummarize.length).toBeGreaterThan(0);
    // cutPoint 概念退役：无 turn 前缀、不切半轮
    expect(slice.turnPrefixMessages).toEqual([]);
    expect(slice.isSplitTurn).toBe(false);
    // firstKeptEntryId = 最老保留 speak 的 entry id
    expect(slice.firstKeptEntryId).toBe(entries[9].id); // speak 4（index 9）
    // previousSummary：compaction entry 存在时提取
    const withCompaction = [
      { type: "compaction", id: "c1", summary: "上一代摘要" },
      ...entries,
    ] as unknown as SessionEntry[];
    expect(sliceSessionEntries(withCompaction)!.previousSummary).toBe("上一代摘要");
  });

  it("观测锚：slice 日志带 keptSpeaks/keptChars/scope 字段", () => {
    const logs: Array<Record<string, unknown>> = [];
    setSliceLogger(fields => logs.push(fields));
    try {
      const entries = [
        makeUserEntry("q"),
        makeAssistantEntry([textBlock(cn(800))]),
      ];
      const slice = sliceSessionEntries(entries, { scopeKey: "otter-A" });
      expect(slice).toBeDefined();
      const cutLog = logs.find(l => String(l.msg).includes("cut"));
      expect(cutLog).toBeDefined();
      expect(cutLog!.keptSpeaks).toBe(1);
      expect(cutLog!.keptChars).toBe(800);
      expect(cutLog!.scopeKey).toBe("otter-A");
      expect(cutLog!.total).toBe(2);
    } finally {
      setSliceLogger(undefined);
    }
  });
});

void ({} as unknown as JsonlSlice);
