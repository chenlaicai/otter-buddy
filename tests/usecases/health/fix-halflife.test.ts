import { describe, it, expect } from "vitest";
import { computeFixInterval, buildFixIntervalRow } from "@usecases/health/fix-halflife";

const DAY = 24 * 60 * 60 * 1000;
const BASE = new Date("2026-08-25T12:00:00Z").getTime();

function daysAgo(days: number): string {
  return new Date(BASE - days * DAY).toISOString();
}

describe("computeFixInterval（Issue #645 修复半衰期）", () => {
  it("间隔缩短 → shortening（退化：bug 越修越密）", () => {
    // 早期间隔 ~8 天，后期 ~1 天：后半/前半 < 0.8
    const dates = [daysAgo(50), daysAgo(42), daysAgo(10), daysAgo(8), daysAgo(6), daysAgo(4), daysAgo(2)];
    const r = computeFixInterval(dates);
    expect(r.trend).toBe("shortening");
    expect(r.bugfixCount).toBe(7);
    expect(r.averageIntervalDays).not.toBeNull();
    expect(r.firstHalfAvgDays! > r.secondHalfAvgDays!).toBe(true);
  });

  it("间隔拉长 → lengthening（进化：修得越来越慢=问题变稀）", () => {
    const dates = [daysAgo(50), daysAgo(48), daysAgo(46), daysAgo(44), daysAgo(10), daysAgo(2)];
    const r = computeFixInterval(dates);
    expect(r.trend).toBe("lengthening");
  });

  it("间隔稳定 → stable（±20% 内）", () => {
    const dates = [daysAgo(40), daysAgo(35), daysAgo(30), daysAgo(25), daysAgo(20), daysAgo(15)];
    const r = computeFixInterval(dates);
    expect(r.trend).toBe("stable");
    expect(r.averageIntervalDays).toBe(5); // 6 点 5 间隔全为 5 天
  });

  it("样本不足：<4 个 bugfix → insufficient 且有平均间隔（2-3 个时）", () => {
    const two = computeFixInterval([daysAgo(10), daysAgo(4)]);
    expect(two.trend).toBe("insufficient");
    expect(two.averageIntervalDays).toBe(6);
    expect(two.firstHalfAvgDays).toBeNull();

    const three = computeFixInterval([daysAgo(10), daysAgo(7), daysAgo(4)]);
    expect(three.trend).toBe("insufficient"); // 3 个点 2 个间隔，半分对比统计意义弱
  });

  it("空输入与单点：null 间隔 + insufficient（空窗口边界）", () => {
    expect(computeFixInterval([]).averageIntervalDays).toBeNull();
    expect(computeFixInterval([]).trend).toBe("insufficient");
    const single = computeFixInterval([daysAgo(5)]);
    expect(single.averageIntervalDays).toBeNull();
    expect(single.bugfixCount).toBe(1);
  });

  it("无序输入自动排序（数据源顺序不敏感）", () => {
    const shuffled = [daysAgo(4), daysAgo(50), daysAgo(2), daysAgo(42)];
    const sorted = [daysAgo(50), daysAgo(42), daysAgo(4), daysAgo(2)];
    expect(computeFixInterval(shuffled)).toEqual(computeFixInterval(sorted));
  });

  it("前半零间隔（同日连环修）后半非零 → lengthening", () => {
    // 4 个 bugfix：前 3 个同日（2 个零间隔），后 1 个 5 天后
    const dates = [daysAgo(5), daysAgo(5), daysAgo(5), daysAgo(0)];
    const r = computeFixInterval(dates);
    expect(r.firstHalfAvgDays).toBe(0);
    expect(r.trend).toBe("lengthening");
  });

  it("接受 Date 对象输入（与 ISO 字符串同结果）", () => {
    const asStr = computeFixInterval([daysAgo(50), daysAgo(42), daysAgo(10), daysAgo(8), daysAgo(6), daysAgo(4), daysAgo(2)]);
    const asDate = computeFixInterval([
      new Date(daysAgo(50)), new Date(daysAgo(42)), new Date(daysAgo(10)),
      new Date(daysAgo(8)), new Date(daysAgo(6)), new Date(daysAgo(4)), new Date(daysAgo(2)),
    ]);
    expect(asDate).toEqual(asStr);
  });
});

describe("buildFixIntervalRow（trend 快照行）", () => {
  it("样本充足：metricValue=平均间隔，metadata 含趋势与半分值", () => {
    const row = buildFixIntervalRow("2026-08-25", computeFixInterval([daysAgo(40), daysAgo(35), daysAgo(30), daysAgo(25), daysAgo(20), daysAgo(15)]));
    expect(row.metricType).toBe("trend");
    expect(row.metricKey).toBe("bugfix_interval");
    expect(row.metricValue).toBe(5);
    const meta = JSON.parse(row.metadata);
    expect(meta.trend).toBe("stable");
    expect(meta.bugfixCount).toBe(6);
    expect(meta.firstHalfAvgDays).toBe(5);
    expect(meta.secondHalfAvgDays).toBe(5);
  });

  it("样本不足：metricValue=0 保持快照序列连续，metadata 标 insufficient", () => {
    const row = buildFixIntervalRow("2026-08-25", computeFixInterval([daysAgo(5)]));
    expect(row.metricValue).toBe(0);
    expect(JSON.parse(row.metadata).trend).toBe("insufficient");
  });
});
