import { describe, it, expect } from "vitest";

/**
 * detectOrphanText 逻辑单元测试。
 * orchestrator 中是 private 方法，但逻辑是纯函数，独立验证更清晰。
 *
 * 逻辑：reason.kind === 'no_yield' && directText?.trim().length >= 20
 */
function detectOrphanText(reasonKind: string, directText?: string): boolean {
  return reasonKind === 'no_yield'
    && !!directText?.trim()
    && directText.trim().length >= 20;
}

describe("detectOrphanText（旁白流失检测逻辑）", () => {
  it("no_yield + 有效长文本 → true", () => {
    expect(detectOrphanText('no_yield', '这是一段超过二十个字符的直出文本内容测试')).toBe(true);
  });

  it("no_yield + 20 字符边界 → true", () => {
    expect(detectOrphanText('no_yield', '一二三四五六七八九十一二三四五六七八九十')).toBe(true);
  });

  it("no_yield + 短文本（<20 字符）→ false", () => {
    expect(detectOrphanText('no_yield', '短文本')).toBe(false);
  });

  it("no_yield + 空字符串 → false", () => {
    expect(detectOrphanText('no_yield', '')).toBe(false);
  });

  it("no_yield + undefined → false", () => {
    expect(detectOrphanText('no_yield', undefined)).toBe(false);
  });

  it("no_yield + 纯空白 → false", () => {
    expect(detectOrphanText('no_yield', '   ')).toBe(false);
  });

  it("非 no_yield（如 yield_ok）+ 有效长文本 → false", () => {
    expect(detectOrphanText('yield_ok', '这是一段超过二十个字符的直出文本内容测试')).toBe(false);
  });

  it("非 no_yield + undefined → false", () => {
    expect(detectOrphanText('guard_abort', undefined)).toBe(false);
  });
});
