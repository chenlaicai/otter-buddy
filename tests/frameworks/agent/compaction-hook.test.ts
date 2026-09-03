/**
 * F20260903cmpk：session_before_compact 钩子单元测试。
 *
 * 覆盖：reason 分流（threshold 替换 / overflow·manual 放行）、
 * 合成成功返回自定义 compaction、空串/异常/超时降级放行、
 * prompt 构建含七段模板 + previousSummary 逐代保留。
 */
import { describe, expect, it } from "vitest";
import {
  buildCompactionSynthesisPrompt,
  handleSessionBeforeCompact,
  type CompactionPreparationLike,
  type CompactionHookDeps,
} from "@frameworks/agent/compaction-hook";

function makePreparation(overrides?: Partial<CompactionPreparationLike>): CompactionPreparationLike {
  return {
    firstKeptEntryId: "entry-keep-1",
    messagesToSummarize: [
      { role: "user", content: "帮我修登录 bug" },
      { role: "assistant", content: [{ type: "text", text: "已定位到 auth.ts:42" }] },
    ],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 95_000,
    ...overrides,
  };
}

function makeDeps(summary: string, fail = false): CompactionHookDeps & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    synthesize: async (prompt: string) => {
      prompts.push(prompt);
      if (fail) throw new Error("synthesis exploded");
      return summary;
    },
    logger: { info: () => {}, warn: () => {} },
  };
}

describe("handleSessionBeforeCompact（F20260903cmpk）", () => {
  it("threshold + 合成成功 → 返回自定义 compaction（summary/切口/tokensBefore 来自 preparation）", async () => {
    const deps = makeDeps("## 交接摘要（七段）\n① 下一步：继续修");
    const result = await handleSessionBeforeCompact(
      { reason: "threshold", preparation: makePreparation() },
      deps,
      "大獭",
    );
    expect(result).toBeDefined();
    expect(result!.compaction.summary).toContain("七段");
    expect(result!.compaction.firstKeptEntryId).toBe("entry-keep-1");
    expect(result!.compaction.tokensBefore).toBe(95_000);
    // prompt 携带历史消息
    expect(deps.prompts[0]).toContain("帮我修登录 bug");
    expect(deps.prompts[0]).toContain("auth.ts:42");
  });

  it("overflow → 放行 Pi 默认（救急场景不赌合成速度）", async () => {
    const deps = makeDeps("不该被用");
    const result = await handleSessionBeforeCompact(
      { reason: "overflow", preparation: makePreparation() },
      deps,
      "大獭",
    );
    expect(result).toBeUndefined();
    expect(deps.prompts).toHaveLength(0);
  });

  it("manual → 放行 Pi 默认（人为 /compact 尊重默认行为）", async () => {
    const deps = makeDeps("不该被用");
    const result = await handleSessionBeforeCompact(
      { reason: "manual", preparation: makePreparation() },
      deps,
      "大獭",
    );
    expect(result).toBeUndefined();
    expect(deps.prompts).toHaveLength(0);
  });

  it("deps 为 null（未注入）→ 放行 Pi 默认", async () => {
    const result = await handleSessionBeforeCompact(
      { reason: "threshold", preparation: makePreparation() },
      null,
      "大獭",
    );
    expect(result).toBeUndefined();
  });

  it("合成抛异常 → 降级放行 Pi 默认（不阻塞压缩链路）", async () => {
    const deps = makeDeps("", true);
    const result = await handleSessionBeforeCompact(
      { reason: "threshold", preparation: makePreparation() },
      deps,
      "大獭",
    );
    expect(result).toBeUndefined();
  });

  it("合成返回空串 → 降级放行 Pi 默认", async () => {
    const deps = makeDeps("   ");
    const result = await handleSessionBeforeCompact(
      { reason: "threshold", preparation: makePreparation() },
      deps,
      "大獭",
    );
    expect(result).toBeUndefined();
  });

  it("合成超时 → 降级放行 Pi 默认（不吊死主循环）", async () => {
    const deps: CompactionHookDeps = {
      synthesize: () => new Promise<string>((resolve) => setTimeout(() => resolve("太慢了"), 500)),
      logger: { info: () => {}, warn: () => {} },
    };
    const result = await handleSessionBeforeCompact(
      { reason: "threshold", preparation: makePreparation() },
      deps,
      "大獭",
      50,
    );
    expect(result).toBeUndefined();
  }, 10_000);

  it("previousSummary 存在时 prompt 要求谱系逐代追加", async () => {
    const deps = makeDeps("x");
    await handleSessionBeforeCompact(
      { reason: "threshold", preparation: makePreparation({ previousSummary: "gen3: 前情" }) },
      deps,
      "大獭",
    );
    expect(deps.prompts[0]).toContain("gen3: 前情");
    expect(deps.prompts[0]).toContain("逐代追加");
  });
});

describe("buildCompactionSynthesisPrompt（F20260903cmpk）", () => {
  it("包含七段模板 + split-turn 前缀 + meta 行", () => {
    const prompt = buildCompactionSynthesisPrompt(
      makePreparation({
        turnPrefixMessages: [{ role: "user", content: "本轮开头" }],
        isSplitTurn: true,
      }),
      "大獭",
    );
    expect(prompt).toContain("七段模板");
    expect(prompt).toContain("本轮开头");
    expect(prompt).toContain("[本轮前缀/搭档]");
    expect(prompt).toContain("95");
  });
});
