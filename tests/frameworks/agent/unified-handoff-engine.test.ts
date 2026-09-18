/**
 * F20260918uhuc：统一引擎 + jsonl 切片器 + 锁交接模式单元测试。
 *
 * 覆盖：
 * - narrative-synthesis-engine：prompt 组装（三源原料 + selfSummary 独立层）+ 档案结构（V2 golden）
 * - session-slicer：findCutPoint 对齐切片（keepRecent 窗口 + split turn）
 * - SimpleLockManager.setHandoffMode：V3 冻结窗口锁超时对齐（30s → 120s）
 * - archiveReasonToSessionStatus：V4 血缘（compaction → restarted）
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildNarrativeSynthesisPrompt,
  buildMechanicalArchive,
  assembleHandoffArchive,
} from "@frameworks/agent/narrative-synthesis-engine";
import { sliceSessionEntries, serializeKeptWindow, DEFAULT_KEEP_RECENT_TOKENS } from "@frameworks/agent/session-slicer";
import { SimpleLockManager, HANDOFF_LOCK_WAITER_TIMEOUT_MS } from "@frameworks/agent/session-helpers";
import { archiveReasonToSessionStatus } from "@entities/otter/otter-session";

// ─── jsonl 切片器：构造 SDK SessionEntry 形状的测试数据 ───

function makeMessageEntry(id: string, role: "user" | "assistant", text: string, tokens = 1000) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-09-18T10:00:00Z",
    message: {
      role,
      content: role === "user" ? text : [{ type: "text", text }],
      ...(role === "assistant" ? { stopReason: "stop", usage: { input: tokens, output: 100, cacheRead: 0, cacheWrite: 0 } } : {}),
    },
  } as never;
}

describe("sliceSessionEntries（U2：自实现 SDK 同款切片）", () => {
  it("短历史（< keepRecent 窗口）→ 无可压缩段，返回 undefined", () => {
    const entries = [makeMessageEntry("e1", "user", "你好"), makeMessageEntry("e2", "assistant", "在的")];
    expect(sliceSessionEntries(entries)).toBeUndefined();
  });

  it("长历史 → 切出待压缩段与保留段，firstKeptEntryId 有值", () => {
    const entries: never[] = [];
    for (let i = 0; i < 80; i++) {
      // 真实体量：每条 2000 字符 ≈ 500 token（estimateTokens 按字符/4 估算），×160 条远超 20K 窗口
      entries.push(makeMessageEntry(`e${i}`, "user", `用户消息 ${i} ${"x".repeat(2000)}`));
      entries.push(makeMessageEntry(`a${i}`, "assistant", `回复 ${i} ${"y".repeat(2000)}`));
    }
    const slice = sliceSessionEntries(entries);
    expect(slice).toBeDefined();
    expect(slice!.messagesToSummarize.length).toBeGreaterThan(0);
    expect(slice!.firstKeptEntryId).toBeTruthy();
    expect(slice!.keptEntries.length).toBeGreaterThan(0);
  });

  it("previousSummary：jsonl 含 compaction entry 时提取其 summary 作谱系种子", () => {
    const compaction = {
      type: "compaction",
      id: "c1",
      parentId: null,
      timestamp: "2026-09-18T09:00:00Z",
      summary: "上一代摘要",
      firstKeptEntryId: "e0",
      tokensBefore: 50000,
    } as never;
    const entries: never[] = [compaction];
    for (let i = 0; i < 80; i++) {
      entries.push(makeMessageEntry(`e${i}`, "user", `msg ${i} ${"x".repeat(2000)}`));
      entries.push(makeMessageEntry(`a${i}`, "assistant", `reply ${i} ${"y".repeat(2000)}`));
    }
    const slice = sliceSessionEntries(entries);
    expect(slice?.previousSummary).toBe("上一代摘要");
  });

  it("serializeKeptWindow：保留段序列化为 [User]/[Assistant] 文本", () => {
    const entries: never[] = [];
    for (let i = 0; i < 80; i++) {
      entries.push(makeMessageEntry(`e${i}`, "user", `msg ${i} ${"x".repeat(2000)}`));
      entries.push(makeMessageEntry(`a${i}`, "assistant", `reply ${i} ${"y".repeat(2000)}`));
    }
    const slice = sliceSessionEntries(entries)!;
    const text = serializeKeptWindow(slice);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[User]");
    expect(text).toContain("[Assistant]");
  });

  it("DEFAULT_KEEP_RECENT_TOKENS 对齐 Pi 默认 20K", () => {
    expect(DEFAULT_KEEP_RECENT_TOKENS).toBe(20_000);
  });
});

// ─── 统一引擎：prompt 与档案组装 ───

describe("buildNarrativeSynthesisPrompt（V2 golden：三源原料 + 叠加）", () => {
  it("selfSummary 作为独立原料层注入（不转述），§①② 与其对齐", () => {
    const prompt = buildNarrativeSynthesisPrompt({
      otterName: "大獭",
      oldSessionId: "sess-12345678",
      trigger: "手动",
      messagesToSummarize: [{ role: "user", content: "修复登录 bug" }],
      selfSummary: "我要换模型继续任务X第3步",
    });
    expect(prompt).toContain("触发方自总结");
    expect(prompt).toContain("<self-summary>");
    expect(prompt).toContain("我要换模型继续任务X第3步");
    expect(prompt).toContain("触发: 手动");
  });

  it("previousSummary 走合并式更新（谱系继承，不重置）", () => {
    const prompt = buildNarrativeSynthesisPrompt({
      otterName: "大獭",
      oldSessionId: "sess-12345678",
      trigger: "水位",
      messagesToSummarize: [{ role: "user", content: "x" }],
      previousSummary: "前情：完成了 A 和 B",
      lineage: "- gen1 s1: 初代\n- gen2 s2: 二代",
    });
    expect(prompt).toContain("<previous-summary>");
    expect(prompt).toContain("合并式更新");
    // gen N 机械推导：2 行 lineage → gen3；谱系行追加在既有行之后
    expect(prompt).toContain("gen 3");
    expect(prompt).toContain("- gen2 s2: 二代\n- gen3 sess-123: {一句话干了什么}");
  });

  it("状态盘点 + prefetch 机械供料注入（§⑤ 不依赖 jsonl 质量）", () => {
    const prompt = buildNarrativeSynthesisPrompt({
      otterName: "大獭",
      trigger: "熔断",
      messagesToSummarize: [],
      stateInventoryText: "## 活状态盘点\n- 在场: 大獭 手中",
      prefetch: {
        contextKeys: ["task_status", "next_step"],
        activeArtifacts: [{ id: "res-1234567890ab", resourceType: "pr", title: "统一交接" }],
        recentUserMessages: ["把压缩换成交接"],
      },
    });
    expect(prompt).toContain("- 在场: 大獭 手中");
    expect(prompt).toContain("task_status");
    expect(prompt).toContain("pr res-1234");
    expect(prompt).toContain("统一交接");
    expect(prompt).toContain("把压缩换成交接");
  });
});

describe("assembleHandoffArchive + buildMechanicalArchive（V2 档案结构）", () => {
  it("叠加式档案四段结构：意图书（原话）→ 叙事 → 机械供料", () => {
    const archive = assembleHandoffArchive({
      narrativeSummary: "### ① 下一步：继续修 X",
      selfSummary: "我的意图原话",
      fileTrail: "文件轨迹",
      stateInventory: "状态盘点",
      recencyWindow: "近期保留",
    });
    expect(archive).toContain("## 前世档案（新世必读）");
    expect(archive.indexOf("① 交接意图书")).toBeLessThan(archive.indexOf("② 历史叙事摘要"));
    expect(archive.indexOf("② 历史叙事摘要")).toBeLessThan(archive.indexOf("④ 机械供料"));
    expect(archive).toContain("我的意图原话"); // 原话独立保留不转述
    expect(archive).toContain("近期保留");
  });

  it("机械档案（降级形态）：自总结原话保留 + 机械四件完整", () => {
    const archive = buildMechanicalArchive({
      otterName: "大獭",
      trigger: "水位",
      oldSessionId: "sess-abcdefg",
      selfSummary: "意图",
      stateInventoryText: "盘点",
      recencyWindow: "近期",
      fileTrail: "轨迹",
    });
    expect(archive).toContain("机械转储");
    expect(archive).toContain("① 交接意图书");
    expect(archive).toContain("近期保留段");
    expect(archive).toContain("上一世 session 文件完整保留在磁盘");
  });
});

// ─── V3 冻结窗口：锁超时对齐 ───

describe("SimpleLockManager 交接模式（V3 锁超时对齐）", () => {
  it("HANDOFF_LOCK_WAITER_TIMEOUT_MS = 120s（合成 60s 上界 + turn 尾缓冲）", () => {
    expect(HANDOFF_LOCK_WAITER_TIMEOUT_MS).toBe(120_000);
  });

  it("交接模式内 waiter 超时用 120s 而非默认 30s（vi.useFakeTimers）", async () => {
    vi.useFakeTimers();
    try {
      const lm = new SimpleLockManager(30_000);
      const release1 = await lm.acquire("session:otter-1");
      lm.setHandoffMode("session:otter-1", true); // 交接开始

      const waiter = lm.acquire("session:otter-1");
      // 推进 35s：默认 30s 已过，交接模式下 waiter 仍应等待
      await vi.advanceTimersByTimeAsync(35_000);
      release1();
      const release2 = await waiter; // 交接持锁者释放后 waiter 获得
      expect(release2).toBeTypeOf("function");
      release2();

      // 交接结束后恢复正常超时
      lm.setHandoffMode("session:otter-1", false);
      const release3 = await lm.acquire("session:otter-1");
      const failWaiter = lm.acquire("session:otter-1");
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(failWaiter).rejects.toThrow("Lock acquire timeout");
      release3();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── V4 血缘：reason 枚举 ───

describe("archiveReasonToSessionStatus（V4 reason=compaction）", () => {
  it("'compaction' → 'restarted'（换世归档，session 链同构）", () => {
    expect(archiveReasonToSessionStatus("compaction")).toBe("restarted");
    expect(archiveReasonToSessionStatus("restart")).toBe("restarted");
    expect(archiveReasonToSessionStatus("dissolve")).toBe("archived");
  });
});
