/**
 * L2 普通役逐役清单（三麻可成立役种全集，无吃/无三色同顺）。
 * 关键口径已经 mahjong-utils hora oracle 对拍：役牌需刻子、全带需含顺子、
 * 二盃口不含一盃口、双碰荣和 −2 符。
 */
import { describe, expect, it } from "vitest";
import { parseTiles } from "../../../src/entities/mahjong/tile";
import { winEval, expectYakus, yakuIds } from "./helpers";

describe("逐役：基本役", () => {
  it("立直 riichi=1", () => {
    const r = winEval("111m456p789p123s44z", "4z", { riichi: true });
    expectYakus(r, ["riichi"]);
    expect(r.yakus[0].value).toBe(1);
    expect(r.fu).toBe(40); // 单骑+2 门清+10 → 32→40
    expect(r.points?.ron).toBe(1300); // 1翻40符
  });

  it("一发 ippatsu=1", () => {
    const r = winEval("111m456p789p123s44z", "4z", { riichi: true, ippatsu: true });
    expectYakus(r, ["riichi", "ippatsu"]);
    expect(r.yakuHan).toBe(2);
  });

  it("门前清自摸和 menzenTsumo=1", () => {
    const r = winEval("111m456p789p123s44z", "4z", { tsumo: true });
    expectYakus(r, ["menzenTsumo"]);
  });

  it("平和 pinfu=1、符 30（ron）/20（tsumo，oracle 口径）", () => {
    const ron = winEval("123p456p789s23s4s44z", "4s");
    expectYakus(ron, ["pinfu"]);
    expect(ron.fu).toBe(30);
    expect(ron.points?.ron).toBe(1000); // 1翻30符（oracle）

    const tsumo = winEval("123p456p789s23s4s44z", "4s", { tsumo: true });
    expectYakus(tsumo, ["menzenTsumo", "pinfu"]);
    expect(tsumo.fu).toBe(20); // 平和自摸保持 20 符（oracle）
    expect(tsumo.points?.tsumoChildPays).toBe(400);
    expect(tsumo.points?.tsumoParentPays).toBe(700);
    // 三麻自摸：每家 1.5×a = 480 → 500（自摸损：1000 < 荣和1300）
    expect(tsumo.points?.tsumoEachSanma).toBe(500);
    expect(tsumo.points!.tsumoEachSanma * 2).toBeLessThan(tsumo.points!.ron);
  });

  it("断幺九 tanyao=1（门清；全中张筒索）", () => {
    const r = winEval("234p456p567p234s55s", "5s");
    expectYakus(r, ["tanyao"]);
  });

  it("食断 kuitan=1（副露断幺成立——雀魂口径）", () => {
    const r = winEval("234p456p234s55s", "5s", {
      melds: [{ type: "pon", tiles: parseTiles("555p"), from: "toimen" }],
    });
    expectYakus(r, ["tanyao"]);
    expect(r.yakus[0].value).toBe(1);
    expect(r.fu).toBe(30); // 副露最低 30（oracle）
  });

  it("一盃口 iipeikou=1", () => {
    const r = winEval("111m456p456p789s55z", "5z");
    expectYakus(r, ["iipeikou"]);
  });

  it("海底摸月 haitei=1", () => {
    const r = winEval("111m456p789p123s44z", "4z", { tsumo: true, haitei: true });
    expectYakus(r, ["menzenTsumo", "haitei"]);
  });

  it("河底捞鱼 houtei=1", () => {
    const r = winEval("111m456p789p123s44z", "4z", { houtei: true });
    expectYakus(r, ["houtei"]);
  });

  it("岭上开花 rinshan=1（副露含杠）", () => {
    const r = winEval("456p789p123s44z", "4z", {
      melds: [{ type: "ankan", tiles: parseTiles("1111m") }],
      tsumo: true,
      rinshan: true,
    });
    expectYakus(r, ["menzenTsumo", "rinshan"]);
  });

  it("抢杠 chankan=1", () => {
    const r = winEval("456p789p123s44z", "4z", {
      melds: [{ type: "pon", tiles: parseTiles("111m"), from: "toimen" }],
      chankan: true,
    });
    expectYakus(r, ["chankan"]);
  });
});

