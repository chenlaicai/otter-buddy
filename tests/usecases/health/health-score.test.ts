/**
 * HealthScore 单测（issue #595 PR1）
 *
 * 覆盖：五维评分边界（0/满分/clamp）+ 状态分级边界（49/50/74/75）
 * + 走向判定（±5 边界/数据不足）+ 无数据降级（D3/D5 null 不参与加权）
 * + health_index 行构建 + 拖累归因。
 */

import { describe, it, expect } from "vitest";
import {
  computeHealthScore,
  scoreD1,
  scoreD2,
  scoreD3,
  scoreD5,
  statusFromScore,
  judgeTrend,
  buildHealthIndexRows,
  TREND_THRESHOLD,
} from "@usecases/health/health-score";

const BASE_INPUT = {
  snapshotDate: "2026-08-29",
  bugfixRatio: 0.1,
  totalCommits: 100,
  compliantCommits: 80,
  hotspotFiles: [] as Array<{ file: string; count: number }>,
  changeTypes: { "New Feature": 60, BugFix: 10 } as Record<string, number>,
  chainStates: { active: 8, stalled: 2 } as Record<string, number>,
  openSignals: { critical: 0, warning: 0 },
};

describe("D1 质量成本（审视 S1 定稿公式）", () => {
  it("ratio=0 满分 100（clamp 上限）", () => {
    expect(scoreD1(0)).toBe(100);
  });
  it("ratio=0.05 clamp 在 100，不越界", () => {
    expect(scoreD1(0.05)).toBe(100);
  });
  it("ratio=0.2 满分区边界 = 100", () => {
    expect(scoreD1(0.2)).toBe(100);
  });
  it("ratio=0.3 线性中点 = 50", () => {
    expect(scoreD1(0.3)).toBeCloseTo(50, 5);
  });
  it("ratio=0.4 归零", () => {
    expect(scoreD1(0.4)).toBe(0);
  });
  it("ratio>0.4 clamp 在 0", () => {
    expect(scoreD1(0.9)).toBe(0);
  });
});

describe("D2 架构稳定", () => {
  it("无热点无失衡 = 100", () => {
    expect(scoreD2(0, false)).toBe(100);
  });
  it("3 个热区文件：每个扣 4，共扣 12", () => {
    expect(scoreD2(3, false)).toBe(88);
  });
  it("5 个热区文件：封顶前边界 = 80", () => {
    expect(scoreD2(5, false)).toBe(80);
  });
  it("10 个热区文件：分段饱和 = 60（不归零）", () => {
    expect(scoreD2(10, false)).toBe(60);
  });
  it("20 个热区文件：封顶 60 扣分 → 40（目标区间）", () => {
    expect(scoreD2(20, false)).toBe(40);
  });
  it("100 个热区文件：仍封顶 60 = 40（与 20 个无区分度）", () => {
    expect(scoreD2(100, false)).toBe(40);
  });
  it("失衡再扣 20", () => {
    expect(scoreD2(0, true)).toBe(80);
  });
  it("12 热区 + 失衡：100 - 48 - 20 = 32", () => {
    expect(scoreD2(12, true)).toBe(32);
  });
  it("bugfix:feature ≥2 判失衡（与信号引擎同口径）", () => {
    const r = computeHealthScore({
      ...BASE_INPUT,
      changeTypes: { BugFix: 40, "New Feature": 20 },
    });
    const d2 = r.dimensions.find(d => d.dimension === "D2")!;
    expect(d2.score).toBe(80); // 0 hotspot + imbalance -20
  });
});

