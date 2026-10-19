/**
 * 和牌总评端到端：非法输入分支（非三麻牌/张数错/非和形/无役）、
 * 分解×役×符×宝牌×点数贯通、高点法、选项（切上满贯/累计役满）、
 * 拔北与手牌张数关系、役满点数与宝牌无关。
 */
import { describe, expect, it } from "vitest";
import { parseTiles } from "../../../src/entities/mahjong/tile";
import { evaluateWin } from "../../../src/usecases/mahjong/referee/win";
import { winEval, yakuIds } from "./helpers";

const t = (s: string) => parseTiles(s);

describe("非法输入分支", () => {
  it("门清含 2~8 万 → TILE_NOT_SANMA", () => {
    const bad = { suit: "m" as const, rank: 5, aka: false };
    const r = evaluateWin({
      concealed: [bad, ...t("111m456p789p123s4z")],
      melds: [],
      winTile: bad,
      tsumo: false,
      seatWind: "south",
      roundWind: "east",
      doraIndicators: [],
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("TILE_NOT_SANMA");
  });

  it("副露含移除牌 → TILE_NOT_SANMA", () => {
    const bad = { suit: "m" as const, rank: 3, aka: false };
    const r = evaluateWin({
      concealed: t("456p789p123s44z"),
      melds: [{ type: "pon", tiles: [bad, bad, bad], from: "toimen" }],
      winTile: t("4z")[0],
      tsumo: false,
      seatWind: "south",
      roundWind: "east",
      doraIndicators: [],
    });
    expect(r.reason).toBe("TILE_NOT_SANMA");
  });

  it("13 张（差一张）→ BAD_HAND_SIZE", () => {
    const r = winEval("111m456p789p123s4z", "4z");
    expect(r.reason).toBe("BAD_HAND_SIZE");
  });

  it("15 张 → BAD_HAND_SIZE", () => {
    const r = winEval("111m456p789p123s44z5z", "4z");
    expect(r.reason).toBe("BAD_HAND_SIZE");
  });

  it("和了张不在门清手牌中 → BAD_HAND_SIZE", () => {
    const r = evaluateWin({
      concealed: t("111m456p789p123s44z"),
      melds: [],
      winTile: t("9s")[0], // 手牌无 9s
      tsumo: false,
      seatWind: "south",
      roundWind: "east",
      doraIndicators: [],
    });
    expect(r.reason).toBe("BAD_HAND_SIZE");
  });

  it("14 张但非和了形 → NOT_WINNING", () => {
    const r = winEval("111m234p567p89s5s11z", "1z");
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("NOT_WINNING");
  });

  it("和了形但无役（含宝牌）→ NO_YAKU", () => {
    const r = winEval("111m456p789p123s44z", "4z", { doraIndicators: t("3z") });
    expect(r.reason).toBe("NO_YAKU");
    expect(r.dora.dora).toBe(2);
    expect(r.totalHan).toBe(2); // 番数算了，但无役不成立
    expect(r.points).toBeUndefined();
  });

  it("副露时立直标志不产生役 → NO_YAKU", () => {
    const r = winEval("456p789p123s44z", "4z", {
      riichi: true,
      melds: [{ type: "pon", tiles: t("111m"), from: "toimen" }],
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("NO_YAKU");
    expect(yakuIds(r)).toEqual([]);
  });
});

describe("总评贯通（分解 × 役 × 符 × 宝牌 × 点数）", () => {
  it("立直荣和：字段全链一致", () => {
    const r = winEval("111m456p789p123s44z", "4z", {
      riichi: true,
      doraIndicators: t("3z"),
    });
    expect(r.valid).toBe(true);
    expect(r.yakuHan).toBe(1);
    expect(r.dora.dora).toBe(2);
    expect(r.totalHan).toBe(3);
    expect(r.fu).toBe(40); // 单骑+2 暗刻1m+8 门清+10 → 40
    expect(r.points?.level).toBe("normal");
    expect(r.points?.ron).toBe(5200); // 3翻40符 = 5200（oracle 表：a=1280×4）
    expect(r.pattern?.kind).toBe("regular");
  });

  it("立直 + 表宝 + 里宝：totalHan = yakuHan + dora.total", () => {
    const r = winEval("111m456p789p123s44z", "4z", {
      riichi: true,
      doraIndicators: t("3z"),
      uraIndicators: t("3z"),
    });
    expect(r.dora.dora).toBe(2);
    expect(r.dora.ura).toBe(2);
    expect(r.totalHan).toBe(5); // 1 + 2 + 2
    expect(r.points?.ron).toBe(8000); // 5翻 → 满贯
  });

  it("非立直时里指示牌不计入", () => {
    const r = winEval("111m456p789p123s44z", "4z", {
      doraIndicators: t("3z"),
      uraIndicators: t("3z"),
    });
    expect(r.dora.ura).toBe(0);
    expect(r.totalHan).toBe(2);
  });

  it("拔北计入宝牌：dora.kita 与 totalHan", () => {
    const r = winEval("111m456p789p123s44z", "4z", { riichi: true, kitaCount: 2 });
    expect(r.dora.kita).toBe(2);
    expect(r.totalHan).toBe(3); // 立直 1 + 拔北 2
  });

  it("拔北副露不改变期望手牌张数（拔北不占面子）", () => {
    const withKita = winEval("111m456p789p123s44z", "4z", {
      riichi: true,
      melds: [{ type: "kita", tiles: t("4z") }],
    });
    expect(withKita.valid).toBe(true); // 仍按 14 张门清算
    const tooFew = winEval("111m456p789p123s4z", "4z", {
      riichi: true,
      melds: [{ type: "kita", tiles: t("4z") }],
    });
    expect(tooFew.reason).toBe("BAD_HAND_SIZE");
  });

  it("暗杠 + 拔北保持门清：立直成立", () => {
    const r = winEval("456p789p123s44z", "4z", {
      riichi: true,
      melds: [
        { type: "ankan", tiles: t("1111m") },
        { type: "kita", tiles: t("4z") },
      ],
    });
    expect(r.valid).toBe(true);
    expect(yakuIds(r)).toContain("riichi");
    expect(r.fu).toBe(70); // 20+32+2+10 = 64 → 70
  });

  it("自摸点数字段贯通：1翻40符 子自摸每家 500", () => {
    const r = winEval("111m456p789p123s44z", "4z", { tsumo: true });
    expect(r.fu).toBe(40); // 20+8+2(单骑)+2(自摸) = 32 → 40
    expect(r.yakuHan).toBe(1);
    expect(r.points?.tsumoEachSanma).toBe(500); // 1.5×320 = 480 → 500
    expect(r.points?.tsumoChildPays).toBe(400);
    expect(r.points?.tsumoParentPays).toBe(700);
  });

  it("七对子通道贯通：pattern.kind + 25 符 + 1600", () => {
    const r = winEval("1122p3344s5566z77z", "7z");
    expect(r.pattern?.kind).toBe("chiitoi");
    expect(r.fu).toBe(25);
    expect(r.points?.ron).toBe(1600);
  });

  it("国士通道贯通：役满切替普通役 + 点数不受宝牌影响", () => {
    const r = winEval("1m9m1p9p1s9s11234567z", "7z", { doraIndicators: t("6z") });
    expect(r.pattern?.kind).toBe("kokushi");
    expect(r.dora.dora).toBe(1); // 6z → 7z，手牌有 7z
    expect(r.yakus.every((y) => y.id === "kokushi")).toBe(true);
    expect(r.points?.yakumanCount).toBe(1);
    expect(r.points?.ron).toBe(32000); // 宝牌不叠加进役满点数
  });
});

describe("选项贯通（ScoreOptions）", () => {
  it("切上满贯关（雀魂默认）：4翻30符 → 7700；开 → 8000", () => {
    const off = winEval("123p456p789s23s4s44z", "4s", {
      riichi: true,
      ippatsu: true,
      doraIndicators: t("3s"),
    });
    expect(off.totalHan).toBe(4); // 立直+一发+平和 + 4s 宝牌 1
    expect(off.fu).toBe(30);
    expect(off.points?.level).toBe("normal");
    expect(off.points?.ron).toBe(7700);

    const on = winEval("123p456p789s23s4s44z", "4s", {
      riichi: true,
      ippatsu: true,
      doraIndicators: t("3s"),
      options: { kiriageMangan: true },
    });
    expect(on.points?.level).toBe("mangan");
    expect(on.points?.ron).toBe(8000);
  });

  it("累计役满开（雀魂默认）：13 番 → 32000；关 → 三倍满 24000", () => {
    const base = {
      hand: "111s456s789s123s55s",
      win: "5s",
      riichi: true,
      ippatsu: true,
      doraIndicators: t("1s2s3s"),
    };
    const kazoe = winEval(base.hand, base.win, base);
    expect(kazoe.totalHan).toBe(13); // 立直1+一发1+一气2+清一色6 + 宝牌3
    expect(kazoe.points?.yakumanCount).toBe(1);
    expect(kazoe.points?.ron).toBe(32000);

    const capped = winEval(base.hand, base.win, { ...base, options: { kazoeYakuman: false } });
    expect(capped.points?.level).toBe("sanbaiman");
    expect(capped.points?.yakumanCount).toBe(0);
    expect(capped.points?.ron).toBe(24000);
  });
});
