/**
 * getContextWindowTokens（F20260808ctxw 窗口占用口径）单元测试。
 *
 * 回归防线：把口径改回 session 累计值（getSessionStats）时，本文件必须红。
 */
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { getContextWindowTokens } from "@frameworks/agent/context-tokens";
import { checkTokenWarning } from "@frameworks/agent/circuit-breaker-helpers";
import { createCapturingLogger } from "../../helpers/logger";

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number };

function assistantEntry(usage: Usage, stopReason = "endTurn"): SessionEntry {
  return { type: "message", message: { role: "assistant", stopReason, usage } } as unknown as SessionEntry;
}

function userEntry(): SessionEntry {
  return { type: "message", message: { role: "user", content: "hi" } } as unknown as SessionEntry;
}

function compactionEntry(): SessionEntry {
  return { type: "compaction", summary: "...", firstKeptEntryId: "e1" } as unknown as SessionEntry;
}

describe("getContextWindowTokens", () => {
  it("取末次有效 assistant usage 的分量全和（input+output+cacheRead+cacheWrite）", () => {
    const entries = [
      userEntry(),
      assistantEntry({ input: 1000, output: 100, cacheRead: 20000, cacheWrite: 0 }),
      assistantEntry({ input: 2000, output: 200, cacheRead: 30000, cacheWrite: 500 }),
    ];
    expect(getContextWindowTokens(entries)).toBe(32700);
  });

  it("usage.totalTokens 存在时优先（与 SDK calculateContextTokens 一致）", () => {
    const entries = [assistantEntry({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, totalTokens: 42000 })];
    expect(getContextWindowTokens(entries)).toBe(42000);
  });

  it("末条 assistant 为 aborted 时回退到上一条有效 usage", () => {
    const entries = [
      assistantEntry({ input: 1000, output: 100, cacheRead: 20000, cacheWrite: 0 }),
      assistantEntry({ input: 9999, output: 1, cacheRead: 99999, cacheWrite: 0 }, "aborted"),
    ];
    expect(getContextWindowTokens(entries)).toBe(21100);
  });

  it("全部 assistant usage 无效（aborted/error/全零）时返回 undefined", () => {
    const entries = [
      assistantEntry({ input: 100, output: 10, cacheRead: 1000, cacheWrite: 0 }, "error"),
      assistantEntry({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ];
    expect(getContextWindowTokens(entries)).toBeUndefined();
  });

  it("无 assistant 消息时返回 undefined", () => {
    expect(getContextWindowTokens([userEntry()])).toBeUndefined();
    expect(getContextWindowTokens([])).toBeUndefined();
  });

  it("compaction 后无新 assistant usage → undefined（不显示压缩前峰值）", () => {
    const entries = [
      assistantEntry({ input: 50000, output: 1000, cacheRead: 100000, cacheWrite: 0 }),
      compactionEntry(),
    ];
    expect(getContextWindowTokens(entries)).toBeUndefined();
  });

  it("compaction 后有新 assistant usage → 取压缩后的新值", () => {
    const entries = [
      assistantEntry({ input: 50000, output: 1000, cacheRead: 100000, cacheWrite: 0 }),
      compactionEntry(),
      userEntry(),
      assistantEntry({ input: 3000, output: 300, cacheRead: 18000, cacheWrite: 0 }),
    ];
    expect(getContextWindowTokens(entries)).toBe(21300);
  });

  it("compaction 后仅有 aborted usage → undefined", () => {
    const entries = [
      assistantEntry({ input: 50000, output: 1000, cacheRead: 100000, cacheWrite: 0 }),
      compactionEntry(),
      assistantEntry({ input: 3000, output: 300, cacheRead: 18000, cacheWrite: 0 }, "aborted"),
    ];
    expect(getContextWindowTokens(entries)).toBeUndefined();
  });
});

describe("checkTokenWarning（窗口占用口径）", () => {
  it("ctxTokens undefined 时不告警", () => {
    const logger = createCapturingLogger();
    checkTokenWarning("otter-1", undefined, logger);
    expect(logger.captured.warns).toHaveLength(0);
  });

  it("窗口占用未超 100k 不告警", () => {
    const logger = createCapturingLogger();
    checkTokenWarning("otter-1", 99_999, logger);
    expect(logger.captured.warns).toHaveLength(0);
  });

  it("窗口占用超 100k 告警", () => {
    const logger = createCapturingLogger();
    checkTokenWarning("otter-1", 100_001, logger);
    expect(logger.captured.warns).toHaveLength(1);
    expect(logger.captured.warns[0]).toContain("otter-1");
  });
});
