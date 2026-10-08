/**
 * #1247：上下文窗口超限识别单测（与 rate-limit-error.test.ts 同骨架）。
 *
 * 用例文本来源：issue #1247 原文实证（kimi-256k 2026-09-29 现场）+ OpenAI/Anthropic
 * 公开错误形态 + 中文变体。互斥性用例确保与限流词族不串扰。
 */
import { describe, it, expect } from "vitest";
import {
  matchContextOverflowError,
  buildContextOverflowSystemMsg,
  buildContextOverflowDescription,
} from "@usecases/conversation/agent-turn-orchestrator/context-overflow-error";
import { matchRateLimitError } from "@usecases/conversation/agent-turn-orchestrator/rate-limit-error";

describe("matchContextOverflowError", () => {
  it("kimi-256k 实证文本（issue #1247 原文）识别 + 数字提取", () => {
    const msg = 'kimi-256k API error (400): "Your request exceeded k3-256k model token limit: 273412 > 262144"';
    const m = matchContextOverflowError(msg);
    expect(m).not.toBeNull();
    expect(m!.requestedTokens).toBe(273412);
    expect(m!.windowTokens).toBe(262144);
  });

  it("OpenAI maximum context length 形态识别 + 数字提取", () => {
    const msg = "LLM API error: OpenAI API error (400): This model's maximum context length is 262144 tokens. However, you requested 273412 tokens.";
    const m = matchContextOverflowError(msg);
    expect(m).not.toBeNull();
    expect(m!.requestedTokens).toBe(273412);
    expect(m!.windowTokens).toBe(262144);
  });

  it("prompt is too long 形态识别 + 双数字提取", () => {
    const m = matchContextOverflowError("LLM API error: 400 prompt is too long: 300000 tokens, maximum is 262144");
    expect(m).not.toBeNull();
    expect(m!.requestedTokens).toBe(300000);
  });

  it("SDK Context overflow recovery 形态识别", () => {
    expect(matchContextOverflowError("LLM API error: Context overflow recovery failed")).not.toBeNull();
  });

  it("中文「上下文超限」形态识别", () => {
    expect(matchContextOverflowError("LLM API error: (400) 输入内容超长，超过模型上下文长度限制")).not.toBeNull();
    expect(matchContextOverflowError("(400) 请求上下文超出限制")).not.toBeNull();
  });

  it("非超窗错误返回 null（不误报）", () => {
    expect(matchContextOverflowError("LLM API error: invalid api key")).toBeNull();
    expect(matchContextOverflowError("LLM API error: 500 Internal Server Error")).toBeNull();
    expect(matchContextOverflowError("LLM API error: connection reset by peer")).toBeNull();
  });

  it("互斥性：限流词族不被超窗 matcher 命中（429 配额场景归 rate_limit 管）", () => {
    const quotaMsg = "LLM API error: 429 Too Many Requests. quota exhausted";
    expect(matchContextOverflowError(quotaMsg)).toBeNull();
    expect(matchRateLimitError(quotaMsg)).not.toBeNull();
  });

  it("互斥性：超窗词族不被限流 matcher 命中（kimi-256k 400 场景归 context_overflow 管）", () => {
    const overflowMsg = 'kimi-256k API error (400): "Your request exceeded k3-256k model token limit: 273412 > 262144"';
    expect(matchRateLimitError(overflowMsg)).toBeNull();
    expect(matchContextOverflowError(overflowMsg)).not.toBeNull();
  });
});

describe("buildContextOverflow 文案", () => {
  const match = { requestedTokens: 273412, windowTokens: 262144 };
  it("告警文案含模型、数字提示与处置建议", () => {
    const msg = buildContextOverflowSystemMsg({ otterName: "开发獭", modelAlias: "kimi-256k", match });
    expect(msg).toContain("开发獭");
    expect(msg).toContain("kimi-256k");
    expect(msg).toContain("273,412");
    expect(msg).toContain("重试同一注入无意义");
  });

  it("description 台账可 grep（含模型与超限词）", () => {
    const d = buildContextOverflowDescription({ modelAlias: "kimi-256k", match });
    expect(d).toContain("kimi-256k");
    expect(d).toContain("上下文窗口超限");
  });

  it("数字缺失时文案不依赖提取成功（无 undefined 字面量）", () => {
    const msg = buildContextOverflowSystemMsg({ otterName: "开发獭", modelAlias: "kimi-256k", match: {} });
    expect(msg).not.toContain("undefined");
    const d = buildContextOverflowDescription({ modelAlias: "kimi-256k", match: {} });
    expect(d).not.toContain("undefined");
  });
});
