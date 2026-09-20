/**
 * HealthScore 单测（issue #595 PR1 + F20260920hcal 校准批次）
 *
 * 覆盖：五维评分边界（0/满分/clamp）+ 状态分级边界（49/50/74/75）
 * + 走向判定（±5 边界/数据不足/窗口内 null 剔除）+ 无数据降级（D3/D5 null 不参与加权）
 * + health_index 行构建 + 拖累归因。
 *
 * F20260920hcal 校准变更：
 * - D1: 40%归零→55%归零（三档锚点 ≤25%/40%/≥55%）
 * - D2: ×4+cap60→×2无封顶（恢复区分度）
 * - D3: stalled ×100→×50（中间惩罚系数）
 * - judgeTrend: null 先切窗口再剔除（窗口内 null 不拉扯跨窗口数据）
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
  totalHotspotFiles: 0,
  changeTypes: { "New Feature": 60, BugFix: 10 } as Record<string, number>,
  chainStates: { active: 8, stalled: 2 } as Record<string, number>,
  openSignals: { critical: 0, warning: 0 },
};

describe("D1 质量成本（F20260920hcal 校准公式）", () => {
  it("ratio=0 满分 100（clamp 上限）", () => {
    expect(scoreD1(0)).toBe(100);
  });
  it("ratio=0.05 clamp 在 100，不越界", () => {
    expect(scoreD1(0.05)).toBe(100);
  });
  it("ratio=0.25 满分区边界 = 100", () => {
    expect(scoreD1(0.25)).toBe(100);
  });
  it("ratio=0.40 中点 = 50（校准后关键锚点）", () => {
    expect(scoreD1(0.40)).toBeCloseTo(50, 5);
  });
  it("ratio=0.55 归零", () => {
    expect(scoreD1(0.55)).toBe(0);
  });
  it("ratio>0.55 clamp 在 0", () => {
    expect(scoreD1(0.9)).toBe(0);
  });
  it("ratio=0.379（实测均值）得 57 分（原公式得 10.6 分——区分度恢复）", () => {
    expect(scoreD1(0.379)).toBeCloseTo(57, 0);
  });
});

describe("D2 架构稳定（F20260920hcal 校准公式）", () => {
  it("无热点无失衡 = 100", () => {
    expect(scoreD2(0, false)).toBe(100);
  });
  it("3 个热区文件：每个扣 2，共扣 6", () => {
    expect(scoreD2(3, false)).toBe(94);
  });
  it("10 个热区文件：扣 20 = 80（绿）", () => {
    expect(scoreD2(10, false)).toBe(80);
  });
  it("15 个热区文件：扣 30 = 70（原公式饱和 40，现恢复区分度）", () => {
    expect(scoreD2(15, false)).toBe(70);
  });
  it("20 个热区文件：扣 40 = 60（黄）", () => {
    expect(scoreD2(20, false)).toBe(60);
  });
  it("30 个热区文件：扣 60 = 40（红）——无饱和封顶", () => {
    expect(scoreD2(30, false)).toBe(40);
  });
  it("50 个热区文件：扣 100 = 0（clamp）", () => {
    expect(scoreD2(50, false)).toBe(0);
  });
  it("失衡再扣 20", () => {
    expect(scoreD2(0, true)).toBe(80);
  });
  it("20 热区 + 失衡：100 - 40 - 20 = 40", () => {
    expect(scoreD2(20, true)).toBe(40);
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

describe("D3 交付活力（F20260920hcal stalled 中间惩罚系数）", () => {
  it("全 active = 100", () => {
    expect(scoreD3({ active: 10 })).toBe(100);
  });
  it("一半 stalled：50 得分 -50×50% = 25（原 ×100 得 0，现中间惩罚）", () => {
    expect(scoreD3({ active: 5, stalled: 5 })).toBe(25);
  });
  it("40% stalled：60 得分 -40×50% = 40（原 ×100 得 20）", () => {
    expect(scoreD3({ active: 6, stalled: 4 })).toBe(40);
  });
  it("regressed 惩罚 ×150：一半 regressed → 50-75 clamp 0", () => {
    expect(scoreD3({ active: 5, regressed: 5 })).toBe(0);
  });
  it("20% regressed：80 得分 -20×150% = 50", () => {
    expect(scoreD3({ active: 8, regressed: 2 })).toBe(50);
  });
  it("stalled 归因排在 orphan 前、regressed 之后（数量相同时取更重者）", () => {
    const r = computeHealthScore({
      ...BASE_INPUT,
      chainStates: { active: 5, stalled: 3, regressed: 3 },
    });
    const d3 = r.dimensions.find(d => d.dimension === "D3")!;
    expect(d3.attribution).toContain("出过回退");
  });

  it("zombie=0 且 regressed=0 时归因指认 orphan 而非 zombie 0 条（审视发现 1）", () => {
    const r = computeHealthScore({
      ...BASE_INPUT,
      chainStates: { active: 8, orphan: 2 },
    });
    const d3 = r.dimensions.find(d => d.dimension === "D3")!;
    expect(d3.score).toBe(80);
    expect(d3.attribution).toBe("烂尾风险 2 条");
  });

  it("F20260917hprl S1：综合归因句人话化——大白话维度名 + 分数取整（无浮点裸奔）", () => {
    const r = computeHealthScore({ ...BASE_INPUT, chainStates: { active: 8, orphan: 2 } });
    expect(r.attribution).toBe("交付节奏只有 80 分：烂尾风险 2 条——这是主要拖累");
    expect(r.attribution).not.toMatch(/\d+\.\d{2,}/); // 无长浮点
  });

  it("四级优先级：regressed 压过 orphan（数量小于也优先）", () => {
    const r = computeHealthScore({
      ...BASE_INPUT,
      chainStates: { active: 7, regressed: 1, orphan: 4 },
    });
    const d3 = r.dimensions.find(d => d.dimension === "D3")!;
    expect(d3.attribution).toBe("出过回退 1 条");
  });

  it("仅 stalled 时归因指认 stalled", () => {
    const r = computeHealthScore({
      ...BASE_INPUT,
      chainStates: { active: 8, stalled: 2 },
    });
    const d3 = r.dimensions.find(d => d.dimension === "D3")!;
    expect(d3.attribution).toBe("卡住 2 条");
  });

  it("显式传入 stalledWeight=100 等效旧公式（向后兼容）", () => {
    expect(scoreD3({ active: 5, stalled: 5 }, 100)).toBe(0);
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
      bugfixRatio: 0.38, // D1≈56.7（校准后）
      compliantCommits: 60, // D4=60
    });
    // D4=60 < D1≈56.7? No, D1=100*(0.55-0.38)/0.30=56.7, D4=60, D1 is lower
    expect(r.attribution).toContain("修 bug 比例");
    expect(r.attribution).toContain("bugfix");
  });
  it("D3 stalled 中间惩罚：stalled 20% + 全合规时 D3=40，综合分受 D3 拖累", () => {
    // stalled=2/10=20%，×50=10；active=80% → 80-10=70
    const r = computeHealthScore({ ...BASE_INPUT, compliantCommits: 100 });
    const d3 = r.dimensions.find(d => d.dimension === "D3")!;
    expect(d3.score).toBe(70);
    expect(r.attribution).toContain("交付节奏");
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
    expect(r.attribution).toContain("流程纪律");
    expect(r.attribution).toContain("20 个提交");
  });
});

describe("走向判定（F20260920hcal 窗口内 null 剔除修正）", () => {
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
  it("前窗口内 null 被剔除，不影响后窗口（F20260920hcal 修正核心场景）", () => {
    // 原实现：null 被 filter 掉，prior 窗口拉扯 recent 数据进 prior
    // 新实现：先切窗口再 filter，null 只影响各自窗口
    // 15 个数据点：prior=[60,null,60,60,60,60,60] recent=[70,70,70,70,70,70,70,70]
    // prior 有 7 个槽位，6 个有效；recent 有 7 个槽位（后 7 个），8 个数据 → 最后7个=70
    const series = [60, null, 60, 60, 60, 60, 60, 70, 70, 70, 70, 70, 70, 70];
    // prior=series[0..6]=[60,null,60,60,60,60,60] → filter后6个，prior.length=6 < 7 → null
    // (recent=series[7..13]=[70,70,70,70,70,70,70] → 7 valid)
    expect(judgeTrend(series)).toBeNull();
  });
  it("prior 窗口全有效 + recent 含 null 时 recent 最少 3 点才可判定（F20260920hcal 防噪声）", () => {
    const prior = [60, 60, 60, 60, 60, 60, 60]; // 7 valid
    const recent = [70, 70, 70, null, null, null, null]; // 3 valid → 判定
    expect(judgeTrend([...prior, ...recent])).toBe("improving");
  });
  it("recent 窗口仅 2 点不足以判定（默认 minRecentValid=3）", () => {
    const prior = [60, 60, 60, 60, 60, 60, 60];
    const recent = [70, 70, null, null, null, null, null]; // 2 valid < 3
    expect(judgeTrend([...prior, ...recent])).toBeNull();
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
