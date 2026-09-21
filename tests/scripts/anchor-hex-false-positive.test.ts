/**
 * #1089 lint-prompt-anchors hex 色值假阳性修复测试。
 *
 * 现场修复动机：F20260921vsds 词典提交时，色值 #000（如 border: 2px solid #000）
 * 命中 #\d{3,} 被判为 issue 锚点，误拦合法 commit，被迫白名单放行占配额。
 *
 * 验证矩阵（判别器纯函数，直接 import 断言）：
 * 1. CSS 语境色值（solid/底/色/gradient 等词前置）→ 判为色值（放行）
 * 2. 真 issue 锚点（无 CSS 语境）→ 判为锚点（拦截）
 * 3. CSS 词在 24 字符窗口外 → 不误放（真 issue 号仍判锚点）
 */
import { describe, it, expect } from "vitest";
import { isHexColorHit } from "../../scripts/anchor-hex-detector.mjs";

describe("isHexColorHit 判别器（#1089 修复）", () => {
  it("CSS 语境色值：solid #000", () => {
    expect(isHexColorHit("border: 2px solid #000 全组件", "#000")).toBe(true);
  });
  it("CSS 语境色值：中文语境「底 #0a0a0a」", () => {
    expect(isHexColorHit("深底 #0a0a0a 局部光", "#0a0a0a")).toBe(true);
  });
  it("CSS 语境色值：色块 #FFD400", () => {
    expect(isHexColorHit("明快多色底 + 黑描边 色块 #FFD400 打底", "#FFD400")).toBe(true);
  });
  it("无 CSS 语境的纯 issue 号：参见 #123", () => {
    expect(isHexColorHit("参见 #123 的讨论", "#123")).toBe(false);
  });
  it("CSS 词在 24 字符窗口外的真 issue 号：仍判锚点", () => {
    expect(isHexColorHit("border 边框规则详见另一个很长的说明文档 #456789", "#456789")).toBe(false);
  });
  it("同句混排：CSS 词后的色值放行，其后远处的 issue 号仍拦截", () => {
    const line = "用 solid #000 描边，验收标准见 #1089 的问题描述";
    expect(isHexColorHit(line, "#000")).toBe(true);
    // #1089 前文 24 字符是「描边，验收标准见」——无 CSS 语境词，判锚点
    expect(isHexColorHit(line, "#1089")).toBe(false);
  });
});
