/**
 * F20261012qtbc：三家配额响应归一化单测（纯函数，无浏览器）。
 * fixture 字段依据 2026-10-12 静态逆向结论（GLM limits 项字段已定名；
 * MiMo currentPlan* / Kimi 启发式为首登前的初版映射，首登冒烟后锁定）。
 */
import { describe, it, expect } from "vitest";
import { parseResetAt, buildWindow } from "@usecases/quota/quota-normalize";
import { QUOTA_PROVIDERS } from "@frameworks/quota/providers";

const spec = (id: "glm" | "kimi" | "mimo") => QUOTA_PROVIDERS.find(p => p.id === id)!;

describe("GLM 归一化（/monitor/usage/quota/limit 真实字段名）", () => {
  const payload = {
    data: {
      level: "pro",
      limits: [
        { title: "5 小时", currentValue: 660_000, showLimitCount: 1_000_000, nextResetTime: "2026-10-12 18:00:00" },
        { title: "本周", currentValue: 1_000_000, showLimitCount: 1_000_000, nextResetTime: "2026-10-15 12:46:05" },
      ],
    },
  };

  it("limits[] → 两个窗口（5h / week），剩余比例与差值正确", () => {
    const windows = spec("glm").normalize(payload)!;
    expect(windows).toHaveLength(2);
    expect(windows[0]!.key).toBe("5h");
    expect(windows[0]!.used).toBe(660_000);
    expect(windows[0]!.limit).toBe(1_000_000);
    expect(windows[0]!.remaining).toBe(340_000);
    expect(windows[0]!.remainingRatio).toBeCloseTo(0.34, 5);
    expect(windows[1]!.key).toBe("week");
    // 耗尽态：used == limit → remaining 0
    expect(windows[1]!.remaining).toBe(0);
    expect(windows[1]!.remainingRatio).toBe(0);
  });

  it("nextResetTime 'YYYY-MM-DD HH:mm:ss' 解析为 ISO（本地时区）", () => {
    const windows = spec("glm").normalize(payload)!;
    expect(windows[0]!.resetAt).toBe(new Date(2026, 9, 12, 18, 0, 0).toISOString());
  });

  it("空 limits / 无 limits → null（fail-closed）", () => {
    expect(spec("glm").normalize({ data: { limits: [] } })).toBeNull();
    expect(spec("glm").normalize({ data: {} })).toBeNull();
    expect(spec("glm").normalize("not json object")).toBeNull();
  });
});

describe("MiMo 归一化（/api/v1/tokenPlan/*，单余量形态）", () => {
  it("currentPlanUsage + currentPlanRemainingValue → 单窗口，总量 = used + remaining", () => {
    const windows = spec("mimo").normalize({
      code: 0,
      data: { currentPlanUsage: 20_000, currentPlanRemainingValue: 80_000 },
    })!;
    expect(windows).toHaveLength(1);
    expect(windows[0]!.key).toBe("total");
    expect(windows[0]!.used).toBe(20_000);
    expect(windows[0]!.remaining).toBe(80_000);
    expect(windows[0]!.limit).toBe(100_000);
    expect(windows[0]!.remainingRatio).toBeCloseTo(0.8, 5);
  });

  it("识别不出配额语义字段 → null（fail-closed，不猜数字）", () => {
    expect(spec("mimo").normalize({ code: 0, data: { cashBalance: 3.5, giftBalance: 0 } })).toBeNull();
  });
});

describe("Kimi 归一化（/apiv2 启发式，首登后锁定字段映射）", () => {
  it("quota.fiveHour / quota.weekly 结构 → 5h / week 双窗口", () => {
    const windows = spec("kimi").normalize({
      subscription: {
        plan: "kimi-code",
        quota: {
          fiveHour: { used: 300, limit: 1000 },
          weekly: { used: 900, limit: 1000, resetAt: 1_791_000_000 },
        },
      },
    })!;
    expect(windows.map(w => w.key).sort()).toEqual(["5h", "week"]);
    const five = windows.find(w => w.key === "5h")!;
    expect(five.label).toBe("5 小时");
    expect(five.remainingRatio).toBeCloseTo(0.7, 5);
    const week = windows.find(w => w.key === "week")!;
    expect(week.remaining).toBe(100);
    expect(week.resetAt).toBe(new Date(1_791_000_000 * 1000).toISOString());
  });

  it("无配额语义结构 → null（fail-closed）", () => {
    expect(spec("kimi").normalize({ user: { id: "cp1", nickname: "Joy" } })).toBeNull();
  });
});

describe("通用工具", () => {
  it("parseResetAt：秒/毫秒时间戳、可解析字符串、垃圾值", () => {
    expect(parseResetAt(1_791_000_000)).toBe(new Date(1_791_000_000 * 1000).toISOString());
    expect(parseResetAt(1_791_000_000_000)).toBe(new Date(1_791_000_000_000).toISOString());
    expect(parseResetAt("2026-10-15 12:46:05")).toBe(new Date(2026, 9, 15, 12, 46, 5).toISOString());
    expect(parseResetAt("垃圾")).toBeNull();
    expect(parseResetAt(undefined)).toBeNull();
  });

  it("buildWindow：三无（全 null）不成窗、label 推键兜底 w<n>", () => {
    const w = buildWindow("自定义窗口", {}, 3);
    expect(w.key).toBe("w3");
    expect(w.remainingRatio).toBeNull();
    const total = buildWindow("总量", { used: 10, remaining: 90 });
    expect(total.key).toBe("total");
    expect(total.limit).toBe(100);
    expect(total.remainingRatio).toBeCloseTo(0.9, 5);
  });
});
