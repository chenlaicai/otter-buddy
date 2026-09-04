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

    // #671 回归：白名单 3→5 种，Refactor/Design 曾被误判 non_standard_format
    it.each([
      ["Refactor", "F20260903sdcp", "[F20260903sdcp][skills][Refactor] _shared 目录拆解 (#772)"],
      ["Design", "F20260826mwrd", "[F20260826mwrd][agent][Design] Magic Words 本地化重审与獭间信号协议设计文档 (#492)"],
    ])("白名单类型 %s 解析为合规", (type, fid, message) => {
      const result = parseCommit("pqr111", message);

      expect(result.isCompliant).toBe(true);
      expect(result.changeType).toBe(type);
      expect(result.featureId).toBe(fid);
    });

    // #671 / #425 发现 7：三段结构完整但类型未识别 → unrecognized_change_type（非 non_standard_format）
    it.each([
      ["[F20260901dstat][health][Feature] 文档状态自动推进 (#659)"],
      ["[F20260828c4sg][agent][Enhancement] halt 断言改轮询 (#562)"],
      ["[F20260903lcyc][conversation][Tests] R5 生命周期回放判据 (#761)"],
    ])("历史别名/未知类型 → unrecognized_change_type: %s", (message) => {
      const result = parseCommit("stu222", message);

      expect(result.isCompliant).toBe(false);
      expect(result.featureId).toMatch(/^F\d{8}[a-z0-9]{4,10}$/);
      expect(result.module).not.toBeNull();
      expect(result.changeType).toBeNull();
      expect(result.skipReason).toBe("unrecognized_change_type");
    });

    // 缺类型段的格式不合规仍归 non_standard_format，与新 skipReason 区分（#425 发现 7）
    it("缺类型段的非标格式仍报 non_standard_format", () => {
      const result = parseCommit("vwx333", "[F20260824abcd] 简单标题 (#412)");

      expect(result.isCompliant).toBe(false);
      expect(result.skipReason).toBe("non_standard_format");
    });

    // #425 建议 2：FeatureUpdate 无空格笔误归一化为 Feature Update
    it("FeatureUpdate 笔误归一化为 Feature Update 且合规", () => {
      const result = parseCommit(
        "yzc444",
        "[F20260901abcd][memory][FeatureUpdate] 优化记忆检索 (#411)"
      );

      expect(result.isCompliant).toBe(true);
      expect(result.changeType).toBe("Feature Update");
    });

    it("大小写不匹配的笔误（featureupdate）不归一化，归 unrecognized_change_type", () => {
      const result = parseCommit(
        "abb555",
        "[F20260901abcd][memory][featureupdate] 优化记忆检索 (#411)"
      );

      expect(result.isCompliant).toBe(false);
      expect(result.skipReason).toBe("unrecognized_change_type");
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
