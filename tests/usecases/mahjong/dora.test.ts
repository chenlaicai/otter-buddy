/**
 * 宝牌计数：指示牌推进（含幺九字回转）、多指示牌、赤宝牌、里宝牌（仅立直）、
 * 拔北宝牌、副露面计入、总计。
 */
import { describe, expect, it } from "vitest";
import { parseTiles } from "../../../src/entities/mahjong/tile";
import { countDora } from "../../../src/usecases/mahjong/referee/dora";
import { winEval } from "./helpers";

const t = (s: string) => parseTiles(s);

describe("指示牌宝牌", () => {
  it("单指示：4p → 5p，手牌几张计几张", () => {
    const c = countDora({
      tiles: t("555p"),
      melds: [],
      doraIndicators: t("4p"),
      riichi: false,
      kitaCount: 0,
    });
    expect(c.dora).toBe(3);
  });

  it("幺九回转：9m → 1m、7z → 1z", () => {
    const m = countDora({ tiles: t("111m"), melds: [], doraIndicators: t("9m"), riichi: false, kitaCount: 0 });
    expect(m.dora).toBe(3);
    const z = countDora({ tiles: t("11z"), melds: [], doraIndicators: t("7z"), riichi: false, kitaCount: 0 });
    expect(z.dora).toBe(2);
  });

  it("多指示牌各自推进求和：4p + 8s → 5p 与 9s", () => {
    const c = countDora({
      tiles: t("55p99s"),
      melds: [],
      doraIndicators: t("4p8s"),
      riichi: false,
      kitaCount: 0,
    });
    expect(c.dora).toBe(4); // 5p×2 + 9s×2
  });

  it("1万指示的宝牌落到已移除的 2 万 = 恒 0 张（待引擎层对雀魂核实）", () => {
    const c = countDora({
      tiles: t("111m"),
      melds: [],
      doraIndicators: t("1m"),
      riichi: false,
      kitaCount: 0,
    });
    expect(c.dora).toBe(0);
  });

  it("无指示牌 → 0", () => {
    const c = countDora({ tiles: t("111m"), melds: [], doraIndicators: [], riichi: false, kitaCount: 0 });
    expect(c.dora).toBe(0);
    expect(c.total).toBe(0);
  });

  it("副露面子中的宝牌也计入", () => {
    const c = countDora({
      tiles: t("44z"),
      melds: [{ type: "pon", tiles: t("555s"), from: "toimen" }],
      doraIndicators: t("4s"),
      riichi: false,
      kitaCount: 0,
    });
    expect(c.dora).toBe(3);
  });
});

describe("赤宝牌", () => {
  it("赤五筒/赤五索各计 1：aka=2", () => {
    const c = countDora({
      tiles: t("05p05s"),
      melds: [],
      doraIndicators: [],
      riichi: false,
      kitaCount: 0,
    });
    expect(c.aka).toBe(2);
    expect(c.total).toBe(2);
  });

  it("赤五同时算普通宝牌（4p 指示 → 赤 5p 双计 dora+aka）", () => {
    const c = countDora({
      tiles: t("0p"),
      melds: [],
      doraIndicators: t("4p"),
      riichi: false,
      kitaCount: 0,
    });
    expect(c.dora).toBe(1);
    expect(c.aka).toBe(1);
    expect(c.total).toBe(2);
  });
});

describe("里宝牌（仅立直和了有效）", () => {
  it("立直 + 里指示：计入 ura", () => {
    const c = countDora({
      tiles: t("44z"),
      melds: [],
      doraIndicators: [],
      uraIndicators: t("3z"),
      riichi: true,
      kitaCount: 0,
    });
    expect(c.ura).toBe(2); // 3z → 4z
  });

  it("非立直：里指示牌被忽略", () => {
    const c = countDora({
      tiles: t("44z"),
      melds: [],
      doraIndicators: [],
      uraIndicators: t("3z"),
      riichi: false,
      kitaCount: 0,
    });
    expect(c.ura).toBe(0);
  });
});

describe("拔北宝牌", () => {
  it("kitaCount 原样计入且不算役", () => {
    const c = countDora({
      tiles: t("44z"),
      melds: [],
      doraIndicators: [],
      riichi: false,
      kitaCount: 3,
    });
    expect(c.kita).toBe(3);
    expect(c.total).toBe(3);
  });
});

describe("总计与和牌层贯通", () => {
  it("total = dora + aka + ura + kita", () => {
    const c = countDora({
      tiles: t("05p44z"),
      melds: [],
      doraIndicators: t("3z"),
      uraIndicators: t("3z"),
      riichi: true,
      kitaCount: 2,
    });
    expect(c.dora).toBe(2); // 4z×2
    expect(c.aka).toBe(1);
    expect(c.ura).toBe(2);
    expect(c.kita).toBe(2);
    expect(c.total).toBe(7);
  });

  it("winEval 贯通：立直 + 表 + 里 → totalHan = yakuHan + dora.total", () => {
    const r = winEval("111m456p789p123s44z", "4z", {
      riichi: true,
      doraIndicators: t("3z"),
      uraIndicators: t("3z"),
    });
    expect(r.valid).toBe(true);
    expect(r.dora.dora).toBe(2);
    expect(r.dora.ura).toBe(2);
    expect(r.totalHan).toBe(r.yakuHan + r.dora.total);
  });

  it("winEval 贯通：非立直时 ura 恒 0", () => {
    const r = winEval("111m456p789p123s44z", "4z", {
      doraIndicators: t("3z"),
      uraIndicators: t("3z"),
    });
    expect(r.dora.ura).toBe(0);
  });
});
