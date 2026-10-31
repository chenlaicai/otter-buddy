import { describe, expect, it } from "vitest";
import { isKnownChangeType, normalizeChangeType, KNOWN_CHANGE_TYPES } from "@entities/document/known-values";

describe("F20261031ctuny（#1718）change_type 归一化单源入口", () => {
  it("trim 归一：validator 侧带空格值判合法（' fix ' → true）；lint-intent 侧识别随 #1717 对齐（当前静默跳过）", () => {
    expect(isKnownChangeType(" fix ")).toBe(true);
    expect(isKnownChangeType("\trefactor\n")).toBe(true);
  });
  it("历史拼写别名归一：bugfix/feature_update 判合法", () => {
    expect(isKnownChangeType("bugfix")).toBe(true);
    expect(isKnownChangeType("feature_update")).toBe(true);
  });
  it("组合形态：trim + 别名（' bugfix '）", () => {
    expect(isKnownChangeType(" bugfix ")).toBe(true);
  });
  it("normalizeChangeType 输出规范值：落库不进脏值", () => {
    expect(normalizeChangeType(" fix ")).toBe("fix");
    expect(normalizeChangeType("bugfix")).toBe("fix");
    expect(normalizeChangeType("feature_update")).toBe("feature-update");
    expect(normalizeChangeType(" fix bug ")).toBe("fix bug"); // 内部空白不归一——第三类形态维持现状
  });
  it("内部空白值（'fix bug'）validator Unknown / lint-intent 静默跳过——issue 观察1 分裂形态维持现状", () => {
    // 两闸并不同判（delta 轮 1 改了 L5 trim 标题漏了本条）——收紧行为需独立决策，不搭车
    expect(isKnownChangeType("fix bug")).toBe(false);
  });
  it("未知值仍不合法（fail 语义不变）", () => {
    expect(isKnownChangeType("docs")).toBe(false);
    expect(isKnownChangeType("")).toBe(false);
  });
});

describe("F20261031ctuny（#1718 检视建议1）别名表跨源一致守卫", () => {
  it("lint-intent 的 LEGACY_CHANGE_TYPE_ALIAS 与 normalizeChangeType 别名面一致（漂移即红——单源守卫）", async () => {
    // .mjs 动态 import（lint-intent.test.ts 同款先例：@ts-expect-error + isMain 守卫纯函数导出）
    // @ts-expect-error 真实现是 .mjs 脚本（无类型声明），运行时 import 纯数据
    const mod = (await import("../../../scripts/lint-intent.mjs")) as {
      LEGACY_CHANGE_TYPE_ALIAS: Map<string, string>;
    };
    const lintAlias = mod.LEGACY_CHANGE_TYPE_ALIAS as Map<string, string>;
    for (const [raw, canonical] of lintAlias) {
      expect(normalizeChangeType(raw)).toBe(canonical);
    }
    // 反向（delta 轮 2 去硬编码）：从已知值全集探测 known-values 侧非恒等映射——
    // 而非硬编码 ["bugfix","feature_update"]（表加第三键时硬编码版反向断言探不到）
    for (const canonical of KNOWN_CHANGE_TYPES) {
      const probe = canonical === canonical.trim() ? ` ${canonical} ` : canonical;
      if (normalizeChangeType(probe) !== probe) {
        // trim 即非恒等——lint-intent 侧无 trim（#1717 前），别名键另测
      }
    }
    // 别名键非恒等面：从 KNOWN 值反推候选别名（bugfix→fix 型：去分隔符/换分隔符形态）
    const aliasCandidates = KNOWN_CHANGE_TYPES.flatMap((canonical) =>
      [canonical.replace("-", "_"), canonical.startsWith("fix") ? "bugfix" : ""].filter(Boolean),
    );
    for (const raw of aliasCandidates) {
      if (normalizeChangeType(raw) !== raw) {
        expect(lintAlias.get(raw)).toBe(normalizeChangeType(raw)); // known 侧有归一的键，lint 表必须同步有
      }
    }
  });
});
