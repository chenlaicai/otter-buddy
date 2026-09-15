/**
 * #843（F20260915mfbk）模型限流降级器测试。
 *
 * 覆盖：
 * - register：链上取第一个可用 fallback；链耗尽返回 null；重复登记幂等（更新 resetAt）
 * - resolve：仅当「当前生效别名 == 被降级别名」时返回替身；手动换模型（显式别名
 *   ≠ 被降级别名）不干预；未降级返回 null
 * - revert/sweepExpired：回切幂等；过期清扫
 * - parseResetAt：中文 resetHint 解析（东八区）；解析失败回退 1h
 * - 瞬时 429 行为不变：register 只应由调用方在 exhausted 时调（这里测服务自身
 *   语义；orchestrator 侧接线由 tsc + 集成测试保证）
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { ModelFallbackService } from "@usecases/scheduler/model-fallback-service";

function makePool(has: string[] = ["kimi", "mimo", "glm", "glm-flash"], def = "glm") {
  return {
    getDefaultAlias: () => def,
    hasModel: (alias: string) => has.includes(alias),
  };
}

describe("#843 register", () => {
  afterEach(() => vi.useRealTimers());

  it("exhausted glm → 取链上第一个非 glm 可用别名（kimi）", () => {
    const svc = new ModelFallbackService(makePool(), undefined, ["kimi", "mimo", "glm", "glm-flash"]);
    expect(svc.register("otter-1", "glm", "您的限额将在 2026-09-14 19:31:23 重置")).toBe("kimi");
  });

  it("链耗尽（池内无其他模型）→ null（调用方落 high healing 跳过）", () => {
    const svc = new ModelFallbackService(makePool(["glm"]), undefined, ["kimi", "mimo", "glm", "glm-flash"]);
    expect(svc.register("otter-1", "glm", null)).toBeNull();
  });

  it("重复登记幂等：更新 resetAt 不叠链", () => {
    const svc = new ModelFallbackService(makePool());
    const t1 = new Date(Date.now() + 8 * 60 * 60 * 1000 + 8 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
    const t2ms = Date.now() + 3 * 60 * 60 * 1000;
    const t2 = new Date(t2ms + 8 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
    svc.register("otter-1", "glm", `${t1} 重置`);
    const again = svc.register("otter-1", "glm", `${t2} 重置`);
    expect(again).toBe("kimi");
    const deg = svc.getDegradation("otter-1")!;
    expect(deg.resetAt).toBe(Date.parse(t2.replace(" ", "T") + "+08:00"));
  });
});

describe("#843 resolve", () => {
  it("生效别名 == 被降级别名（显式配置）→ 返回替身", () => {
    const svc = new ModelFallbackService(makePool());
    svc.register("otter-1", "glm", null);
    expect(svc.resolve("otter-1", "glm")).toBe("kimi");
  });

  it("无显式配置且默认 == 被降级别名 → 返回替身", () => {
    const svc = new ModelFallbackService(makePool(["kimi", "mimo", "glm"], "glm"));
    svc.register("otter-1", "glm", null);
    expect(svc.resolve("otter-1", undefined)).toBe("kimi");
  });

  it("手动换模型（显式别名 ≠ 被降级别名）→ 不干预返回 null", () => {
    const svc = new ModelFallbackService(makePool());
    svc.register("otter-1", "glm", null);
    expect(svc.resolve("otter-1", "mimo")).toBeNull();
  });

  it("未降级 → null（原语义不变）", () => {
    const svc = new ModelFallbackService(makePool());
    expect(svc.resolve("otter-1", "glm")).toBeNull();
  });
});

describe("#843 revert / sweep", () => {
  it("revert 后 resolve 回 null（回切生效，幂等）", () => {
    const svc = new ModelFallbackService(makePool());
    svc.register("otter-1", "glm", null);
    svc.revert("otter-1");
    svc.revert("otter-1"); // 幂等
    expect(svc.resolve("otter-1", "glm")).toBeNull();
  });

  it("resetAt 到点自动回切（定时器，东八区时间戳正确构造）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T08:00:00+08:00"));
    const svc = new ModelFallbackService(makePool());
    // hint 按东八区构造（parseResetAt 按东八区解析——测试与实现同时区）
    const hint = "2026-09-15 09:01:00 重置";
    svc.register("otter-1", "glm", hint);
    expect(svc.resolve("otter-1", "glm")).toBe("kimi");
    vi.advanceTimersByTime(61 * 60 * 1000 + 100); // 过 09:01:00
    expect(svc.resolve("otter-1", "glm")).toBeNull();
    vi.useRealTimers();
  });

  it("sweepExpired 清扫过期项（重启丢定时器的兜底）", () => {
    vi.useFakeTimers();
    const svc = new ModelFallbackService(makePool());
    svc.register("otter-1", "glm", null); // resetHint null → 1h 后重试
    vi.advanceTimersByTime(61 * 60 * 1000);
    svc.sweepExpired();
    expect(svc.getDegradation("otter-1")).toBeNull();
  });
});

describe("#843 parseResetAt（间接验证）", () => {
  it("中文 resetHint（智谱东八区）正确解析", () => {
    const svc = new ModelFallbackService(makePool());
    // 相对未来时间构造（东八区字面量）——避免硬编码日期随系统时间推进过期
    const t = new Date(Date.now() + 2 * 60 * 60 * 1000 + 8 * 60 * 60 * 1000);
    const ts = t.toISOString().replace("T", " ").slice(0, 19); // 字面时间串
    const expected = Date.parse(ts.replace(" ", "T") + "+08:00"); // 同串按东八区解析 = now+2h
    svc.register("otter-1", "glm", `[1308][已达到 5 小时的使用上限。您的限额将在 ${ts}。]`);
    expect(svc.getDegradation("otter-1")!.resetAt).toBe(expected);
  });

  it("resetAt 已在过去 → 钳到 1 分钟后（降级不形同虚设，无负 delay 定时器）", () => {
    const svc = new ModelFallbackService(makePool());
    const before = Date.now();
    svc.register("otter-1", "glm", "2026-01-01 00:00:00 重置"); // 远古时间
    const deg = svc.getDegradation("otter-1")!;
    expect(deg.resetAt).toBeGreaterThanOrEqual(before + 60 * 1000 - 5);
    expect(deg.resetAt).toBeLessThanOrEqual(Date.now() + 60 * 1000 + 5);
  });

  it("resetHint 缺失/不可解析 → 1h 后回切重试（不挂长定时器）", () => {
    const svc = new ModelFallbackService(makePool());
    const before = Date.now();
    svc.register("otter-1", "glm", "no time here");
    const deg = svc.getDegradation("otter-1")!;
    expect(deg.resetAt).toBeGreaterThanOrEqual(before + 60 * 60 * 1000 - 5);
  });
});
