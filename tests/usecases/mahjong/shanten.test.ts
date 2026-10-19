/**
 * L1 向听数：标准形/七对/国士分层 + 副露固定面子 + 三麻万子无顺特性。
 * 期望值来源：mahjong-utils 官方 shanten API（对拍 oracle，独立于本实现）。
 */
import { describe, expect, it } from "vitest";
import { parseTiles } from "../../../src/entities/mahjong/tile";
import { shanten } from "../../../src/usecases/mahjong/referee/shanten";

const S = (notation: string, melds = 0) => shanten(parseTiles(notation), melds);

describe("标准形向听（oracle 期望）", () => {
  it("和了形 14 张 → -1", () => {
    expect(S("111m456p789p123s55z").regular).toBe(-1);
    expect(S("123p456p789p123s55z").regular).toBe(-1);
    expect(S("111m456p789p123s55z").min).toBe(-1);
  });

  it.each([
    ["单骑听 4z", "111m123p456p789p4z", 0],
    ["嵌张听 46s", "111m456p789p46s55z", 0],
    ["两面听 23s", "111m456p789p23s44z", 0],
    ["边张听 12s", "111m456p789p12s44z", 0],
    ["3面子+搭子+雀头+浮牌 1向听", "111m456p789p12s5z6z", 1],
    ["2面子+1搭子+雀头+浮牌 2向听", "19m456p789p12s44z5z", 2],
    ["1面子+2搭子+雀头+浮牌 2向听", "456p78p19m12s44z55z", 2],
  ])("%s → regular %i", (_name, notation, expected) => {
    expect(S(notation as string).regular).toBe(expected);
  });

  it.each([
    ["副露1面子：门清10张听牌", "456p789p12s44z", ["789s"], 0],
    ["副露2面子：门清7张听牌", "789p12s44z", ["789s", "456s"], 0],
    ["副露4面子：单张单骑听", "5z", ["789s", "456s", "123p", "111m"], 0],
  ])("%s", (_name, notation, furo, expected) => {
    const melds = (furo as string[]).length;
    expect(S(notation as string, melds).regular).toBe(expected);
  });

  it("副露1面子和了形 → -1", () => {
    expect(S("456p789p123s55z", 1).min).toBe(-1);
  });
});

describe("七对子向听（oracle 期望）", () => {
  it("七对和了（7对14张）→ -1", () => {
    const r = S("11223344556677p");
    expect(r.chiitoi).toBe(-1);
    expect(r.min).toBe(-1);
  });

  it("六对+单张：chiitoi=0（regular 同为 0）", () => {
    const r = S("1122334455667p");
    expect(r.chiitoi).toBe(0);
    expect(r.regular).toBe(0);
    expect(r.min).toBe(0);
  });

  it("五对+三单张：chiitoi=1（regular 0 更优）", () => {
    const r = S("1122334455p6p7p8p");
    expect(r.chiitoi).toBe(1);
    expect(r.regular).toBe(0);
    expect(r.min).toBe(0);
  });

  it("副露后七对不可（chiitoi=99）", () => {
    expect(S("1122334455667p", 1).chiitoi).toBe(99);
  });
});

describe("国士向听（oracle 期望）", () => {
  it("国士和了（13种齐全含对）→ -1", () => {
    const r = S("1m9m1p9p1s9s11234567z");
    expect(r.kokushi).toBe(-1);
    expect(r.min).toBe(-1);
  });

  it("12种含对（缺7z）→ kokushi=0（听 7z）", () => {
    const r = S("1m9m1p9p1s9s1123456z");
    expect(r.kokushi).toBe(0);
    expect(r.min).toBe(0);
  });

  it("13种无对（13面听）→ 0", () => {
    const r = S("1m9m1p9p1s9s1234567z");
    expect(r.kokushi).toBe(0);
    expect(r.regular).toBe(8);
    expect(r.chiitoi).toBe(6);
    expect(r.min).toBe(0);
  });

  it("11种+两对 → 1 向听", () => {
    const r = S("1m9m1p9p1s9s1122345z");
    expect(r.kokushi).toBe(1);
    expect(r.min).toBe(1);
  });
});

describe("三麻特性（oracle 期望）", () => {
  it("纯1/9万+么九手：regular=4，最小=3（kokushi 通道）", () => {
    const r = S("111999m1p9p1s9s123z");
    expect(r.regular).toBe(4);
    expect(r.kokushi).toBe(3);
    expect(r.min).toBe(3);
  });

  it("筒子可成顺（与万子对照）", () => {
    expect(S("123p456p789p123s55z").regular).toBe(-1);
  });

  it("解析层拒绝 2~8 万入向听计算", () => {
    expect(() => S("12m456p")).toThrow();
  });
});
