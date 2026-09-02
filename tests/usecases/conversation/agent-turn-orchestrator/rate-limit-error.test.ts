import { describe, it, expect } from "vitest";
import { matchRateLimitError, buildRateLimitSystemMsg, buildRateLimitDescription } from "@usecases/conversation/agent-turn-orchestrator/rate-limit-error";

describe("matchRateLimitError", () => {
  it("智谱 code 1310 配额耗尽（中文粒度说明 + 重置提示提取）", () => {
    const msg = "LLM API error: {" + '"code":"1310","message":"code: 1310, 本月配额已耗尽，将于 2026-09-04 20:22 重置"}';
    const m = matchRateLimitError(msg);
    expect(m).not.toBeNull();
    expect(m!.exhausted).toBe(true);
    expect(m!.resetHint).toBeTruthy(); // 中文/ISO 重置提示尽力提取
  });

  it("OpenAI usage_limit_reached 判配额耗尽", () => {
    const m = matchRateLimitError('LLM API error: 429 {"error":{"code":"usage_limit_reached","message":"Monthly usage limit reached"}}');
    expect(m!.exhausted).toBe(true);
  });

  it("insufficient_quota 判配额耗尽", () => {
    const m = matchRateLimitError("LLM API error: 429 You exceeded your current quota, please check your plan and billing details. (insufficient_quota)");
    expect(m!.exhausted).toBe(true);
  });

  it("GLM「quota exceeded」判配额耗尽", () => {
    const m = matchRateLimitError("LLM API error: 429 code: 1310, total quota exceeded");
    expect(m!.exhausted).toBe(true);
  });

  it("裸 429 / rate limit（无配额词）判瞬时限流不判耗尽", () => {
    const m = matchRateLimitError("LLM API error: 429 Too Many Requests");
    expect(m!.exhausted).toBe(false);
    const m2 = matchRateLimitError("LLM API error: Rate limit exceeded, please retry after 60s");
    expect(m2!.exhausted).toBe(false);
  });

  it("非限流 API 错误返回 null（不误报）", () => {
    expect(matchRateLimitError("LLM API error: connection reset by peer")).toBeNull();
    expect(matchRateLimitError("LLM API error: 500 Internal Server Error")).toBeNull();
    expect(matchRateLimitError("LLM API error: Context overflow recovery failed")).toBeNull();
    expect(matchRateLimitError("LLM API error: invalid api key")).toBeNull();
  });

  it("网络 503/连接类错误不含 429/limit 词返回 null", () => {
    expect(matchRateLimitError("LLM API error: service unavailable")).toBeNull();
  });

  it("SDK 重试耗尽形态（Rate limit after 4 retries）判瞬时限流", () => {
    const m = matchRateLimitError("LLM API error: Rate limit hit, max retries exceeded");
    expect(m!.exhausted).toBe(false);
  });
});

describe("buildRateLimitSystemMsg", () => {
  it("配额耗尽：含改派指引与台账指引", () => {
    const msg = buildRateLimitSystemMsg({ otterName: "检视獭", modelAlias: "glm", exhausted: true, resetHint: "将于 2026-09-04 20:22 重置" });
    expect(msg).toContain("[系统告警]");
    expect(msg).toContain("检视獭");
    expect(msg).toContain("glm");
    expect(msg).toContain("配额耗尽");
    expect(msg).toContain("改派");
    expect(msg).toContain("rate_limit");
    expect(msg).toContain("2026-09-04 20:22");
  });

  it("瞬时限流：提示短时恢复", () => {
    const msg = buildRateLimitSystemMsg({ otterName: "小獭", modelAlias: "glm-flash", exhausted: false });
    expect(msg).toContain("[系统提示]");
    expect(msg).toContain("glm-flash");
    expect(msg).toContain("重试已耗尽");
  });
});

describe("buildRateLimitDescription", () => {
  it("耗尽/瞬时文案区分", () => {
    expect(buildRateLimitDescription({ modelAlias: "glm", exhausted: true })).toContain("配额耗尽");
    expect(buildRateLimitDescription({ modelAlias: "glm", exhausted: false })).toContain("瞬时限流");
  });
});
