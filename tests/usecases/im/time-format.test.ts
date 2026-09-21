import { describe, it, expect } from "vitest";
import { fmtImTime, DISPLAY_TIMEZONE } from "@usecases/im/time-format";

describe("fmtImTime", () => {
  it("正常 UTC ISO 转为 Asia/Shanghai 的 YYYY-MM-DD HH:mm", () => {
    // UTC 2026-09-20 06:30 = Shanghai 14:30（+8）
    expect(fmtImTime("2026-09-20T06:30:00Z")).toBe("2026-09-20 14:30");
  });

  it("跨日边界：UTC 16:00 = Shanghai 次日 00:00（+8 溢出验证）", () => {
    expect(fmtImTime("2026-09-19T16:00:00Z")).toBe("2026-09-20 00:00");
  });

  it("跨年边界：UTC 12-31 16:30 = Shanghai 次年 01-01 00:30", () => {
    expect(fmtImTime("2025-12-31T16:30:00Z")).toBe("2026-01-01 00:30");
  });

  it("结果与测试机进程时区无关（服务器任意时区部署均输出 Shanghai 时间）", () => {
    // 语义验证：无论 TZ 环境变量是什么（CI/部署机可能非 Asia/Shanghai），
    // 输出恒为 Shanghai 时间——这是 C 类修复的核心承诺
    const savedTz = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      expect(fmtImTime("2026-09-20T06:30:00Z")).toBe("2026-09-20 14:30");
      process.env.TZ = "UTC";
      expect(fmtImTime("2026-09-20T06:30:00Z")).toBe("2026-09-20 14:30");
    } finally {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    }
  });

  it("空字符串返回空字符串", () => {
    expect(fmtImTime("")).toBe("");
  });

  it("无效日期返回原字符串（防御语义与前端 fmtTime 系一致）", () => {
    expect(fmtImTime("not-a-date")).toBe("not-a-date");
  });

  it("DISPLAY_TIMEZONE 锚定 Asia/Shanghai", () => {
    expect(DISPLAY_TIMEZONE).toBe("Asia/Shanghai");
  });
});
