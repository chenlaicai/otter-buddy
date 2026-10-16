/**
 * 振听三变体（三麻口径）：舍张振听（永久）/ 立直后同巡振听（临时）/
 * 头跳不适用——双响成立，放铳者对每家全额支付。
 */
import { describe, expect, it } from "vitest";
import {
  canRon,
  hasTempFuriten,
  isFuriten,
  multiRon,
} from "../../../src/usecases/mahjong/referee/furiten";

describe("舍张振听（永久）", () => {
  it("听牌张在自己河里 → 振听", () => {
    expect(isFuriten({ winningKinds: [20, 21], ownDiscardKinds: [21, 27] })).toBe(true);
  });

  it("听牌张不在河里 → 非振听", () => {
    expect(isFuriten({ winningKinds: [20], ownDiscardKinds: [27, 28] })).toBe(false);
  });

  it("空河 → 非振听", () => {
    expect(isFuriten({ winningKinds: [20], ownDiscardKinds: [] })).toBe(false);
  });

  it("多面听其一在河里即振听", () => {
    expect(isFuriten({ winningKinds: [9, 10, 11], ownDiscardKinds: [11] })).toBe(true);
  });

  it("自己打过非听牌张 → 非振听", () => {
    expect(isFuriten({ winningKinds: [9, 10], ownDiscardKinds: [0, 8, 26] })).toBe(false);
  });
});

describe("立直后同巡振听（临时，至下次摸牌）", () => {
  it("立直后错过荣和（能和未和）→ 临时振听", () => {
    expect(hasTempFuriten({ riichi: true, passedRon: true })).toBe(true);
  });

  it("立直后他人打出自己听牌张未和 → 临时振听", () => {
    expect(hasTempFuriten({ riichi: true, waitsDiscardedByOthersSinceDraw: [20] })).toBe(true);
  });

  it("自己刚摸牌 → 清除同巡标记", () => {
    expect(hasTempFuriten({ riichi: true, passedRon: true, justDrew: true })).toBe(false);
  });

  it("未立直 → 无同巡振听概念", () => {
    expect(hasTempFuriten({ riichi: false, passedRon: true })).toBe(false);
    expect(hasTempFuriten({ riichi: false, waitsDiscardedByOthersSinceDraw: [20] })).toBe(false);
  });

  it("立直且无任何错过事件 → 非振听", () => {
    expect(hasTempFuriten({ riichi: true })).toBe(false);
    expect(hasTempFuriten({ riichi: true, waitsDiscardedByOthersSinceDraw: [] })).toBe(false);
  });
});

describe("荣和资格（振听仅封荣和，自摸恒可）", () => {
  it("无振听 → 可荣和", () => {
    expect(canRon({ permanentFuriten: false, tempFuriten: false, tsumo: false })).toBe(true);
  });

  it("舍张振听 → 不可荣和", () => {
    expect(canRon({ permanentFuriten: true, tempFuriten: false, tsumo: false })).toBe(false);
  });

  it("同巡振听 → 不可荣和", () => {
    expect(canRon({ permanentFuriten: false, tempFuriten: true, tsumo: false })).toBe(false);
  });

  it("双振听 → 不可荣和", () => {
    expect(canRon({ permanentFuriten: true, tempFuriten: true, tsumo: false })).toBe(false);
  });

  it("舍张振听下自摸仍可和（自摸不受限）", () => {
    expect(canRon({ permanentFuriten: true, tempFuriten: true, tsumo: true })).toBe(true);
  });
});

describe("双响/多响（三麻无头跳：全额分摊）", () => {
  it("两家和 → 双响成立，放铳者对每家全额支付", () => {
    const out = multiRon(
      [
        { name: "A", furiten: false },
        { name: "B", furiten: false },
      ],
      () => 8000,
    );
    expect(out.winners).toEqual(["A", "B"]);
    expect(out.payments).toEqual([
      { winner: "A", points: 8000 },
      { winner: "B", points: 8000 },
    ]);
    // 无头跳：不是只有一个人和
    expect(out.payments.length).toBe(2);
  });

  it("其中一家振听 → 被排除，另一家独和", () => {
    const out = multiRon(
      [
        { name: "A", furiten: true },
        { name: "B", furiten: false },
      ],
      () => 12000,
    );
    expect(out.winners).toEqual(["B"]);
    expect(out.payments).toEqual([{ winner: "B", points: 12000 }]);
  });

  it("三家皆可和（三响）→ 全部成立、各自点数独立计算", () => {
    const out = multiRon(
      [
        { name: "A", furiten: false },
        { name: "B", furiten: false },
        { name: "C", furiten: false },
      ],
      (w) => (w.name === "C" ? 16000 : 8000),
    );
    expect(out.winners).toEqual(["A", "B", "C"]);
    expect(out.payments.map((p) => p.points)).toEqual([8000, 8000, 16000]);
  });

  it("全部振听 → 无人可和", () => {
    const out = multiRon(
      [
        { name: "A", furiten: true },
        { name: "B", furiten: true },
      ],
      () => 8000,
    );
    expect(out.winners).toEqual([]);
    expect(out.payments).toEqual([]);
  });

  it("pointsFor 只对合格赢家调用", () => {
    const seen: string[] = [];
    multiRon(
      [
        { name: "A", furiten: true },
        { name: "B", furiten: false },
      ],
      (w) => {
        seen.push(w.name);
        return 0;
      },
    );
    expect(seen).toEqual(["B"]);
  });
});
