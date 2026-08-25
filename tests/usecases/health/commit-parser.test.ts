import { describe, it, expect, vi } from "vitest";
import { CommitParser } from "@usecases/health/commit-parser";

describe("CommitParser", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const parser = new CommitParser(logger as any);

  describe("parse", () => {
    it("should parse strict three-segment format", () => {
      const message = "[F20260824rhib][health][New Feature] RHI Issue #394: 数据采集器实现";
      const result = parser.parse(message);

      expect(result.isValid).toBe(true);
      expect(result.fid).toBe("F20260824rhib");
      expect(result.module).toBe("health");
      expect(result.changeType).toBe("New Feature");
      expect(result.prNumber).toBe(394);
      expect(result.skipReason).toBeUndefined();
    });

    it("should parse strict format with PR number", () => {
      const message = "[F20260824rhib][health][New Feature] RHI Issue #394: 数据采集器实现 (#415)";
      const result = parser.parse(message);

      expect(result.isValid).toBe(true);
      expect(result.fid).toBe("F20260824rhib");
      expect(result.prNumber).toBe(394);
    });

    it("should parse loose format", () => {
      const message = "F20260824rhib RHI Issue #394: 数据采集器实现";
      const result = parser.parse(message);

      expect(result.isValid).toBe(true);
      expect(result.fid).toBe("F20260824rhib");
      expect(result.module).toBeNull();
      expect(result.changeType).toBeNull();
      expect(result.skipReason).toBe("loose_format");
    });

    it("should skip revert commits", () => {
      const message = "Revert \"RHI Issue #394: 数据采集器实现\"";
      const result = parser.parse(message);

      expect(result.isValid).toBe(false);
      expect(result.skipReason).toBe("revert_commit");
    });

    it("should skip init commits", () => {
      const message = "init project";
      const result = parser.parse(message);

      expect(result.isValid).toBe(false);
      expect(result.skipReason).toBe("init_commit");
    });

    it("should skip merge commits", () => {
      const message = "Merge branch 'main' into feature/rhi-mvp";
      const result = parser.parse(message);

      expect(result.isValid).toBe(false);
      expect(result.skipReason).toBe("merge_commit");
    });

    it("should skip FID-only commits", () => {
      const message = "F20260824rhib";
      const result = parser.parse(message);

      expect(result.isValid).toBe(false);
      expect(result.skipReason).toBe("fid_only_no_message");
    });

    it("should mark unparseable commits", () => {
      const message = "some random commit message";
      const result = parser.parse(message);

      expect(result.isValid).toBe(false);
      expect(result.skipReason).toBe("unparseable");
    });
  });

  describe("parseBatch", () => {
    it("should parse multiple messages", () => {
      const messages = [
        "[F20260824rhib][health][New Feature] RHI Issue #394: 数据采集器实现",
        "Revert \"RHI Issue #394: 数据采集器实现\"",
        "F20260824rhib RHI Issue #394: 数据采集器实现",
        "some random commit message",
      ];

      const results = parser.parseBatch(messages);

      expect(results).toHaveLength(4);
      expect(results[0].isValid).toBe(true);
      expect(results[1].isValid).toBe(false);
      expect(results[2].isValid).toBe(true);
      expect(results[3].isValid).toBe(false);
    });
  });
});