describe("D3 交付活力", () => {
  it("全 active = 100", () => {
    expect(scoreD3({ active: 10 })).toBe(100);
  });
  it("一半 zombie：active 得分 50 被 zombie 扣 50 → 0", () => {
    expect(scoreD3({ active: 5, zombie: 5 })).toBe(0);
  });
  it("40% zombie：60 得分扣 40 → 20", () => {
    expect(scoreD3({ active: 6, zombie: 4 })).toBe(20);
  });
  it("regressed 惩罚 ×150：一半 regressed → 50-75 clamp 0", () => {
    expect(scoreD3({ active: 5, regressed: 5 })).toBe(0);
  });
  it("20% regressed：80 得分扣 30 → 50", () => {
    expect(scoreD3({ active: 8, regressed: 2 })).toBe(50);
  });
  it("zombie 归因优先于 regressed（数量相同时）", () => {
    const r = computeHealthScore({
      ...BASE_INPUT,
      chainStates: { active: 5, zombie: 3, regressed: 3 },
    });
    const d3 = r.dimensions.find(d => d.dimension === "D3")!;
    expect(d3.attribution).toContain("zombie");
  });

  it("zombie=0 且 regressed=0 时归因指认 orphan 而非 zombie 0 条（审视发现 1）", () => {
    const r = computeHealthScore({
      ...BASE_INPUT,
      chainStates: { active: 8, orphan: 2 },
    });
    const d3 = r.dimensions.find(d => d.dimension === "D3")!;
    expect(d3.score).toBe(80);
    expect(d3.attribution).toBe("orphan 链 2 条");
  });

  it("四级优先级：regressed 压过 orphan（数量小于也优先）", () => {
    const r = computeHealthScore({
      ...BASE_INPUT,
      chainStates: { active: 7, regressed: 1, orphan: 4 },
    });
    const d3 = r.dimensions.find(d => d.dimension === "D3")!;
    expect(d3.attribution).toBe("regressed 链 1 条");
  });

  it("仅 stalled 时归因指认 stalled", () => {
    const r = computeHealthScore({
      ...BASE_INPUT,
      chainStates: { active: 8, stalled: 2 },
    });
    const d3 = r.dimensions.find(d => d.dimension === "D3")!;
    expect(d3.attribution).toBe("stalled 链 2 条");
  });
});

describe("D4 流程合规", () => {
  it("线性映射：80/100 合规 = 80 分", () => {
    const r = computeHealthScore(BASE_INPUT);
    expect(r.dimensions.find(d => d.dimension === "D4")!.score).toBe(80);
  });
  it("零提交 = 无数据 null", () => {
    const r = computeHealthScore({ ...BASE_INPUT, totalCommits: 0, compliantCommits: 0 });
    expect(r.dimensions.find(d => d.dimension === "D4")!.score).toBeNull();
  });
});

describe("D5 信号压力（审视 S2 定稿口径）", () => {
  it("活跃链 = active+stalled（zombie/orphan 不算）", () => {
    // 10 active + 2 zombie：活跃链=10，1 critical → 密度 0.1 → 100-4=96
    const r = computeHealthScore({
      ...BASE_INPUT,
      chainStates: { active: 10, zombie: 2 },
      openSignals: { critical: 1, warning: 0 },
    });
    expect(r.dimensions.find(d => d.dimension === "D5")!.score).toBe(96);
  });
  it("零活跃链 = 无数据「—」（不参与加权）", () => {
    const r = computeHealthScore({
      ...BASE_INPUT,
      chainStates: { zombie: 5 },
      openSignals: { critical: 10, warning: 10 },
    });
    const d5 = r.dimensions.find(d => d.dimension === "D5")!;
    expect(d5.score).toBeNull();
    expect(d5.status).toBeNull();
    expect(r.overall).not.toBeNull(); // 其余四维仍出综合分
  });
  it("critical 密度 2.5 → 0 分（clamp）", () => {
    expect(scoreD5(25, 0, 10)).toBe(0);
  });
});

describe("状态分级边界", () => {
  it("75 = green，74 = yellow", () => {
    expect(statusFromScore(75)).toBe("green");
    expect(statusFromScore(74.9)).toBe("yellow");
  });
  it("50 = yellow，49.9 = red", () => {
    expect(statusFromScore(50)).toBe("yellow");
    expect(statusFromScore(49.9)).toBe("red");
  });
});

