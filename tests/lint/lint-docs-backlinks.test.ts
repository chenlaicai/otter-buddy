import { describe, it, expect } from "vitest";
// #1294 / F20261103blnkr: from 链存在性检查 + 反向索引计算（纯函数测试）
// 方向定案：反向关系不物化（append-only），computeReverseIndex 扫描期计算
import { findBrokenBacklinks, computeReverseIndex } from "../../scripts/lint-docs.mjs";

describe("findBrokenBacklinks（#1294 from 链存在性）", () => {
  it("from 指向不存在的文档 → 报断链", () => {
    const entries = [
      { rel: "docs/features/2026/11/02/new-doc.md", id: "F20261102aaa1", from: ["F20260101xxxx"] },
    ];
    const broken = findBrokenBacklinks(entries);
    expect(broken.length).toBe(1);
    expect(broken[0].danglingForward).toBe("F20260101xxxx");
  });

  it("from 指向存在的文档（含跨域 F→R）→ 不报", () => {
    const entries = [
      { rel: "docs/features/2026/11/02/a.md", id: "F20261102aaa1", from: ["R20261030aaaa"] },
      { rel: "docs/research/2026/10/30/r.md", id: "R20261030aaaa", from: [] },
    ];
    expect(findBrokenBacklinks(entries)).toEqual([]);
  });

  it("from 含自身 id → 报环", () => {
    const entries = [{ rel: "docs/features/2026/11/02/self.md", id: "F20261102dddd4", from: ["F20261102dddd4"] }];
    const broken = findBrokenBacklinks(entries);
    expect(broken.length).toBe(1);
    expect(broken[0].self).toBe("F20261102dddd4");
  });

  it("标量 from 形态（非数组非空）→ 报形态违规（防静默归零）", () => {
    const entries = [
      { rel: "docs/features/2026/11/02/a.md", id: "F20261102aaa1", from: [], fromMalformed: true },
    ];
    const broken = findBrokenBacklinks(entries);
    expect(broken.length).toBe(1);
    expect(broken[0].malformed).toContain("causal_links.from");
  });

  it("无 from 普通文档 → 不报（绝大多数形态）", () => {
    const entries = [
      { rel: "docs/features/2026/11/02/plain.md", id: "F20261102bbbb2", from: [] },
    ];
    expect(findBrokenBacklinks(entries)).toEqual([]);
  });
});

describe("computeReverseIndex（#1294 反向索引——不物化，扫描期计算）", () => {
  it("多文档指向同一旧文档 → 反向列表聚合（读旧文档知被谁订正的载体）", () => {
    const entries = [
      { rel: "docs/features/2026/11/02/a.md", id: "F20261102aaa1", from: ["F20261005imfg"] },
      { rel: "docs/features/2026/11/03/b.md", id: "F20261103bbb2", from: ["F20261005imfg", "F20261020drft"] },
      { rel: "docs/features/2026/10/05/old.md", id: "F20261005imfg", from: [] },
      { rel: "docs/features/2026/10/20/second-old.md", id: "F20261020drft", from: [] },
    ];
    const reverse = computeReverseIndex(entries);
    expect(reverse.get("F20261005imfg")).toEqual(["F20261102aaa1", "F20261103bbb2"]);
    expect(reverse.get("F20261020drft")).toEqual(["F20261103bbb2"]);
  });

  it("断链目标不入索引（由 findBrokenBacklinks 报）", () => {
    const entries = [
      { rel: "docs/features/2026/11/02/a.md", id: "F20261102aaa1", from: ["F20260101xxxx"] },
    ];
    expect(computeReverseIndex(entries).size).toBe(0);
  });

  it("无 from 文档 → 索引为空（零成本）", () => {
    const entries = [{ rel: "docs/a.md", id: "F20261102aaaa", from: [] }];
    expect(computeReverseIndex(entries).size).toBe(0);
  });
});