describe("逐役：役牌（刻子成立——oracle 验证雀头不算）", () => {
  it("场风牌 roundWind=1（东场东刻）", () => {
    const r = winEval("111z456p789p123s55z", "5z", { roundWind: "east" });
    expectYakus(r, ["roundWind"]);
    expect(r.fu).toBe(50); // 暗刻幺九+8 单骑+2 白对+2 门清+10 → 42→50（oracle 同结构 hu50）
    expect(r.points?.ron).toBe(1600);
  });

  it("自风牌 seatWind=1（西自风刻）", () => {
    const r = winEval("333z456p789p123s55z", "5z", { seatWind: "west" });
    expectYakus(r, ["seatWind"]);
  });

  it("双东：场风+自风各 1 翻（刻子双计）", () => {
    const r = winEval("111z456p789p123s55z", "5z", { seatWind: "east", roundWind: "east" });
    expectYakus(r, ["roundWind", "seatWind"]);
    expect(r.yakuHan).toBe(2);
  });

  it("场风雀头不给役（oracle：round wind pair → 无役）", () => {
    const r = winEval("123p456p789p123s11z", "1z", { roundWind: "east", riichi: true });
    expect(yakuIds(r)).not.toContain("roundWind");
    expect(yakuIds(r)).toContain("riichi");
  });

  it("白 haku=1", () => {
    const r = winEval("555z456p789p123s44z", "4z");
    expectYakus(r, ["haku"]);
  });

  it("发 hatsu=1", () => {
    const r = winEval("666z456p789p123s44z", "4z");
    expectYakus(r, ["hatsu"]);
  });

  it("中 chun=1", () => {
    const r = winEval("777z456p789p123s44z", "4z");
    expectYakus(r, ["chun"]);
  });
});

describe("逐役：2 番以上", () => {
  it("三色同刻 sanpeikou=2（仅 1/9 可成立）+ 复合（oracle 同构 hu70/16000）", () => {
    const r = winEval("111m999m111p111s55z", "1s");
    expectYakus(r, ["toitoi", "sanankou", "honroutou", "sanpeikou"]);
    expect(r.yakuHan).toBe(8);
    expect(r.fu).toBe(70);
    expect(r.points?.ron).toBe(16000); // oracle 同构实测
  });

  it("对对和 toitoi=2", () => {
    const r = winEval("111m444p777s111s55z", "1s");
    expectYakus(r, ["toitoi", "sanankou"]);
    expect(r.fu).toBe(60);
    expect(r.points?.ron).toBe(8000); // oracle 同构：4翻60符=満貫
  });

  it("三暗刻 sanankou=2（双碰荣和的和了刻子明刻化——oracle 验证 sananko 仍在）", () => {
    const r = winEval("111m444p777s456s55z", "4s");
    expectYakus(r, ["sanankou"]);
    expect(r.yakuHan).toBe(2);
  });

  it("一气通贯 ittsuu=2（筒子；万子三麻不可成立）", () => {
    const r = winEval("111m123p456p789p55z", "5z");
    expectYakus(r, ["ittsuu"]);
    expect(r.yakuHan).toBe(2);
    expect(r.fu).toBe(50); // oracle 同构实测 hu50
    expect(r.points?.ron).toBe(3200); // oracle 实测
  });

  it("混全带幺九 chanta=2（含顺子，oracle 验证无顺子不计）", () => {
    const r = winEval("111m999m789p789p55z", "5z");
    expectYakus(r, ["iipeikou", "chanta"]);
    expect(r.yakuHan).toBe(3);
    expect(r.fu).toBe(50);
    expect(r.points?.ron).toBe(6400); // oracle 实测
  });

  it("混老头 honroutou=2（无顺子不带全带——oracle 口径；双碰荣和断四暗刻）", () => {
    const r = winEval("111m999m999p111s55z", "1m");
    expectYakus(r, ["toitoi", "sanankou", "honroutou"]);
    expect(r.yakuHan).toBe(6);
    expect(r.fu).toBe(70); // 20+32(四暗刻−双碰2)+白对2+门清10 = 62→70
    expect(r.points?.ron).toBe(12000); // 6翻=跳満
  });

  it("七对子 chiitoitsu=2、符 25、点 1600", () => {
    const r = winEval("1122p3344s5566z77z", "7z");
    expectYakus(r, ["chiitoitsu"]);
    expect(r.fu).toBe(25);
    expect(r.points?.ron).toBe(1600);
  });

  it("小三元 shousangen=2 + 白/发役牌复合（标准叠加）", () => {
    const r = winEval("123p999p555z666z77z", "7z");
    expectYakus(r, ["shousangen", "haku", "hatsu", "sanankou", "chanta", "honitsu"]);
    expect(r.yakuHan).toBe(11);
    expect(r.fu).toBe(60);
    expect(r.points?.level).toBe("sanbaiman"); // 11翻 → 三倍满
    expect(r.points?.ron).toBe(24000);
  });

  it("三杠子 sankantsu=2", () => {
    const r = winEval("456p55z", "5z", {
      melds: [
        { type: "ankan", tiles: parseTiles("1111m") },
        { type: "ankan", tiles: parseTiles("9999p") },
        { type: "daiminkan", tiles: parseTiles("1111s"), from: "toimen" },
      ],
    });
    expectYakus(r, ["sankantsu"]);
    expect(r.fu).toBe(110); // 20+32(暗杠1m)+32(暗杠9p)+16(明杠1s)+单骑2+白对2 = 104→110
  });

  it("纯全带幺九 junchan=3（无字含顺子）", () => {
    const r = winEval("111m999m789p123s99s", "9s");
    expectYakus(r, ["junchan"]);
    expect(r.yakuHan).toBe(3);
    expect(r.fu).toBe(50);
    expect(r.points?.ron).toBe(6400);
  });

  it("二盃口 ryanpeikou=3 且不含一盃口（oracle：[Pinhu,Ryanpe,Chinitsu] han10 hu30 16000）", () => {
    const r = winEval("11223344556677p", "7p");
    expectYakus(r, ["pinfu", "ryanpeikou", "chinitsu"]);
    expect(r.yakuHan).toBe(10);
    expect(r.fu).toBe(30);
    expect(r.points?.ron).toBe(16000); // baiman
  });

  it("混一色 honitsu=3（门清）", () => {
    const r = winEval("111s456s789s123s55z", "5z");
    expect(yakuIds(r)).toContain("honitsu");
    expect(yakuIds(r)).toContain("ittsuu");
    expect(r.yakuHan).toBe(5);
    expect(r.points?.level).toBe("mangan"); // 5翻=満貫
  });

  it("清一色 chinitsu=6（门清）", () => {
    const r = winEval("111s456s789s123s55s", "5s");
    expect(yakuIds(r)).toContain("chinitsu");
    expect(yakuIds(r)).toContain("ittsuu");
    expect(r.yakuHan).toBe(8);
    expect(r.points?.level).toBe("baiman");
    expect(r.points?.ron).toBe(16000);
  });
});

