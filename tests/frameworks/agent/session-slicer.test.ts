/**
 * F20260928keep：保留段密度校准测试（预算换算/等效性/截断/fail-open/低密度快照）。
 *
 * 验证节规格（方案文档 v2.1）：
 * 1. 体积预算 chars 紧边界：fixture 不含「## 对话历史」节（隔离防掩蔽），
 *    断言保留段 Σchars ≤ 25,000 + maxFixtureMessageChars（停刀粒度=完整消息）
 * 2. 换算等效性：SDK findCutPoint(budget=6,250) vs 测试内参照累加器（divisor=1.25
 *    逐条累计 chars/1.25 至 20K 停刀），kept 集合相差 ≤1 条边界消息；divisor=4 回退回归锚
 * 3. 截断规则：「## 对话历史」节内单条 >1,500 chars 头 750+尾 750；正常块原样
 * 4. fail-open：无节头标记 → 原样序列化零改动
 * 5. 低密度行为快照：code/JSON 重 fixture 记录切点位置（快照变化须伴随定标重审）
 */
import { describe, expect, it } from "vitest";
import { findCutPoint } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_KEEP_RECENT_TOKENS,
  OTTER_CHARS_PER_TOKEN,
  serializeKeptWindow,
  sliceSessionEntries,
  setSliceLogger,
  __testApplyReplayTruncation,
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

function makeAssistantEntry(text: string): SessionEntry {
  return {
    type: "message",
    id: `entry-${entrySeq++}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as unknown as SessionEntry;
}

/** 中文叙事内容（≈1.9-2.5 chars/token 形态） */
function cn(len: number, seed = "獭海豚协作记忆密度校准保留段预算换算线性等效测试中文叙事内容填充"): string {
  const base = seed.repeat(Math.ceil(len / seed.length));
  return base.slice(0, len);
}

/** code/JSON 高密度内容（≈0.4-0.8 chars/token 形态） */
function codeish(len: number): string {
  const line = '{"type":"toolResult","output":"0123456789abcdef"}\n';
  return line.repeat(Math.ceil(len / line.length)).slice(0, len);
}

/** 不含「## 对话历史」节的中文大保留段 fixture（体积测试隔离用） */
function makeLargeChineseSession(nMessages: number, msgChars: number): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (let i = 0; i < nMessages; i++) {
    entries.push(makeUserEntry(cn(msgChars) + ` #${i}`));
    entries.push(makeAssistantEntry(cn(msgChars) + ` #${i}`));
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 测试内参照累加器（只模拟估算与停刀，不复制切点合法性逻辑——方案 v2.1 测试2规格）
// ---------------------------------------------------------------------------

/** 与 SDK findValidCutPoints 同语义的合法切点收集（user/assistant 消息边界） */
function referenceKeptIndexes(entries: SessionEntry[], divisor: number, budgetTokens: number): Set<number> {
  // 从尾向前累计 chars/divisor 至预算停刀（每条完整消息粒度）
  let acc = 0;
  let start = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== "message") continue;
    const role = (e.message as { role?: string }).role;
    if (role !== "user" && role !== "assistant") continue;
    const text = entryCharsForRef(e);
    if (acc + text / divisor > budgetTokens) break;
    acc += text / divisor;
    start = i;
  }
  return new Set(range(start, entries.length));
}

function entryCharsForRef(e: SessionEntry): number {
  const c = ((e as unknown as { message?: { content?: unknown } }).message ?? {}).content;
  if (typeof c === "string") return c.length;
  if (!Array.isArray(c)) return 0;
  let chars = 0;
  for (const b of c as Array<{ text?: string; thinking?: string }>) {
    if (typeof b?.text === "string") chars += b.text.length;
    else if (typeof b?.thinking === "string") chars += b.thinking.length;
  }
  return chars;
}