describe("综合分与拖累归因", () => {
  it("无数据维度权重归一：仅 D1/D4 有数据时按 0.35 总权重归一", () => {
    const r = computeHealthScore({
      ...BASE_INPUT,
      chainStates: null, // D3、D5 无数据
      hotspotFiles: [], changeTypes: {},
      bugfixRatio: 0.1, totalCommits: 100, compliantCommits: 80,
    });
    // D1=100（ratio 0.1），D2=100（无热点无失衡——changeTypes 空不触发），D4=80
    // 权重：0.25+0.2+0.1=0.55 → (100×0.25+100×0.2+80×0.1)/0.55 ≈ 96.4
    expect(r.overall).toBeCloseTo(96.4, 1);
  });
  it("归因指向最低维度的最大扣分项", () => {
    const r = computeHealthScore({
      ...BASE_INPUT,
      bugfixRatio: 0.38, // D1=10
      compliantCommits: 60, // D4=60
    });
    expect(r.attribution).toContain("质量成本");
    expect(r.attribution).toContain("bugfix");
  });
  it("除 D3 外全满分：stalled 占 20% → D3=80，综合 95", () => {
    const r = computeHealthScore({ ...BASE_INPUT, compliantCommits: 100 });
    expect(r.overall).toBe(95);
    expect(r.attribution).toContain("交付活力");
  });
  it("全链 active + 全合规时归因为 null", () => {
    const r = computeHealthScore({
      ...BASE_INPUT,
      compliantCommits: 100,
      chainStates: { active: 10 },
    });
    expect(r.overall).toBe(100);
    expect(r.attribution).toBeNull();
  });
  it("D4 非满分时归因指向 D4 未规范提交数", () => {
    const r = computeHealthScore({ ...BASE_INPUT, chainStates: { active: 10 } }); // D4=80 最低（D3=100）
    expect(r.attribution).toContain("流程合规");
    expect(r.attribution).toContain("20 个提交");
  });
});

describe("走向判定", () => {
  it("不足 8 点 = null（冷启动首日）", () => {
    expect(judgeTrend([80, 82, 81, 80, 79, 80, 78])).toBeNull();
  });
  it("近 7 天均值比前 7 天高 >5 = improving", () => {
    const prior = [60, 60, 60, 60, 60, 60, 60];
    const recent = [70, 70, 70, 70, 70, 70, 70];
    expect(judgeTrend([...prior, ...recent])).toBe("improving");
  });
  it("差值恰好 = 阈值不判 improving（严格大于）", () => {
    const prior = [60, 60, 60, 60, 60, 60, 60];
    const recent = Array.from({ length: 7 }, () => 60 + TREND_THRESHOLD);
    expect(judgeTrend([...prior, ...recent])).toBe("stable");
  });
  it("下降 >5 = declining", () => {
    const prior = [80, 80, 80, 80, 80, 80, 80];
    const recent = [70, 70, 70, 70, 70, 70, 70];
    expect(judgeTrend([...prior, ...recent])).toBe("declining");
  });
  it("序列含 null 点（无数据日）被剔除后仍可判定", () => {
    const prior = [60, null, 60, 60, 60, 60, 60, 60];
    const recent = [70, 70, 70, 70, 70, 70, 70, 70];
    expect(judgeTrend([...prior, ...recent])).toBe("improving");
  });
});

describe("health_index 行构建", () => {
  it("每维一行 + overall 一行（metadata 含归因），无数据维度跳过", () => {
    const r = computeHealthScore({
      ...BASE_INPUT,
      chainStates: null, // D3/D5 跳过
    });
    const rows = buildHealthIndexRows(r);
    const keys = rows.map(row => row.metricKey);
    expect(keys).toContain("D1");
    expect(keys).toContain("D2");
    expect(keys).toContain("D4");
    expect(keys).toContain("overall");
    expect(keys).not.toContain("D3");
    expect(keys).not.toContain("D5");
    const overall = rows.find(row => row.metricKey === "overall")!;
    expect(JSON.parse(overall.metadata!)).toHaveProperty("overallStatus");
  });
  it("metricType 统一为 health_index，日期透传", () => {
    const rows = buildHealthIndexRows(computeHealthScore(BASE_INPUT));
    for (const row of rows) {
      expect(row.metricType).toBe("health_index");
      expect(row.snapshotDate).toBe("2026-08-29");
    }
  });
});
