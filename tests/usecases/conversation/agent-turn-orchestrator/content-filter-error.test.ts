import { describe, expect, it } from "vitest";
import { isContentFilterError } from "@usecases/conversation/agent-turn-orchestrator/content-filter-error";

describe("#1762 content_filter 错误识别", () => {
  it("识别 durable/pi-ai 上抛的 stop reason 终态", () => {
    expect(isContentFilterError("LLM API error: Unhandled stop reason: content_filter")).toBe(true);
  });

  it("大小写不敏感，兼容结构化错误码", () => {
    expect(isContentFilterError('provider error: {"code":"CONTENT_FILTER"}')).toBe(true);
  });

  it.each([
    "LLM API error: 500 Internal Server Error",
    "LLM API error: 429 Too Many Requests",
    "Durable prompt requires currentInvokeId",
  ])("普通错误不进内容过滤恢复链：%s", message => {
    expect(isContentFilterError(message)).toBe(false);
  });
});
