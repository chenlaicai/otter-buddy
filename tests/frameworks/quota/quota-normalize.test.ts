/**
 * F20261012qtbc：三家配额响应归一化单测（纯函数，无浏览器）。
 * fixture 字段依据 2026-10-13 首登冒烟真实响应锁定（quota-raw-capture.json）：
 *  - GLM：data.limits[] = { usage(总量), currentValue(已用), remaining(剩余), nextResetTime(毫秒) }
 *  - MiMo：data.monthUsage.items[] / data.usage.items[] = { name, used, limit, percent }
 *  - Kimi：字段未定名（/apiv2 connect-RPC），启发式 + 首登锁定
 */
import { describe, it, expect } from "vitest";
import { parseResetAt, buildWindow } from "@usecases/quota/quota-normalize";
import { QUOTA_PROVIDERS } from "@frameworks/quota/providers";

const spec = (id: "glm" | "kimi" | "mimo") => QUOTA_PROVIDERS.find(p => p.id === id)!;

describe("GLM 归一化（/monitor/usage/quota 真实字段名，2026-10-13 锁定）", () => {
  // 真实响应：usage=窗口总量、currentValue=已用、remaining=剩余、nextResetTime=毫秒时间戳
  const payload = {
    code: 200,
    data: {
      level: "max",
      limits: [
        { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 28000, currentValue: 6600, remaining: 21400, percentage: 23 },
        { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 140000, currentValue: 140000, remaining: 0, percentage: 100, nextResetTime: 1792039565977 },
      ],
    },
  };

  it("limits[] → 两个窗口（5h / week），usage=limit、currentValue=used、remaining 直取", () => {
    const windows = spec("glm").normalize(payload)!;
    expect(windows).toHaveLength(2);
    expect(windows[0]!.key).toBe("5h");
    expect(windows[0]!.label).toBe("5 小时");
    expect(windows[0]!.used).toBe(6600);
    expect(windows[0]!.limit).toBe(28000);
    expect(windows[0]!.remaining).toBe(21400);
    expect(windows[0]!.remainingRatio).toBeCloseTo(21400 / 28000, 5);
    expect(windows[1]!.key).toBe("week");
    expect(windows[1]!.label).toBe("本周");
    // 耗尽态：remaining=0
    expect(windows[1]!.remaining).toBe(0);
    expect(windows[1]!.remainingRatio).toBe(0);
  });

  it("nextResetTime 毫秒时间戳解析为 ISO", () => {
    const windows = spec("glm").normalize(payload)!;
    expect(windows[1]!.resetAt).toBe(new Date(1792039565977).toISOString());
  });

  it("空 limits / 无 limits → null（fail-closed）", () => {
    expect(spec("glm").normalize({ data: { limits: [] } })).toBeNull();
    expect(spec("glm").normalize({ data: {} })).toBeNull();
    expect(spec("glm").normalize("not json object")).toBeNull();
  });
});

describe("MiMo 归一化（/api/v1/tokenPlan/usage 真实字段名，2026-10-13 锁定）", () => {
  // 真实响应：data.monthUsage.items[] 与 data.usage.items[]，项 = { name, used, limit, percent }
  const usagePayload = {
    code: 0,
    data: {
      monthUsage: { percent: 0.47, items: [{ name: "month_total_token", used: 214317515490, limit: 456000000000, percent: 0.47 }] },
      usage: { percent: 0.47, items: [
        { name: "plan_total_token", used: 214317515490, limit: 456000000000, percent: 0.47 },
        { name: "compensation_total_token", used: 0, limit: 0, percent: 0 },
      ] },
    },
  };

  it("monthUsage.items[] → 本月额度窗口（used/limit 直取，remaining 推导）", () => {
    const windows = spec("mimo").normalize(usagePayload)!;
    // 「套餐总量」与「本月额度」数值相同（月套餐）→ 去重只留本月额度
    expect(windows).toHaveLength(1);
    expect(windows[0]!.key).toBe("month");
    expect(windows[0]!.label).toBe("本月额度");
    expect(windows[0]!.used).toBe(214317515490);
    expect(windows[0]!.limit).toBe(456000000000);
    expect(windows[0]!.remaining).toBe(456000000000 - 214317515490);
    expect(windows[0]!.remainingRatio).toBeCloseTo(0.53, 2);
  });

  it("detail 响应（套餐信息无 items）→ null（fail-closed）", () => {
    expect(spec("mimo").normalize({ code: 0, data: { planCode: "pro:year", planName: "Pro" } })).toBeNull();
  });

  it("识别不出配额语义字段 → null（fail-closed，不猜数字）", () => {
    expect(spec("mimo").normalize({ code: 0, data: { cashBalance: 3.5, giftBalance: 0 } })).toBeNull();
  });

  it("补偿额度 used=0/limit=0 不成窗", () => {
    const w = spec("mimo").normalize({
      data: { usage: { items: [{ name: "compensation_total_token", used: 0, limit: 0, percent: 0 }] } },
    });
    expect(w).toBeNull();
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

  it("S2 加固：通用词 key（hour/plan 等）不再蒙混", () => {
    expect(spec("kimi").normalize({ timestamp_hour: { used: 1, limit: 2 } })).toBeNull();
    expect(spec("kimi").normalize({ plan: { used: 1, limit: 2 } })).toBeNull();
  });

  it("S2 加固：单数字对象不成窗", () => {
    expect(spec("kimi").normalize({ weekly: { used: 5 } })).toBeNull();
  });

  it("S2 加固：带日期的时序点不冒充窗口", () => {
    expect(spec("kimi").normalize({ day: "2026-10-12", fiveHour: { used: 1, limit: 2 } })).toBeNull();
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
