/**
 * L1 牌与记谱层：三麻 108 张、2~8 万移除、赤五、记谱解析。
 */
import { describe, expect, it } from "vitest";
import {
  SANMA_KINDS,
  SANMA_TILE_TOTAL,
  buildSanmaWall,
  countsByKind,
  doraKindFromIndicator,
  formatTiles,
  isSanmaKind,
  isYaochuKind,
  kindToTile,
  parseTiles,
  sortTiles,
  tileKind,
} from "../../../src/entities/mahjong/tile";

describe("记谱解析", () => {
  it.each([
    ["19m", [0, 8]],
    ["123456789p", [9, 10, 11, 12, 13, 14, 15, 16, 17]],
    ["1s9s", [18, 26]],
    ["1234567z", [27, 28, 29, 30, 31, 32, 33]],
  ])("解析 %s", (notation, kinds) => {
    expect(parseTiles(notation as string).map(tileKind)).toEqual(kinds);
  });

  it("拒收 2~8 万（三麻移除）", () => {
    expect(() => parseTiles("2m")).toThrow();
    expect(() => parseTiles("123m")).toThrow(); // 2m/3m 不在
    expect(() => parseTiles("8m")).toThrow();
  });

  it("仅收 1m/9m 万子", () => {
    expect(() => parseTiles("1m")).not.toThrow();
    expect(() => parseTiles("9m")).not.toThrow();
  });

  it("赤五：0p/0s 解析为赤五，0m 非法", () => {
    const tiles = parseTiles("05p");
    expect(tiles).toHaveLength(2);
    expect(tiles[0].aka).toBe(true);
    expect(tiles[1].aka).toBe(false);
    expect(() => parseTiles("0m")).toThrow();
    expect(() => parseTiles("0z")).toThrow();
  });

  it("非法记谱抛错", () => {
    expect(() => parseTiles("12x")).toThrow();
    expect(() => parseTiles("abc")).toThrow();
    expect(() => parseTiles("123")).toThrow();
    expect(() => parseTiles("z12")).toThrow();
  });

  it("format 往返（赤五以 0 表示）", () => {
    const tiles = parseTiles("05p123s"); // 5 张：赤5p+5p+123s
    const text = formatTiles(tiles);
    expect(text).toBe("50p123s");
    expect(parseTiles(text)).toHaveLength(5);
  });

  it("排序按种类稳定", () => {
    const tiles = parseTiles("5s1m9p2p");
    const sorted = sortTiles(tiles);
    expect(sorted.map(tileKind)).toEqual([0, 10, 17, 22]);
  });
});

describe("种类索引", () => {
  it.each([0, 8, 9, 17, 18, 26, 27, 33])("kind %i 往返", (k) => {
    expect(tileKind(kindToTile(k))).toBe(k);
  });

  it("三麻种类：27 种（1/9 万 + 筒索全 + 字全）", () => {
    expect(SANMA_KINDS).toHaveLength(27);
    expect(isSanmaKind(0)).toBe(true); // 1m
    expect(isSanmaKind(1)).toBe(false); // 2m 移除
    expect(isSanmaKind(7)).toBe(false); // 8m 移除
    expect(isSanmaKind(8)).toBe(true); // 9m
    expect(isSanmaKind(9)).toBe(true); // 1p
    expect(isSanmaKind(17)).toBe(true); // 9p
    expect(isSanmaKind(26)).toBe(true); // 9s
    expect(isSanmaKind(33)).toBe(true); // 中
    expect(isSanmaKind(34)).toBe(false);
  });

  it("幺九字判定", () => {
    expect(isYaochuKind(0)).toBe(true); // 1m
    expect(isYaochuKind(8)).toBe(true); // 9m
    expect(isYaochuKind(9)).toBe(true); // 1p
    expect(isYaochuKind(13)).toBe(false); // 5p
    expect(isYaochuKind(27)).toBe(true); // 东
    expect(isYaochuKind(33)).toBe(true); // 中
  });
});

describe("108 张牌山", () => {
  const wall = buildSanmaWall();

  it("总数 108", () => {
    expect(wall).toHaveLength(SANMA_TILE_TOTAL);
    expect(SANMA_TILE_TOTAL).toBe(108);
  });

  it("每种类 4 张", () => {
    const counts = countsByKind(wall);
    for (const k of SANMA_KINDS) expect(counts[k]).toBe(4);
    // 移除的 2~8 万为 0
    for (let k = 1; k <= 7; k++) expect(counts[k]).toBe(0);
  });

  it("赤五恰 2 张（5p/5s 各一）", () => {
    const akas = wall.filter((t) => t.aka);
    expect(akas).toHaveLength(2);
    expect(akas.every((t) => t.rank === 5 && (t.suit === "p" || t.suit === "s"))).toBe(true);
  });

  it("字牌 28 张 / 筒 36 / 索 36 / 万 8", () => {
    const counts = countsByKind(wall);
    const sum = (from: number, to: number) => {
      let s = 0;
      for (let k = from; k <= to; k++) s += counts[k];
      return s;
    };
    expect(sum(0, 8)).toBe(8);
    expect(sum(9, 17)).toBe(36);
    expect(sum(18, 26)).toBe(36);
    expect(sum(27, 33)).toBe(28);
  });
});

describe("宝牌指示（按种类断言：1万指示的万子宝牌落到已移除的 2 万=恒 0 张，待引擎层对雀魂核实）", () => {
  const k = (notation: string) => tileKind(parseTiles(notation)[0]);
  it.each([
    ["1m", 1], // 2m（已移除）
    ["9m", 0], // 1m（回转；2~8 万不存在，1 万指示的万子宝牌为恒 0 张口径）
    ["8p", 17], // 9p
    ["9p", 9], // 1p（回转）
    ["9s", 18], // 1s（回转）
    ["1p", 10], // 2p
    ["1z", 28], // 2z
    ["7z", 27], // 1z（回转）
    ["4z", 31], // 北指示 → 白
  ])("指示 %s → 宝牌种类 %i", (ind, dora) => {
    expect(doraKindFromIndicator(k(ind as string))).toBe(dora);
  });
});
