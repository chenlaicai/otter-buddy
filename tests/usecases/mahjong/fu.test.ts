/**
 * 符数表全枚举——组件级覆盖（20/25/30/40/50/60/70 + 切上）：
 * 听牌形（单骑/嵌张/边张/双碰/两面）、门清荣和 +10、非平和自摸 +2、
 * 暗刻（幺九 +8/中张 +4）、副露碰（+4/+2）、暗杠（+32/+16）、明杠/加杠（+16/+8）、
 * 雀头（自风/场风/连风 +4 可关/三元 +2）、副露最低 30、七对 25、国士 30。
 * 默认场风东、自风南（helpers.winEval）；雀头用 44z（北）避开风牌符。
 */
import { describe, expect, it } from "vitest";
import { parseTiles } from "../../../src/entities/mahjong/tile";
import { winEval } from "./helpers";

describe("符：底符与听牌形", () => {
  it("平和自摸 = 20 符（底符不动）", () => {
    const r = winEval("123p456p789s23s4s44z", "4s", { tsumo: true });
    expect(r.fu).toBe(20);
  });

  it("平和荣和 = 30 符（门清 +10）", () => {
    const r = winEval("123p456p789s23s4s44z", "4s");
    expect(r.fu).toBe(30);
  });

  it("两面荣和 +0：20+8(1m暗刻)+10 = 38 → 40（23s 听 1s/4s，和 4s）", () => {
    const r = winEval("111m456p789p23s44z4s", "4s", { riichi: true });
    expect(r.fu).toBe(40);
  });

  it("嵌张 +2：20+8+2+10 = 40（不切上）", () => {
    const r = winEval("111m456p789p13s2s44z", "2s", { riichi: true });
    expect(r.fu).toBe(40);
  });

  it("边张 +2：20+8+2+10 = 40", () => {
    const r = winEval("111m456p789p12s3s44z", "3s", { riichi: true });
    expect(r.fu).toBe(40);
  });

  it("单骑 +2：20+2+10 = 32 → 40", () => {
    const r = winEval("123p456p789s123s11s", "1s", { riichi: true });
    expect(r.fu).toBe(40);
  });

  it("双碰荣和 −2：20+8+8−2+10 = 44 → 50", () => {
    const r = winEval("111m456p789p111s55p", "1s", { riichi: true });
    expect(r.fu).toBe(50);
  });

  it("双碰自摸不 −2：20+8+8+2 = 38 → 40", () => {
    const r = winEval("111m456p789p111s55p", "1s", { tsumo: true });
    expect(r.fu).toBe(40);
  });
});

describe("符：暗刻与雀头", () => {
  it("中张暗刻 +4 / 幺九暗刻 +8：40 vs 50", () => {
    const simple = winEval("222s333s123p456p44z", "4z", { riichi: true });
    expect(simple.fu).toBe(40); // 20+4+4+10 = 38 → 40
    const yao = winEval("111m333s123p456p44z", "4z", { riichi: true });
    expect(yao.fu).toBe(50); // 20+8+4+10 = 42 → 50
  });

  it("连风雀头 +4（默认开）：42 → 50；关 = +2：40", () => {
    const on = winEval("111m222s333s123p11z", "1m", {
      tsumo: true,
      seatWind: "east",
      roundWind: "east",
    });
    expect(on.fu).toBe(50); // 20+8+4+4+2(tanki)+4(连风)+2(自摸) = 44? 按序 +2 自摸在后 = 42 → 50
    const off = winEval("111m222s333s123p11z", "1m", {
      tsumo: true,
      seatWind: "east",
      roundWind: "east",
      doubleWindPairFu: false,
    });
    expect(off.fu).toBe(40); // 40 整 → 不切上
  });

  it("自风雀头 +2（自风非场风）：42 → 50；对照北雀头 40", () => {
    const wind = winEval("111m222s333s123p33z", "3z", { tsumo: true, seatWind: "west" });
    expect(wind.fu).toBe(50);
    const control = winEval("111m222s333s123p44z", "4z", { tsumo: true, seatWind: "west" });
    expect(control.fu).toBe(40);
  });

  it("场风雀头 +2（自风非场风时）：42 → 50", () => {
    const r = winEval("111m222s333s123p11z", "1z", { tsumo: true, seatWind: "south" });
    expect(r.fu).toBe(50); // 20+8+4+4+2+2(场风雀头)+2(自摸) = 42 → 50
  });

  it("三元牌雀头 +2：42 → 50；对照北雀头 40", () => {
    const dragon = winEval("111m222s333s123p55z", "5z", { tsumo: true });
    expect(dragon.fu).toBe(50); // 白雀头 +2
    const control = winEval("111m222s333s123p44z", "4z", { tsumo: true });
    expect(control.fu).toBe(40);
  });
});

