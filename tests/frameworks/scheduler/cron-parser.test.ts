import { describe, it, expect, vi, afterEach } from "vitest";
import { SimpleCronParser } from "@frameworks/scheduler/cron-parser";

describe("SimpleCronParser", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("getNextTime", () => {
    it("有效 cron 表达式返回一个 Date 对象", () => {
      const parser = new SimpleCronParser();
      const result = parser.getNextTime("0 9 * * *", "Asia/Shanghai");
      expect(result).toBeInstanceOf(Date);
    });

    it("返回的 Date 在当前时间之后", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-22T08:00:00Z"));

      const parser = new SimpleCronParser();
      const result = parser.getNextTime("0 9 * * *", "UTC");

      expect(result.getTime()).toBeGreaterThan(Date.now());
    });

    it("不同 timezone 对同一 cron 表达式产生不同结果", () => {
      const parser = new SimpleCronParser();
      const resultUTC = parser.getNextTime("0 9 * * *", "UTC");
      const resultShanghai = parser.getNextTime("0 9 * * *", "Asia/Shanghai");

      // 两个时区的 9:00 在 UTC 下对应的绝对时间不同
      expect(resultUTC.getTime()).not.toBe(resultShanghai.getTime());
    });

    it("无效 cron 表达式抛出错误", () => {
      const parser = new SimpleCronParser();
      expect(() => parser.getNextTime("invalid cron", "UTC")).toThrow();
    });

    it("空字符串 cron 表达式抛出错误", () => {
      const parser = new SimpleCronParser();
      expect(() => parser.getNextTime("", "UTC")).toThrow();
    });

    it("字段不足的 cron 表达式抛出错误", () => {
      const parser = new SimpleCronParser();
      expect(() => parser.getNextTime("* * *", "UTC")).toThrow();
    });

    it("使用假定时器时，返回的下次触发时间精确可预测", () => {
      vi.useFakeTimers();
      // 设定为 2026-07-22 08:30 UTC，cron 为每天 9:00 UTC
      vi.setSystemTime(new Date("2026-07-22T08:30:00Z"));

      const parser = new SimpleCronParser();
      const result = parser.getNextTime("0 9 * * *", "UTC");

      // 下次触发应该是 2026-07-22T09:00:00Z
      expect(result.getFullYear()).toBe(2026);
      expect(result.getMonth()).toBe(6); // 7 月 = 6（零索引）
      expect(result.getDate()).toBe(22);
      expect(result.getUTCHours()).toBe(9);
      expect(result.getUTCMinutes()).toBe(0);
    });

    it("分钟级 cron 表达式正确计算下次时间", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-22T10:15:00Z"));

      const parser = new SimpleCronParser();
      const result = parser.getNextTime("*/30 * * * *", "UTC");

      // 当前 10:15，下次 30 分钟触发应为 10:30
      expect(result.getUTCHours()).toBe(10);
      expect(result.getUTCMinutes()).toBe(30);
    });
  });
});
