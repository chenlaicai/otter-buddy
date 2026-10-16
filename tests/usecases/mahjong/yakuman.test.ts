/**
 * L2 役满逐役 + 叠加/切替口径。
 * 关键案例经 oracle 对拍：国士/十三面、大三元+字一色、大四喜+字一色+四暗刻(=4倍)、清老头+四暗刻单骑(=3倍)。
 */
import { describe, expect, it } from "vitest";
import { parseTiles } from "../../../src/entities/mahjong/tile";
import { winEval, expectYakus, yakuIds } from "./helpers";

describe("逐役：役满", () => {
  it("国士无双 kokushi=1倍 32000", () => {
    const r = winEval("1m9m1p9p1s9s11234567z", "1m");
    expectYakus(r, ["kokushi"]);
    expect(r.points?.yakumanCount).toBe(1);
    expect(r.points?.ron).toBe(32000);
    expect(r.fu).toBe(30); // 国士 30 符（oracle）
  });

  it("国士十三面 kokushi13=2倍 64000（oracle 实测）", () => {
    const r = winEval("1m9m1p9p1s9s9s1234567z", "9s");
    expectYakus(r, ["kokushi13"]);
    expect(r.points?.yakumanCount).toBe(2);
    expect(r.points?.ron).toBe(64000);
  });

  it("四暗刻（自摸双碰完成）suuankou=1倍，切替掉对对/三暗刻", () => {
    const r = winEval("111m999m111p999p55z", "9p", { tsumo: true });
    expectYakus(r, ["suuankou"]);
    expect(r.points?.ron).toBe(32000);
    expect(r.fu).toBe(60); // oracle 同构 hu60
  });

  it("四暗刻单骑 suuankouTanki=2倍 64000", () => {
    const r = winEval("111m999m111p999p55z", "5z");
    expectYakus(r, ["suuankouTanki"]);
    expect(r.points?.yakumanCount).toBe(2);
    expect(r.points?.ron).toBe(64000);
  });

  it("双碰荣和不断四暗刻成立（ron shanpon 明刻化→非四暗刻），大三元不受影响", () => {
    const r = winEval("111m555z666z777z99m", "1m");
    expectYakus(r, ["daisangen"]);
    expect(yakuIds(r)).not.toContain("suuankou");
    expect(r.points?.ron).toBe(32000);
  });

  it("大三元 daisangen=1倍（oracle：与字一色叠加）", () => {
    const r = winEval("555z666z777z111z44z", "1z", { tsumo: true });
    expect(yakuIds(r)).toContain("daisangen");
    expect(yakuIds(r)).toContain("tsuuiisou");
    expect(yakuIds(r)).toContain("suuankou");
    // oracle han=39 → 3 倍叠加（32000×3 = 96000 子自摸 24000/48000）
    expect(r.points?.yakumanCount).toBe(3);
    expect(r.points?.tsumoChildPays).toBe(24000);
    expect(r.points?.tsumoParentPays).toBe(48000);
  });

  it("小四喜 shousuushii=1倍（三风刻+风对）", () => {
    const r = winEval("111z222z333z999m44z", "9m");
    expectYakus(r, ["shousuushii"]);
    expect(r.points?.yakumanCount).toBe(1);
  });

  it("大四喜+字一色+四暗刻 = 4 倍（oracle han=52 → 128000）", () => {
    const r = winEval("111z222z333z444z55z", "4z", { tsumo: true });
    expect(yakuIds(r)).toContain("daisuushii");
    expect(yakuIds(r)).toContain("tsuuiisou");
    expect(yakuIds(r)).toContain("suuankou");
    expect(r.points?.yakumanCount).toBe(4);
    expect(r.points?.tsumoChildPays).toBe(32000); // oracle 实测 4p 子自摸每家 32000
    expect(r.points?.tsumoParentPays).toBe(64000);
  });

  it("字一色 tsuuiisou=1倍（双碰荣和不断四暗刻 → 单倍）", () => {
    const r = winEval("111z222z555z666z33z", "6z");
    expectYakus(r, ["tsuuiisou"]);
    expect(r.points?.yakumanCount).toBe(1);
  });

  it("清老头+四暗刻单骑 = 3 倍（oracle han=39 → 96000）", () => {
    const r = winEval("111m999m111p999p11s", "1s");
    expect(yakuIds(r)).toContain("chinroutou");
    expect(yakuIds(r)).toContain("suuankouTanki");
    expect(r.points?.yakumanCount).toBe(3);
    expect(r.points?.ron).toBe(96000);
  });

  it("绿一色 ryuuiisou=1倍（双碰荣和）", () => {
    const r = winEval("222s333s444s666s88s", "6s");
    expectYakus(r, ["ryuuiisou"]);
    expect(r.points?.yakumanCount).toBe(1);
  });

  it("九莲宝灯 chuuren=1倍", () => {
    const r = winEval("11122345678999p", "1p");
    expectYakus(r, ["chuuren"]);
    expect(r.points?.ron).toBe(32000);
  });

  it("纯正九莲 chuurenPure=2倍（和了前恰 1112345678999）", () => {
    const r = winEval("11123456789995p", "5p");
    expectYakus(r, ["chuurenPure"]);
    expect(r.points?.yakumanCount).toBe(2);
    expect(r.points?.ron).toBe(64000);
  });

  it("四杠子 suukantsu=1倍（切替掉三杠子等）", () => {
    const r = winEval("33z", "3z", {
      melds: [
        { type: "ankan", tiles: parseTiles("1111m") },
        { type: "ankan", tiles: parseTiles("9999p") },
        { type: "ankan", tiles: parseTiles("1111s") },
        { type: "daiminkan", tiles: parseTiles("5555z"), from: "toimen" },
      ],
    });
    expectYakus(r, ["suukantsu"]);
    expect(r.points?.yakumanCount).toBe(1);
  });
});

describe("役满切替（存在役满 → 普通役不计）", () => {
  it("国士手不带立直以外的普通役切替展示（riichi 标志不计入普通役显示）", () => {
    const r = winEval("1m9m1p9p1s9s11234567z", "1m", { riichi: true });
    // 役满优先：普通役（立直）不计
    expectYakus(r, ["kokushi"]);
    expect(r.yakuHan).toBe(1); // 仅役满倍数
    expect(r.totalHan).toBe(1); // 宝牌不叠加
  });

  it("双倍役满叠加普通役封顶：宝牌不影响役满点数", () => {
    const r = winEval("111m999m111p999p55z", "5z", {
      doraIndicators: parseTiles("1p1p"),
    });
    expect(yakuIds(r)).toEqual(["suuankouTanki"]);
    expect(r.points?.ron).toBe(64000);
    expect(r.totalHan).toBe(2 + (r.dora.total ?? 0)); // totalHan 含宝牌展示，点数不受影响
    expect(r.points?.yakumanCount).toBe(2);
  });
});