describe("符：副露", () => {
  it("碰幺九 +4 / 碰中张 +2：40 vs 30（副露自摸 haitei 提供役）", () => {
    const yao = winEval("222s123p456p44z", "4z", {
      tsumo: true,
      haitei: true,
      melds: [{ type: "pon", tiles: parseTiles("999s"), from: "toimen" }],
    });
    expect(yao.fu).toBe(40); // 20+4+4+2+2 = 32 → 40
    const simple = winEval("222s123p456p44z", "4z", {
      tsumo: true,
      haitei: true,
      melds: [{ type: "pon", tiles: parseTiles("555s"), from: "toimen" }],
    });
    expect(simple.fu).toBe(30); // 20+2+4+2+2 = 30 整
  });

  it("副露最低 30：20+2+2 = 24 → 30", () => {
    const r = winEval("234p456p234s55s", "5s", {
      houtei: true,
      melds: [{ type: "pon", tiles: parseTiles("222s"), from: "toimen" }],
    });
    expect(r.fu).toBe(30);
  });

  it("暗杠中张 +16：门清维持续 riichi（20+16+2+10 = 48 → 50）", () => {
    const r = winEval("123p456p789s44z", "4z", {
      riichi: true,
      melds: [{ type: "ankan", tiles: parseTiles("5555p") }],
    });
    expect(r.fu).toBe(50);
    expect(r.yakus.map((y) => y.id)).toContain("riichi"); // ankan 保持门清
  });

  it("暗杠幺九 +32：20+32+2+10 = 64 → 70", () => {
    const r = winEval("123p456p789s44z", "4z", {
      riichi: true,
      melds: [{ type: "ankan", tiles: parseTiles("1111m") }],
    });
    expect(r.fu).toBe(70);
  });

  it("明杠幺九 +16：20+16+2 = 38 → 40", () => {
    const r = winEval("234p456p789p44z", "4z", {
      houtei: true,
      melds: [{ type: "daiminkan", tiles: parseTiles("1111s"), from: "toimen" }],
    });
    expect(r.fu).toBe(40);
  });

  it("明杠中张 +8：20+8+2 = 30", () => {
    const r = winEval("234p456p789p44z", "4z", {
      houtei: true,
      melds: [{ type: "daiminkan", tiles: parseTiles("5555s"), from: "toimen" }],
    });
    expect(r.fu).toBe(30);
  });

  it("加杠幺九 +16（同明杠口径）：38 → 40", () => {
    const r = winEval("234p456p789p44z", "4z", {
      houtei: true,
      melds: [{ type: "kakan", tiles: parseTiles("9999p") }],
    });
    expect(r.fu).toBe(40);
  });

  it("加杠中张 +8：30", () => {
    const r = winEval("234p456p789p44z", "4z", {
      houtei: true,
      melds: [{ type: "kakan", tiles: parseTiles("2222s") }],
    });
    expect(r.fu).toBe(30);
  });
});

describe("符：特殊形固定值", () => {
  it("七对子恒 25 符（不切上）", () => {
    const r = winEval("1122p3344s5566z77z", "7z");
    expect(r.fu).toBe(25);
    expect(r.pattern?.kind).toBe("chiitoi");
  });

  it("国士无双恒 30 符", () => {
    const r = winEval("1m9m1p9p1s9s11234567z", "7z");
    expect(r.fu).toBe(30);
    expect(r.pattern?.kind).toBe("kokushi");
  });
});
