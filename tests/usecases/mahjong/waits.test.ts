/**
 * 听牌形（waits）：三型出口与副露情形。期望 = oracle advance 实测。
 */
import { describe, expect, it } from "vitest";
import { parseTiles, tileKind } from "../../../src/entities/mahjong/tile";
import { waits } from "../../../src/usecases/mahjong/referee/decompose";

const W = (notation: string, melds: Parameters<typeof waits>[1] = []) =>
  waits(parseTiles(notation), melds).sort((a, b) => a - b);

const kinds = (notation: string) => parseTiles(notation).map(tileKind).sort((a, b) => a - b);

describe("听牌张枚举", () => {
  it("边张听 12s → [3s]（oracle advance）", () => {
    expect(W("111m456p789p12s44z")).toEqual(kinds("3s"));
  });

  it("单骑听 4z → [4z]（oracle）", () => {
    expect(W("111m123p456p789p4z")).toEqual(kinds("4z"));
  });

  it("多面复合：1122334455667p → [7p,4p,1p]（oracle advance）", () => {
    expect(W("1122334455667p")).toEqual(kinds("7p4p1p").sort((a, b) => a - b));
  });

  it("嵌张听 46s → [5s]", () => {
    expect(W("111m456p789p46s55z")).toEqual(kinds("5s"));
  });

  it("边张听 12s → [3s]", () => {
    expect(W("123p456p789p12s44z")).toEqual(kinds("3s"));
  });

  it("国士 12 种含对 → 仅缺的 7z（oracle advance）", () => {
    expect(W("1m9m1p9p1s9s1123456z")).toEqual(kinds("7z"));
  });

  it("国士 13 面听：13 种无对 → 全部 13 种", () => {
    const w = W("1m9m1p9p1s9s1234567z");
    expect(w).toHaveLength(13);
  });

  it("七对听牌：6 对 + 单张 → [该单张]", () => {
    expect(W("1122334455667p")).toEqual(expect.arrayContaining(kinds("7p4p1p")));
  });

  it("副露 1 面子的听牌（门清 10 张 + 碰：待 3s）", () => {
    expect(W("456p789p12s44z", [{ type: "pon", tiles: parseTiles("111m"), from: "toimen" }])).toEqual(kinds("3s"));
  });

  it("所有听牌均为三麻合法种类（1m/9m/筒/索/字，不含 2~8 万）", () => {
    const legal = (k: number) => k === 0 || k === 8 || (k >= 9 && k <= 33);
    for (const h of ["111m456p789p12s44z", "1122334455667p", "1m9m1p9p1s9s1234567z"]) {
      for (const k of W(h)) expect(legal(k)).toBe(true);
    }
  });
});