describe("役种负例（三麻不可成立/不成立情形）", () => {
  it("无役和了 → NO_YAKU（含宝牌也不成立）", () => {
    const r = winEval("111m456p789p123s44z", "3s", {
      doraIndicators: parseTiles("4p"),
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("NO_YAKU");
    expect(r.dora.dora).toBe(1); // 5p 在手（456p）——有宝牌仍需役
    expect(r.totalHan).toBe(1);
  });

  it("三色同顺不可成立（万子无 2-8 → 结构不存在，筒索混合不触发）", () => {
    const r = winEval("123p456p789s123s55z", "5z", { riichi: true });
    expect(yakuIds(r)).not.toContain("sanpeikou");
    expect(yakuIds(r)).not.toContain("ittsuu"); // 跨花色不构成
  });

  it("全带幺九无顺子时不计（oracle：纯老头仅清老头/对对）", () => {
    const r = winEval("111m999m111p111s55z", "1s");
    expect(yakuIds(r)).not.toContain("chanta");
    expect(yakuIds(r)).not.toContain("junchan");
    expect(yakuIds(r)).toContain("honroutou");
  });

  it("副露平和不成立（门清限定；即便两面+全顺+非役雀头）", () => {
    const r = winEval("456p789p23s4s44z", "4s", {
      melds: [{ type: "pon", tiles: parseTiles("111m"), from: "toimen" }],
      houtei: true, // 提供合法役使其成立，避免空断言
    });
    expect(yakuIds(r)).toContain("houtei");
    expect(yakuIds(r)).not.toContain("pinfu");
    expect(r.fu).toBe(30); // 副露最低 30（20 底 + 碰1m平4 → 24 → 30）
  });

  it("拔北不给役（kita dora 只计宝牌）", () => {
    const r = winEval("111m456p789p123s44z", "4z", { riichi: true, kitaCount: 3 });
    expect(yakuIds(r)).toEqual(["riichi"]);
    expect(r.dora.kita).toBe(3);
    expect(r.totalHan).toBe(4);
  });
});
