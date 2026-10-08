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
    // ⚠️ 边界注记（PR #1318 复核建议 3）：本正则带 `{` 锚，与 contract 侧 CARD_PRESET_CLASS_NAMES 的无锚正则不同源——
    // 当前清单全为单类规则，两处等价；若未来预设引入伪类/组合选择器规则，两处分叉、本测试红——
    // 届时统一为共享提取函数（见 contract 侧同款注释）
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

  it("契约预设节不多报：契约提到的类名必须在清单内（建议 1 双向锁，防手写漂移面）", () => {
    // 契约「预设类库」节内提到的 .foo 类名 ⊆ 清单（提取节内全部 .xxx，排除样式变量节的 var(--x) 无关内容）
    const section = HTML_CARD_CONTRACT.split("## 预设类库")[1]?.split("## ")[0] ?? "";
    expect(section.length).toBeGreaterThan(100);
    const mentioned = [...new Set([...section.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))];
    const unknown = mentioned.filter((m) => !CARD_PRESET_CLASS_NAMES.includes(m));
    expect(unknown).toEqual([]);
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

  it("预设引用的每个 var() 在设计 token 层有声明（严重 1 回归锁：--caramel-600 静默失效事故）", async () => {
    // 双端同源机械比对：预设 CSS 的 var() 引用 ⊆ HtmlCard CARD_TOKEN_CSS 的声明集
    const htmlCardPath = new URL("../../web/src/pages/conversation/HtmlCard.tsx", import.meta.url);
    const src = await import("node:fs").then((fs) => fs.readFileSync(htmlCardPath, "utf-8"));
    const tokenBlock = src.match(/CARD_TOKEN_CSS = `:root \{([\s\S]*?)\}`/);
    expect(tokenBlock).toBeTruthy();
    const declared = new Set([...tokenBlock![1].matchAll(/--([\w-]+)\s*:/g)].map((m) => m[1]));
    expect(declared.size).toBeGreaterThanOrEqual(22);
    const referenced = [...new Set([...CARD_PRESET_CLASSES_CSS.matchAll(/var\(--([\w-]+)\)/g)].map((m) => m[1]))];
    expect(referenced.length).toBeGreaterThan(0);
    const missing = referenced.filter((t) => !declared.has(t));
    expect(missing).toEqual([]);
  });
});
