import { describe, it, expect } from "vitest";
import { parseCommit, parseCommits } from "@usecases/health/commit-parser";

describe("CommitParser", () => {
  describe("parseCommit", () => {
    it("should parse standard format commit", () => {
      const result = parseCommit(
        "abc123",
        "[F20260824rhib][health][New Feature] RHI 系统健康监控面板 (#409)"
      );

      expect(result.sha).toBe("abc123");
      expect(result.featureId).toBe("F20260824rhib");
      expect(result.module).toBe("health");
      expect(result.changeType).toBe("New Feature");
      expect(result.prNumber).toBe(409);
      expect(result.isCompliant).toBe(true);
      expect(result.skipReason).toBeUndefined();
    });

    it("should parse BugFix format", () => {
      const result = parseCommit(
        "def456",
        "[F20260824abcd][agent][BugFix] 修复 agent 崩溃问题 (#410)"
      );

      expect(result.featureId).toBe("F20260824abcd");
      expect(result.module).toBe("agent");
      expect(result.changeType).toBe("BugFix");
      expect(result.prNumber).toBe(410);
      expect(result.isCompliant).toBe(true);
    });

    it("should parse Feature Update format", () => {
      const result = parseCommit(
        "ghi789",
        "[F20260824abcd][memory][Feature Update] 优化记忆检索 (#411)"
      );

      expect(result.featureId).toBe("F20260824abcd");
      expect(result.module).toBe("memory");
      expect(result.changeType).toBe("Feature Update");
      expect(result.prNumber).toBe(411);
      expect(result.isCompliant).toBe(true);
    });

    it("should handle merge commit", () => {
      const result = parseCommit(
        "jkl012",
        "Merge branch 'feature/rhi-mvp' into main"
      );

      expect(result.isCompliant).toBe(false);
      expect(result.skipReason).toBe("merge_commit");
      expect(result.featureId).toBeNull();
    });

    it("should handle fixup commit", () => {
      const result = parseCommit(
        "mno345",
        "fixup! [F20260824rhib][health][New Feature] RHI 系统健康监控面板"
      );

      expect(result.isCompliant).toBe(false);
      expect(result.skipReason).toBe("fixup_commit");
    });

    it("should handle init commit", () => {
      const result = parseCommit(
        "pqr678",
        "init: bootstrap project"
      );

      expect(result.isCompliant).toBe(false);
      expect(result.skipReason).toBe("init_commit");
    });

    it("should handle Revert commit", () => {
      const result = parseCommit(
        "stu901",
        'Revert "[F20260824rhib][health][New Feature] RHI 系统健康监控面板"'
      );

      expect(result.isCompliant).toBe(false);
      expect(result.skipReason).toBe("revert_commit");
    });

    it("should handle R document header", () => {
      const result = parseCommit(
        "vwx234",
        "[R20260824abcd][research] 技术调研报告"
      );

      expect(result.isCompliant).toBe(false);
      expect(result.skipReason).toBe("research_document");
    });

    it("should handle non-standard format with F prefix", () => {
      const result = parseCommit(
        "yza567",
        "[F20260824abcd] 简单标题 (#412)"
      );

      expect(result.featureId).toBe("F20260824abcd");
      expect(result.prNumber).toBe(412);
      expect(result.isCompliant).toBe(false);
      expect(result.skipReason).toBe("non_standard_format");
    });

    it("should handle commit without F prefix", () => {
      const result = parseCommit(
        "bcd890",
        "一些普通提交"
      );

      expect(result.isCompliant).toBe(false);
      expect(result.skipReason).toBe("no_f_prefix");
      expect(result.featureId).toBeNull();
    });

    it("should handle commit with hyphenated module", () => {
      const result = parseCommit(
        "efg123",
        "[F20260824abcd][agent-runtime][New Feature] 新功能 (#413)"
      );

      // 模块段含连字符，但 regex 允许，所以是合规的
      expect(result.featureId).toBe("F20260824abcd");
      expect(result.module).toBe("agent-runtime");
      expect(result.isCompliant).toBe(true);
    });

    it("should handle commit with numeric module", () => {
      const result = parseCommit(
        "hij456",
        "[F20260824abcd][agent2][New Feature] 新功能 (#414)"
      );

      // 模块段含数字，不匹配严格三段格式（数字不在 [a-z][a-z-]* 中）
      expect(result.featureId).toBe("F20260824abcd");
      expect(result.module).toBeNull();
      expect(result.isCompliant).toBe(false);
      expect(result.skipReason).toBe("non_standard_format");
    });

    // #667 回归：后缀含 0/1/l/o 的存量真实 ID 曾被旧字母表正则漏判 no_f_prefix
    it.each([
      ["F20260827mtbl", "[F20260827mtbl][db][BugFix] 存量库补建 (#548)"],
      ["F20260826scl1", "[F20260826scl1][scripts][New Feature] PR1: 股票数据桥 (#465)"],
      ["F20260826o46s", "[F20260826o46s][prompt][Feature Update] 卡住主动汇报 (#468)"],
    ])(
      "后缀含 0/1/l/o 的真实 ID %s 可解析",
      (fid, message) => {
        const result = parseCommit("lmn789", message);

        expect(result.featureId).toBe(fid);
        expect(result.isCompliant).toBe(true);
      }
    );
  });

  describe("parseCommits", () => {
    it("should parse multiple commits", () => {
      const commits = [
        {
          sha: "abc123",
          message: "[F20260824rhib][health][New Feature] RHI 系统健康监控面板 (#409)",
        },
        {
          sha: "def456",
          message: "Merge branch 'main' into feature/rhi-mvp",
        },
        {
          sha: "ghi789",
          message: "[F20260824abcd][agent][BugFix] 修复问题 (#410)",
        },
      ];

      const results = parseCommits(commits);

      expect(results).toHaveLength(3);
      expect(results[0].isCompliant).toBe(true);
      expect(results[1].isCompliant).toBe(false);
      expect(results[1].skipReason).toBe("merge_commit");
      expect(results[2].isCompliant).toBe(true);
    });
  });
});
