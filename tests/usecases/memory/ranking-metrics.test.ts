/**
 * F20261008mrrk Phase 0：指标公式单测——教科书例子锁定，禁止同义反复
 * （不断言「实现等于自己算的」——每个用例的手算期望值独立于实现代码推导）。
 *
 * nDCG 参考定义：Järvelin & Kekäläinen (2002) CG/DCG，
 * 位置折扣 log2(rank+1)；此处用线性增益 rel（见 ranking-metrics.ts 头注）。
 * MRR 参考定义：Voorhees (1999) TREC QA track。
 */
import { describe, it, expect } from "vitest";
import { dcgAtK, ndcgAtK, reciprocalRank, mrr, mean } from "./ranking-metrics";

describe("dcgAtK - 位置折扣公式", () => {
  it("手算例：增益 [3,2,3,0,1,2] 的 DCG@6（log2 折扣逐位累加）", () => {
    // rel/log2(rank+1)：
    // 3/log2(2)=3.000000  2/log2(3)=1.261860  3/log2(4)=1.500000
    // 0/log2(5)=0          1/log2(6)=0.386853  2/log2(7)=0.712414
    // 合计 = 6.861127（6 位小数）
    expect(dcgAtK([3, 2, 3, 0, 1, 2], 6)).toBeCloseTo(6.861127, 5);
  });

  it("手算例：同一增益序列的 DCG@3 只累计前 3 位", () => {
    // 3 + 1.261860 + 1.5 = 5.761860
    expect(dcgAtK([3, 2, 3, 0, 1, 2], 3)).toBeCloseTo(5.76186, 5);
  });

  it("K 超过序列长度时按实际长度算（截断语义）", () => {
    expect(dcgAtK([3, 2], 10)).toBeCloseTo(3 + 2 / Math.log2(3), 10);
  });

  it("全零增益为 0；空序列为 0", () => {
    expect(dcgAtK([0, 0, 0], 3)).toBe(0);
    expect(dcgAtK([], 5)).toBe(0);
  });
});

describe("ndcgAtK - 归一化", () => {
  it("完美排序 = 1.0：标注增益降序即检索排序", () => {
    const rel = new Map([["d1", 3], ["d2", 2], ["d3", 1]]);
    expect(ndcgAtK(["d1", "d2", "d3"], rel, 5)).toBe(1);
  });

  it("手算例：倒序排序的 nDCG（Wikipedia 经典例的线性增益版）", () => {
    // 标注 d1=3 d2=2 d3=1；检索返回 [d3, d2, d1]（完全倒序）
    // DCG = 1/1 + 2/1.584963 + 3/2 = 1 + 1.261860 + 1.5 = 3.761860
    // IDCG = 3/1 + 2/1.584963 + 3/2 — 不对：IDCG 是增益降序 [3,2,1]
    //   = 3/1 + 2/1.584963 + 1/2 = 3 + 1.261860 + 0.5 = 4.761860
    // nDCG = 3.761860/4.761860 = 0.78999800（独立精确计算，非实现回代）
    const rel = new Map([["d1", 3], ["d2", 2], ["d3", 1]]);
    expect(ndcgAtK(["d3", "d2", "d1"], rel, 5)).toBeCloseTo(0.789998, 5);
  });

  it("相关条目排在 K 之外不计分：nDCG@2 只看前 2 位", () => {
    const rel = new Map([["d1", 3], ["d2", 2]]);
    // 排序 [noise, d2, d1]：DCG@2 = 0 + 2/log2(3) = 1.261860
    // IDCG@2 = 3 + 2/log2(3) = 4.261860 → 0.29608191（独立精确计算）
    expect(ndcgAtK(["noise", "d2", "d1"], rel, 2)).toBeCloseTo(0.29608191, 5);
  });

  it("未标注 id 增益为 0；全无命中返回 0", () => {
    const rel = new Map([["d1", 3]]);
    expect(ndcgAtK(["x", "y"], rel, 5)).toBe(0);
  });

  it("无正增益标注（空标注/全零）返回 0 不除零", () => {
    expect(ndcgAtK(["a"], new Map(), 5)).toBe(0);
    expect(ndcgAtK(["a"], new Map([["a", 0]]), 5)).toBe(0);
  });
});

describe("reciprocalRank / mrr", () => {
  it("首位命中 RR=1；第 3 位命中 RR=1/3", () => {
    const rel = new Map([["d1", 3]]);
    expect(reciprocalRank(["d1", "x"], rel)).toBe(1);
    expect(reciprocalRank(["x", "y", "d1"], rel)).toBeCloseTo(1 / 3, 10);
  });

  it("无正增益命中 RR=0", () => {
    const rel = new Map([["d1", 3]]);
    expect(reciprocalRank(["a", "b"], rel)).toBe(0);
  });

  it("增益 0 的标注条目不算命中（rel=3 才是命中线）", () => {
    const rel = new Map([["d0", 0], ["d1", 3]]);
    expect(reciprocalRank(["d0", "d1"], rel)).toBeCloseTo(1 / 2, 10);
  });

  it("MRR 手算例：三条查询 RR = 1, 1/3, 0 → 均值 4/9", () => {
    expect(mrr([1, 1 / 3, 0])).toBeCloseTo(4 / 9, 10);
  });

  it("空列表 MRR=0 不除零", () => {
    expect(mrr([])).toBe(0);
    expect(mean([])).toBe(0);
  });
});