function range(a: number, b: number): number[] {
  return Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("F20260928keep 保留段密度校准", () => {
  it("体积预算（chars 紧边界）：切点后保留段 Σchars ≤ 25,000 + maxFixtureMessageChars", () => {
    const msgChars = 520;
    const entries = makeLargeChineseSession(60, msgChars); // 120 条 × 520 chars ≈ 62.4K chars
    const slice = sliceSessionEntries(entries, DEFAULT_KEEP_RECENT_TOKENS);
    expect(slice).toBeDefined();

    const keptChars = slice!.keptEntries.reduce((sum, e) => sum + entryCharsForRef(e), 0);
    // 停刀粒度=完整消息：上界 = 预算 chars + 最老保留消息 chars（方案 D2 修正后规格）
    expect(keptChars).toBeLessThanOrEqual(DEFAULT_KEEP_RECENT_TOKENS * OTTER_CHARS_PER_TOKEN + msgChars + 8); // +8 容纳消息尾序号
    // 且确实发生了裁剪（fixture 总量超预算）
    expect(keptChars).toBeLessThan(62_400);
    expect(slice!.keptEntries.length).toBeGreaterThan(0);
  });

  it("换算等效性：SDK budget=6,250 与参照累加器（divisor=1.25/20K）kept 集合相差 ≤1 条边界消息", () => {
    // 混合尺寸 fixture（等尺寸 fixture 会掩盖 ceil 舍入边界抖动）
    const entries: SessionEntry[] = [];
    const sizes = [300, 800, 120, 2000, 450, 90, 1500, 620, 240, 1100];
    for (let i = 0; i < 60; i++) {
      const s = sizes[i % sizes.length];
      entries.push(makeUserEntry(cn(s) + ` #${i}`));
      entries.push(makeAssistantEntry(cn((s * 2) % 2400 + 100) + ` #${i}`));
    }
    const budget = Math.round((DEFAULT_KEEP_RECENT_TOKENS * OTTER_CHARS_PER_TOKEN) / 4); // 6,250
    const sdkCut = findCutPoint(entries as never, 0, entries.length, budget);
    const sdkKept = new Set(range(sdkCut.firstKeptEntryIndex, entries.length));
    const refKept = referenceKeptIndexes(entries, OTTER_CHARS_PER_TOKEN, DEFAULT_KEEP_RECENT_TOKENS);

    // 集合差对称（双向 ≤1 条边界消息）：单侧 diff 看不见「保留更少」方向发散（如预算被除两次 4）
    const diffS2R = [...sdkKept].filter(i => !refKept.has(i));
    const diffR2S = [...refKept].filter(i => !sdkKept.has(i));
    expect(diffS2R.length).toBeLessThanOrEqual(1);
    expect(diffR2S.length).toBeLessThanOrEqual(1);
    // 方向语义：两边保留量同量级（非全保留/全丢弃的畸形对照）
    expect(sdkKept.size).toBeGreaterThan(10);
    expect(refKept.size).toBeGreaterThan(10);
  });

  it("divisor=4 回退回归锚：预算不换算时与现状切点一致（定点值）", () => {
    const entries = makeLargeChineseSession(30, 400);
    // 现状口径：直接传 20,000（SDK 内部 chars/4）
    const legacyCut = findCutPoint(entries as never, 0, entries.length, DEFAULT_KEEP_RECENT_TOKENS);
    // 定点锚：60 条 × 400 chars=24K chars，chars/4=6K < 20K 预算 → 全保留（cut=0）
    expect(legacyCut.firstKeptEntryIndex).toBe(0);
    // 回退口径（divisor=4）：round(20,000 × 4 / 4) = 20,000——预算相同即切点相同
    const fallbackBudget = Math.round((DEFAULT_KEEP_RECENT_TOKENS * 4) / 4);
    expect(fallbackBudget).toBe(DEFAULT_KEEP_RECENT_TOKENS);
    const fallbackCut = findCutPoint(entries as never, 0, entries.length, fallbackBudget);
    expect(fallbackCut.firstKeptEntryIndex).toBe(legacyCut.firstKeptEntryIndex);
  });

  it("截断规则：「## 对话历史」节内单条 >1,500 chars 头 750+尾 750，正常块与节外消息原样", () => {
    const longReport = "[检视獭-keep] 审查结论开始。" + cn(3000) + "审查结论结束。署名。";
    const normalBlock = "[chen] 正常消息。";
    const injected = [
      "## 当前时间",
      "- 2026-09-24 15:43",
      "## 对话历史（你上次发言后的消息）",
      longReport,
      normalBlock,
      "[chen] 另一条正常消息。",
    ].join("\n");
    // 直接测截断通道（截断规则本身不依赖 slice 预算前置）
    const processed = __testApplyReplayTruncation([
      { role: "user", content: injected },
      { role: "assistant", content: "收到。" },
      { role: "user", content: "## 对话历史节外的正常 user 消息——这条不应被动。" },
    ]);
    const out = String(processed[0].content);
    // 截断标记出现 + 恒真尾注
    expect(out).toContain("（截断 ");
    expect(out).toContain("原文见前世 session jsonl");
    // 头尾各 750 保留：首尾锚文本可见
    expect(out).toContain("审查结论开始。");
    expect(out).toContain("署名。");
    // 正常块原样（未被截断）
    expect(out).toContain("[chen] 正常消息。");
    expect(out).toContain("另一条正常消息。");
    // 节外消息不动 + assistant 不动
    expect(String(processed[2].content)).toContain("节外的正常 user 消息——这条不应被动。");
    expect(String(processed[1].content)).toBe("收到。");
    // 端到端：走 serializeKeptWindow 的完整链路（前置大块撞出切点 + 尾部注入落在保留段内）
    // 60×2 条 × 520 ≈ 62K chars → 切点约在 32；但注入需在保留段——用前置大块+短尾部组合：
    // 10×800 前置（16K）+ 30×2×800 大块（48K）在前 → 切点落在大块内，尾部 16K+注入全保留
    const entries = [
      ...makeLargeChineseSession(10, 800),
      ...makeLargeChineseSession(30, 800).map(e => e), // 大块前置撞出切点
      ...makeLargeChineseSession(10, 800),
      makeUserEntry(injected),
      makeAssistantEntry("收到。"),
    ];
    const slice = sliceSessionEntries(entries, DEFAULT_KEEP_RECENT_TOKENS);
    expect(slice).toBeDefined();
    const serialized = serializeKeptWindow(slice!);
    expect(serialized).toContain(REPLAY_HEADER_TEXT); // 尾部（含注入）必在保留段
    expect(serialized).toContain("（截断 "); // 端到端链路（serializeKeptWindow）截断生效
    expect(serialized).toContain("原文见前世 session jsonl");
  });

  it("fail-open：无「## 对话历史」节头 → 原样零改动", () => {
    const longNoHeader = cn(4000) + "（无节头的普通长消息，不截断）";
    const processed = __testApplyReplayTruncation([
      { role: "user", content: longNoHeader },
      { role: "assistant", content: "ok" },
    ]);
    expect(String(processed[0].content)).toBe(longNoHeader); // 逐字相等=零改动
    expect(String(processed[0].content)).not.toContain("（截断 ");
  });

  it("低密度行为快照：code/JSON 重 fixture 切点位置锁定（快照变化必须伴随定标重审）", () => {
    const msgChars = 520;
    const entries: SessionEntry[] = [];
    for (let i = 0; i < 60; i++) {
      entries.push(makeUserEntry(codeish(msgChars) + ` #${i}`));
      entries.push(makeAssistantEntry(codeish(msgChars) + ` #${i}`));
    }
    const slice = sliceSessionEntries(entries, DEFAULT_KEEP_RECENT_TOKENS);
    expect(slice).toBeDefined();
    // 快照锚：切点位置与保留条数（codeish 形态真实密度 ~0.8 chars/token → 25K chars ≈ 31K token，
    // 超预算为已知风险；本断言钉行为快照，变化即触发定标重审，不做预算断言）
    expect(slice!.keptEntries.length).toBe(48); // 2026-09-28 实现时快照（codeish 48 条 ≈ 24,960 chars）
    expect(slice!.messagesToSummarize.length).toBeGreaterThan(0);
  });

  it("观测锚：slice 日志带 divisor/budgetChars/rule/scope 字段；告警窗口按 scope 隔离（每 scope 24h 最多 1 条）", () => {
    const logs: Array<Record<string, unknown>> = [];
    setSliceLogger(fields => logs.push(fields));
    try {
      const mkUsageSession = () => {
        const s = makeLargeChineseSession(30, 800);
        type WithUsage = { message: { usage?: unknown } };
        const attachUsage = (e: SessionEntry, usage: unknown) => {
          (e as unknown as WithUsage).message.usage = usage;
        };
        // 极低密度（出界）观测对：Δchars 4,800 / Δtok 9,000 → density 0.53…不够低，改 density≈0.2（远低于 0.45 下沿）
        attachUsage(s[s.length - 2], { input: 1000, cacheRead: 1000, cacheWrite: 0, output: 0 });
        attachUsage(s[s.length - 1], { input: 1000, cacheRead: 10_000, cacheWrite: 0, output: 0 });
        return s;
      };
      // 同一 scope 连续 5 次出界观测 → 恰 1 条 warn
      for (let i = 0; i < 5; i++) {
        const slice = sliceSessionEntries(mkUsageSession(), DEFAULT_KEEP_RECENT_TOKENS, { scopeKey: 'otter-A' });
        expect(slice).toBeDefined();
      }
      const cutLog = logs.find(l => String(l.msg).includes("cut"));
      expect(cutLog).toBeDefined();
      expect(cutLog!.divisor).toBe(1.25);
      expect(cutLog!.budgetChars).toBe(25_000);
      expect(cutLog!.rule).toBe("linear-convert");
      expect(typeof cutLog!.measuredDensity).toBe("number");
      const warnLogs = logs.filter(l => l.level === 'warn');
      expect(warnLogs.length).toBe(1); // 窗口滿后告警一次，后续不重复（24h 内）
      expect(warnLogs[0].scope).toBe('otter-A');
      // 另一 scope 不受污染：otter-B 首次观测无告警
      const logsB: Array<Record<string, unknown>> = [];
      setSliceLogger(fields => logsB.push(fields));
      sliceSessionEntries(mkUsageSession(), DEFAULT_KEEP_RECENT_TOKENS, { scopeKey: 'otter-B' });
      expect(logsB.filter(l => l.level === 'warn').length).toBe(0); // B 的窗口只有 1 次观测，未满足 5 次
    } finally {
      setSliceLogger(undefined);
    }
  });
});

const REPLAY_HEADER_TEXT = "## 对话历史（你上次发言后的消息）";

void ({} as unknown as JsonlSlice);
