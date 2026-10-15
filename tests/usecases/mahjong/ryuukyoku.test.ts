/**
 * 流局判定：三风连打（三麻三家同风）/ 四杠散了 / 九种九牌（庄家首巡）/
 * 流局满贯（恰一家听牌 +4000）/ 荒牌流局听牌分配（3000 交换）。
 */
import { describe, expect, it } from "vitest";
import { parseTiles } from "../../../src/entities/mahjong/tile";
import { detectAbortiveDraw, notenSettlement } from "../../../src/usecases/mahjong/referee/ryuukyoku";

const t = (s: string) => parseTiles(s);

describe("三风连打（三家第一打同风）", () => {
  it("三家第一打皆东 → threeWinds", () => {
    const r = detectAbortiveDraw({ firstDiscards: t("1z1z1z"), firstDiscardsComplete: true, totalKans: 0 });
    expect(r.kind).toBe("threeWinds");
  });

  it("三家第一打皆北（三麻含北风）→ threeWinds", () => {
    const r = detectAbortiveDraw({ firstDiscards: t("4z4z4z"), firstDiscardsComplete: true, totalKans: 0 });
    expect(r.kind).toBe("threeWinds");
  });

  it("同花色数牌（非风）→ 不成立", () => {
    const r = detectAbortiveDraw({ firstDiscards: t("1p1p1p"), firstDiscardsComplete: true, totalKans: 0 });
    expect(r.kind).toBe(null);
  });

  it("风牌但不同种（东南西）→ 不成立", () => {
    const r = detectAbortiveDraw({ firstDiscards: t("1z2z3z"), firstDiscardsComplete: true, totalKans: 0 });
    expect(r.kind).toBe(null);
  });

  it("同风但第一巡未打完 → 不成立", () => {
    const r = detectAbortiveDraw({ firstDiscards: t("1z1z1z"), firstDiscardsComplete: false, totalKans: 0 });
    expect(r.kind).toBe(null);
  });

  it("优先级：三风连打先于四杠散了", () => {
    const r = detectAbortiveDraw({ firstDiscards: t("2z2z2z"), firstDiscardsComplete: true, totalKans: 4 });
    expect(r.kind).toBe("threeWinds");
  });
});

describe("四杠散了", () => {
  it("全场 4 杠且无人岭上和了 → fourKans", () => {
    expect(detectAbortiveDraw({ totalKans: 4 }).kind).toBe("fourKans");
    expect(detectAbortiveDraw({ totalKans: 5 }).kind).toBe("fourKans");
  });

  it("仅 3 杠 → 不成立", () => {
    expect(detectAbortiveDraw({ totalKans: 3 }).kind).toBe(null);
  });

  it("第 4 杠有人岭上和了（fourthKanResolved=false）→ 和了优先，不流局", () => {
    expect(detectAbortiveDraw({ totalKans: 4, fourthKanResolved: false }).kind).toBe(null);
  });

  it("第 4 杠无人和了（fourthKanResolved=true）→ 四杠散了", () => {
    expect(detectAbortiveDraw({ totalKans: 4, fourthKanResolved: true }).kind).toBe("fourKans");
  });
});

describe("九种九牌（庄家配牌+第一摸，14 张）", () => {
  it("13 种幺九字（≥9）→ 可选择流局", () => {
    const r = detectAbortiveDraw({ dealerFirstDrawTiles: t("1m9m1p9p1s9s11234567z"), totalKans: 0 });
    expect(r.kind).toBe("nineTerminals");
    expect(r.nineTerminalsAvailable).toBe(true);
  });

  it("恰 9 种 → 边界成立", () => {
    const r = detectAbortiveDraw({ dealerFirstDrawTiles: t("1m9m1p9p1s9s1z2z3z123p45p"), totalKans: 0 });
    expect(r.kind).toBe("nineTerminals");
  });

  it("仅 8 种 → 不成立", () => {
    const r = detectAbortiveDraw({ dealerFirstDrawTiles: t("1m9m1p9p1s9s1z2z345p56p7p"), totalKans: 0 });
    expect(r.kind).toBe(null);
  });

  it("非 14 张（非首巡/非庄家视角）→ 忽略", () => {
    const r = detectAbortiveDraw({ dealerFirstDrawTiles: t("1m9m1p9p1s9s11234567z").slice(0, 13), totalKans: 0 });
    expect(r.kind).toBe(null);
  });
});

describe("荒牌流局点数交换（三麻）", () => {
  it("恰一家听牌 → 流局满贯：+4000 / 两家各 −2000", () => {
    const s = notenSettlement({ tenpai: [true, false, false] });
    expect(s.tenpaiCount).toBe(1);
    expect(s.manganDraw).toBe(true);
    expect(s.deltas).toEqual([4000, -2000, -2000]);
  });

  it("流局满贯在第 3 家听牌时同样成立", () => {
    const s = notenSettlement({ tenpai: [false, false, true] });
    expect(s.manganDraw).toBe(true);
    expect(s.deltas).toEqual([-2000, -2000, 4000]);
  });

  it("两家听牌 → 未听者付 3000：+1500×2 / −3000", () => {
    const s = notenSettlement({ tenpai: [true, true, false] });
    expect(s.tenpaiCount).toBe(2);
    expect(s.manganDraw).toBe(false);
    expect(s.deltas).toEqual([1500, 1500, -3000]);
  });

  it("两家听牌（听牌者为 0/2 位）→ 分配随索引", () => {
    const s = notenSettlement({ tenpai: [false, true, true] });
    expect(s.deltas).toEqual([-3000, 1500, 1500]);
  });

  it("三家全听 → 无点数交换", () => {
    const s = notenSettlement({ tenpai: [true, true, true] });
    expect(s.tenpaiCount).toBe(3);
    expect(s.manganDraw).toBe(false);
    expect(s.deltas).toEqual([0, 0, 0]);
  });

  it("三家全不听 → 无点数交换", () => {
    const s = notenSettlement({ tenpai: [false, false, false] });
    expect(s.tenpaiCount).toBe(0);
    expect(s.manganDraw).toBe(false);
    expect(s.deltas).toEqual([0, 0, 0]);
  });

  it("点数增减恒守恒（合计 0）", () => {
    for (const tenpai of [[true, false, false], [true, true, false], [true, true, true], [false, false, false]]) {
      const s = notenSettlement({ tenpai });
      expect(s.deltas.reduce((a, b) => a + b, 0)).toBe(0);
    }
  });

  it("非三家输入 → 抛错", () => {
    expect(() => notenSettlement({ tenpai: [true, false] })).toThrow();
  });
});
