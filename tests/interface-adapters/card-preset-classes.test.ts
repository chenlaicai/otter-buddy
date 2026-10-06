/**
 * 卡片预设类库一致性测试（F20261006cssp）：
 * - 预设 CSS 与类名清单机械一致（清单从 CSS 正则提取，双端共享同一源）
 * - 契约文本的预设节与清单一致（防契约漏报/多报类名）
 * - 预设 CSS 体积预算（≤8KB 进库门槛的回归锁）
 * - 预设仅用已声明的设计 token 色值，不自造颜色
 */
import { describe, it, expect } from "vitest";
import {
  CARD_PRESET_CLASSES_CSS,
  CARD_PRESET_CLASS_NAMES,
} from "@contract/api/html-card";
import { HTML_CARD_CONTRACT } from "@interface-adapters/agent-runtime/tools/html-card-contract-tool";

describe("卡片预设类库（F20261006cssp）", () => {
  it("类名清单从 CSS 机械提取：每个清单项在 CSS 中有定义", () => {
    expect(CARD_PRESET_CLASS_NAMES.length).toBeGreaterThan(10);
    for (const name of CARD_PRESET_CLASS_NAMES) {
      expect(CARD_PRESET_CLASSES_CSS).toMatch(new RegExp(`\\.${name}\\s*{`));
    }
  });

  it("CSS 内类定义全部进清单（无漏报）", () => {
    const cssClasses = [...new Set([...CARD_PRESET_CLASSES_CSS.matchAll(/\.([a-zA-Z][\w-]*)\s*\{/g)].map((m) => m[1]))];
    for (const cls of cssClasses) {
      expect(CARD_PRESET_CLASS_NAMES).toContain(cls);
    }
    expect(cssClasses.length).toBe(CARD_PRESET_CLASS_NAMES.length);
  });

  it("契约预设节覆盖清单中的每个类名（告知层不漂移）", () => {
    for (const name of CARD_PRESET_CLASS_NAMES) {
      expect(HTML_CARD_CONTRACT).toContain(`.${name}`);
    }
  });

  it("契约声明「推荐不强制」与覆盖语义（搭档定调入契约）", () => {
    expect(HTML_CARD_CONTRACT).toContain("推荐使用，不强制");
    expect(HTML_CARD_CONTRACT).toContain("优先用预设");
  });

  it("预设 CSS 体积在 8KB 预算内（进出机制的体积闸回归锁）", () => {
    expect(Buffer.byteLength(CARD_PRESET_CLASSES_CSS)).toBeLessThanOrEqual(8192);
  });

  it("预设色值只用设计 token（var() 引用），不硬编码水獭色阶色值", () => {
    // 禁止出现 #FAF6F0 等 token 原始色值（应写 var(--otter-50)）；白/红等功能色除外
    const rawHex = CARD_PRESET_CLASSES_CSS.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    const allowed = new Set(["#fff", "#FFF"]);
    for (const hex of rawHex) {
      expect(allowed.has(hex)).toBe(true);
    }
  });
});
