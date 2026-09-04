/**
 * F20260904cq30：compaction 触发线质量修正的边界测试。
 *
 * 验证注入的 reserveTokens=700_000 在 1M 窗口（1048576）下的触发边界：
 * 1048576 − 700000 = 348576 ≈ 340K 触发线。
 * 水位低于触发线不压缩；达到/超过触发线压缩。
 * 同时锁定 SDK shouldCompact 公式行为，防止 SDK 升级静默改变触发语义。
 */
import { describe, expect, it } from "vitest";
import { shouldCompact } from "@earendil-works/pi-coding-agent";

/** Otter 注入的 reserveTokens（F20260904cq30，model-runtime-registry applyOverrides） */
export const OTTER_RESERVE_TOKENS = 700_000;
/** config.yaml 中 mimo/glm 的 contextWindow（全模型统一 1M） */
const CONTEXT_WINDOW = 1_048_576;
/** 实际触发线：1048576 − 700000 = 348576（标称 300K，见 F 文档取舍） */
const TRIGGER_LINE = CONTEXT_WINDOW - OTTER_RESERVE_TOKENS;

const SETTINGS = {
  enabled: true,
  reserveTokens: OTTER_RESERVE_TOKENS,
  keepRecentTokens: 20_000,
} as Parameters<typeof shouldCompact>[2];

describe("F20260904cq30 compaction 触发线 340K 边界", () => {
  it("水位 300K（标称线以下）不触发", () => {
    expect(shouldCompact(300_000, CONTEXT_WINDOW, SETTINGS)).toBe(false);
  });

  it("水位 348575（触发线−1）不触发", () => {
    expect(shouldCompact(348_575, CONTEXT_WINDOW, SETTINGS)).toBe(false);
  });

  it("水位 348576（触发线，等号语义：> 才触发）不触发", () => {
    // 公式为 contextTokens > contextWindow − reserveTokens，等于触发线时不触发
    expect(shouldCompact(TRIGGER_LINE, CONTEXT_WINDOW, SETTINGS)).toBe(false);
  });

  it("水位 348577（触发线+1）触发", () => {
    expect(shouldCompact(348_577, CONTEXT_WINDOW, SETTINGS)).toBe(true);
  });

  it("水位 538K（实测膨胀案例水位）触发", () => {
    expect(shouldCompact(538_633, CONTEXT_WINDOW, SETTINGS)).toBe(true);
  });

  it("水位 743K（9/3 峰值）触发", () => {
    expect(shouldCompact(743_084, CONTEXT_WINDOW, SETTINGS)).toBe(true);
  });

  it("水位 60-90K（好体验区）远低于触发线不触发", () => {
    for (const ctx of [60_000, 73_000, 90_000, 200_000]) {
      expect(shouldCompact(ctx, CONTEXT_WINDOW, SETTINGS)).toBe(false);
    }
  });

  it("compaction 被禁用时不触发（partial merge 下 enabled 保留用户/默认值）", () => {
    expect(shouldCompact(500_000, CONTEXT_WINDOW, { ...SETTINGS, enabled: false })).toBe(false);
  });
});
