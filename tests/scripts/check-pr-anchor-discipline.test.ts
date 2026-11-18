/**
 * check-pr-anchor-discipline 机械闸测试（注释编号禁绝）。
 *
 * 覆盖：diff 解析行号 / 注释提取 / 三类编号命中 / 误伤负例 / 排除路径与空判定面。
 * 注：本测试文件是闸自身新增行的一部分——测试数据里「注释导引符 + 编号」的连续形态
 * 全部运行时拼接构造，避免闸在 CI 中自噬本文件。
 */
import { describe, it, expect } from "vitest";
import {
  isExcludedPath,
  extractCommentText,
  collectAnchorViolations,
  parseDiffAddedLines,
  checkDiff,
} from "../../scripts/check-pr-anchor-discipline.mjs";

// 运行时拼接编号，源码不出现完整连续形态
const newFid = () => ["F", "20261118", "banch"].join("");
const rFid = () => ["R", "20261118", "rvcls"].join("");
const legacyFid = () => ["F", "20260928", "fsqr"].join("");

describe("isExcludedPath 排除口径", () => {
  it("特性文档/dist/生成文件/markdown 排除；代码与工作流纳入", () => {
    expect(isExcludedPath("docs/features/2026/11/18/x.md")).toBe(true);
    expect(isExcludedPath("dist/src/app.d.ts")).toBe(true);
    expect(isExcludedPath("src/app.d.ts")).toBe(true);
    expect(isExcludedPath("package-lock.json")).toBe(true);
    expect(isExcludedPath("docs/README.md")).toBe(true);
    expect(isExcludedPath("src/app.ts")).toBe(false);
    expect(isExcludedPath(".github/workflows/ci.yml")).toBe(false);
    expect(isExcludedPath("scripts/check-x.mjs")).toBe(false);
  });
});

describe("extractCommentText 注释提取", () => {
  it("TS 行注释与行尾注释", () => {
    expect(extractCommentText("// 单行注释", false)).toBe("// 单行注释");
    expect(extractCommentText("const x = 1; // 行尾注释", false)).toBe("// 行尾注释");
    expect(extractCommentText("const x = 1;", false)).toBeNull();
  });

  it("块注释开闭与 body 行导引符", () => {
    expect(extractCommentText("/* 块注释", false)).toBe("/* 块注释");
    expect(extractCommentText(" * body 行", false)).toBe(" * body 行");
    expect(extractCommentText(" */", false)).toBe(" */");
  });

  it("yml 井号注释", () => {
    expect(extractCommentText("# 配置说明", true)).toBe("# 配置说明");
    expect(extractCommentText("key: value # 行尾注释", true)).toBe("# 行尾注释");
    expect(extractCommentText("key: value", true)).toBeNull();
  });
});

describe("collectAnchorViolations 三类编号命中", () => {
  it("特性编号（新写与历史形态）", () => {
    const v = collectAnchorViolations(`见 ${newFid()} 和 ${rFid()} 及旧形态 ${legacyFid()}`);
    const tokens = v.filter((x) => x.kind === "特性编号").map((x) => x.token);
    expect(tokens).toContain(newFid());
    expect(tokens).toContain(rFid());
    expect(tokens).toContain(legacyFid());
  });

  it("issue 编号；十六进制色与 region 指令不误伤", () => {
    expect(collectAnchorViolations("见 [hash]1911 与 [hash]2".replace(/\[hash\]/g, "#")).some((x) => x.kind === "issue 编号")).toBe(true);
    expect(collectAnchorViolations("#region 分组").some((x) => x.kind === "issue 编号")).toBe(false);
    expect(collectAnchorViolations("色值 #fff").some((x) => x.kind === "issue 编号")).toBe(false);
  });

  it("轮次编号：单字母序号 / 中文动作词短语 / delta 短语", () => {
    expect(collectAnchorViolations("检视建议 5").some((x) => x.kind === "轮次编号")).toBe(true);
    expect(collectAnchorViolations("审视修复 R10").some((x) => x.kind === "轮次编号")).toBe(true);
    expect(collectAnchorViolations("严重发现 1 配套").some((x) => x.kind === "轮次编号")).toBe(true);
    expect(collectAnchorViolations("单字母 S1 独立令牌").some((x) => x.kind === "轮次编号")).toBe(true);
  });

  it("普通词不误伤：MP3/H264/机制名/数字短语/流程描述", () => {
    const v = collectAnchorViolations("MP3 解码与 H264 编码，检视闭环机械闸，发现 3 处差异，建议采用，delta 复核后更新");
    expect(v).toEqual([]);
  });
});

describe("parseDiffAddedLines 解析行号", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,2 +10,3 @@",
    "+nexiline A",
    "+newline B",
    "-oldline",
    "+newline C",
  ].join("\n");
  it("行号从 hunk +10 起，删除行不推进新文件行号", () => {
    const added = parseDiffAddedLines(diff);
    expect(added).toEqual([
      { path: "src/a.ts", line: 10, content: "nexiline A" },
      { path: "src/a.ts", line: 11, content: "newline B" },
      { path: "src/a.ts", line: 12, content: "newline C" },
    ]);
  });
});

describe("checkDiff 集成判定", () => {
  it("注释行命中编号、代码行不命中、特性文档排除", () => {
    const plus = "+";
    const sl = "/";
    const slash = ["", sl, sl].join(""); // 运行时构造注释导引符
    const commentHit = `${plus}${slash} 见 ${newFid()} 处理`;
    const docLine = `${plus}id: ${newFid()}`;
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -0,0 +1,2 @@",
      commentHit,
      `${plus}const ok = 1;`,
      "diff --git a/docs/features/2026/11/18/x.md b/docs/features/2026/11/18/x.md",
      "--- a/docs/features/2026/11/18/x.md",
      "+++ b/docs/features/2026/11/18/x.md",
      "@@ -0,0 +1,1 @@",
      docLine,
    ].join("\n");
    const { addedTotal, violations } = checkDiff(diff);
    expect(addedTotal).toBeGreaterThan(0);
    expect(violations).toHaveLength(1);
    expect(violations[0].path).toBe("src/a.ts");
    expect(violations[0].kind).toBe("特性编号");
  });

  it("空 diff 无新增行 → addedTotal 0（拒判由 main 层处理）", () => {
    const { addedTotal, violations } = checkDiff("");
    expect(addedTotal).toBe(0);
    expect(violations).toEqual([]);
  });
});