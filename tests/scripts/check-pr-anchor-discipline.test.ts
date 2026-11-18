/**
 * check-pr-anchor-discipline 机械闸测试（注释编号禁绝）。
 *
 * 覆盖：词法状态机（字符串/模板/块注释边界）、跨行块注释、轮次判据（孤立序号命中 +
 * 技术词豁免）、issue 色值豁免、quoted path、纯删除、读文件失败 fail-closed、CSS 覆盖。
 * 自噬防御：测试数据里「注释导引符 + 编号」连续形态全部运行时拼接，源码不出现完整序列。
 */
import { describe, it, expect } from "vitest";
import {
  isExcludedPath,
  isSupportedCodePath,
  isCssLikeLang,
  collectAnchorViolations,
  scanTsLine,
  scanHashLine,
  annotateFile,
  decodeCQuotedPath,
  parseDiffAddedLines,
  checkDiff,
} from "../../scripts/check-pr-anchor-discipline.mjs";

// 运行时拼接：源码不出现完整连续形态
const fid = () => ["F", "20261118", "banch"].join("");
const rFid = () => ["R", "20261118", "rvcls"].join("");
const sl = () => ["/", "/"].join(""); // "//"
const hash = () => "#";

describe("isExcludedPath / isSupportedCodePath", () => {
  it("排除与支持语言", () => {
    expect(isExcludedPath("docs/features/2026/11/18/x.md")).toBe(true);
    expect(isExcludedPath("dist/src/app.d.ts")).toBe(true);
    expect(isExcludedPath("package-lock.json")).toBe(true);
    expect(isExcludedPath("docs/README.md")).toBe(true);
    expect(isExcludedPath("src/app.ts")).toBe(false);
    expect(isSupportedCodePath("src/app.ts")).toBe(true);
    expect(isSupportedCodePath(".github/workflows/ci.yml")).toBe(true);
    expect(isSupportedCodePath("web/index.html")).toBe(true);
    expect(isSupportedCodePath("web/styles/globals.css")).toBe(true);
    expect(isCssLikeLang("web/styles/globals.css")).toBe(true);
    expect(isSupportedCodePath("src/foo.json")).toBe(false);
  });
});

describe("collectAnchorViolations 三类编号", () => {
  it("特性编号（新写与历史形态）", () => {
    const v = collectAnchorViolations(`见 ${fid()} 和 ${rFid()}`);
    const tokens = v.filter((x) => x.kind === "特性编号").map((x) => x.token);
    expect(tokens).toContain(fid());
    expect(tokens).toContain(rFid());
  });

  it("issue 编号命中；hex 色值（字母与纯数字）豁免", () => {
    expect(collectAnchorViolations(`见 ${hash()}1911 与 ${hash()}2`).some((x) => x.kind === "issue 编号")).toBe(true);
    expect(collectAnchorViolations("色值 #fff").some((x) => x.kind === "issue 编号")).toBe(false);
    expect(collectAnchorViolations("色值 #123").some((x) => x.kind === "issue 编号")).toBe(false);
    expect(collectAnchorViolations("色值 #123456").some((x) => x.kind === "issue 编号")).toBe(false);
    expect(collectAnchorViolations("region 分组").some((x) => x.kind === "issue 编号")).toBe(false);
  });

  it("轮次编号：中文动作词 / round / 第N轮 / 孤立单字母序号命中", () => {
    expect(collectAnchorViolations("检视建议 5").some((x) => x.kind === "轮次编号")).toBe(true);
    expect(collectAnchorViolations("round-2 修复").some((x) => x.kind === "轮次编号")).toBe(true);
    expect(collectAnchorViolations("第 2 轮复审").some((x) => x.kind === "轮次编号")).toBe(true);
    expect(collectAnchorViolations("检视轮次 2").some((x) => x.kind === "轮次编号")).toBe(true);
    expect(collectAnchorViolations("S1 修复").some((x) => x.kind === "轮次编号")).toBe(true);
    expect(collectAnchorViolations("r2 处置后").some((x) => x.kind === "轮次编号")).toBe(true);
    // 孤立单字母序号仍禁（S1 / R10 / N2）
    expect(collectAnchorViolations("S1").some((x) => x.kind === "轮次编号" && x.token === "S1")).toBe(true);
    expect(collectAnchorViolations("R10").some((x) => x.kind === "轮次编号" && x.token === "R10")).toBe(true);
  });

  it("技术词豁免：M1/M2 芯片、S3 存储、A4 纸；流程描述不误伤", () => {
    const v = collectAnchorViolations("M1 与 M2 芯片均兼容，对象存入 S3 后异步处理，A4 纸张，发现 3 处差异，建议采用");
    expect(v).toEqual([]);
  });
});

describe("scanTsLine 词法状态机", () => {
  it("字符串里的 // 与 URL 不是注释", () => {
    expect(scanTsLine(`const u = "https://example.test/x";`).comment).toBeNull();
    expect(scanTsLine(`const u = 'a // b';`).comment).toBeNull();
  });

  it("模板字符串内容不是注释，表达式结束后的行注释是注释", () => {
    expect(scanTsLine(`const s = \`\${name} // ${fid()}\`;`).comment).toBeNull();
    expect(scanTsLine(`const s = \`\${name}\`; ${sl()} 注释`).comment).toBe(`${sl()} 注释`);
  });

  it("单行块注释只取到 */ 为止，其后字符串不纳入", () => {
    const r = scanTsLine(`/* clean */ const design = "${fid()}";`);
    expect(r.comment).toBe("/* clean */");
  });

  it("行注释与块注释正确识别", () => {
    expect(scanTsLine(`const x = 1; ${sl()} 注释`).comment).toBe(`${sl()} 注释`);
    expect(scanTsLine(`/* 块注释开`).comment).toBe(`/* 块注释开`);
    expect(scanTsLine(`/* 块注释开`).opensBlock).toBe(true);
  });
});

describe("scanHashLine 词法", () => {
  it("引号内 # 与裸 URL 中 # 不是注释，行首/空白后 # 是注释", () => {
    expect(scanHashLine(`url: "https://x.test/${hash()}1937"`).comment).toBeNull();
    expect(scanHashLine(`url: https://x.test/${hash()}1937`).comment).toBeNull();
    expect(scanHashLine(`key: value ${hash()} 注释`).comment).toBe(`${hash()} 注释`);
    expect(scanHashLine(`${hash()} 行首注释`).comment).toBe(`${hash()} 行首注释`);
  });
});

describe("annotateFile 全文标注", () => {
  it("跨行块注释（无星号正文行）标为注释", () => {
    const lines = ["/*", `  无星号正文引用 ${fid()}`, "*/", "const ok = 1;"].join("\n");
    const ann = annotateFile(lines, "src/a.ts");
    expect(ann[1]).toContain("无星号正文引用");
    expect(ann[3]).toBeNull();
  });

  it("Python 三引号字符串跨行正文不标为注释", () => {
    const lines = [`text = """`, `${hash()}1937`, `"""`].join("\n");
    const ann = annotateFile(lines, "src/a.py");
    expect(ann[0]).toBeNull();
    expect(ann[1]).toBeNull();
    expect(ann[2]).toBeNull();
  });

  it("CSS 块注释标为注释", () => {
    const lines = [`/* 见 ${fid()} */`, "body { color: red; }"].join("\n");
    const ann = annotateFile(lines, "web/a.css");
    expect(ann[0]).toContain("/*");
    expect(ann[1]).toBeNull();
  });
});

describe("decodeCQuotedPath", () => {
  it("八进制字节序列按 UTF-8 还原中文", () => {
    expect(decodeCQuotedPath("\\350\\257\\264\\346\\230\\216.ts")).toBe("说明.ts");
  });
});

describe("parseDiffAddedLines", () => {
  it("标准 hunk 行号：删除行不推进新文件行号", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,2 +10,3 @@",
      "+new A",
      "+new B",
      "-old",
      "+new C",
    ].join("\n");
    const { added } = parseDiffAddedLines(diff);
    expect(added.map((x) => x.line)).toEqual([10, 11, 12]);
  });

  it("quoted path 解码后归到正确文件", () => {
    const diff = [
      'diff --git "a/src/\\350\\257\\264\\346\\230\\216.ts" "b/src/\\350\\257\\264\\346\\230\\216.ts"',
      '--- "a/src/\\350\\257\\264\\346\\230\\216.ts"',
      '+++ "b/src/\\350\\257\\264\\346\\230\\216.ts"',
      "@@ -0,0 +1,1 @@",
      `+${sl()} 见 ${fid()} 的决策`,
    ].join("\n");
    const { added } = parseDiffAddedLines(diff);
    expect(added).toHaveLength(1);
    expect(added[0].path).toBe("src/说明.ts");
  });
});

describe("checkDiff 集成（readFileFn 注入）", () => {
  const mk = (files: Record<string, string>) => (p: string) => files[p] ?? "";

  it("字符串字面量里的 URL 与井号不误判", () => {
    const content = [
      `const design = "https://example.test/${fid()}";`,
      `const issueURL = "https://example.test/${hash()}1937";`,
    ].join("\n");
    const diff = [
      "diff --git a/src/normal.ts b/src/normal.ts",
      "--- a/src/normal.ts",
      "+++ b/src/normal.ts",
      "@@ -0,0 +1,2 @@",
      `+${content.split("\n")[0]}`,
      `+${content.split("\n")[1]}`,
    ].join("\n");
    const { violations } = checkDiff(diff, mk({ "src/normal.ts": content }));
    expect(violations).toEqual([]);
  });

  it("无星号块注释正文仍命中", () => {
    const content = ["/*", `  无星号正文引用 ${fid()}`, "*/"].join("\n");
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,0 +2,1 @@",
      `+  无星号正文引用 ${fid()}`,
    ].join("\n");
    const { violations } = checkDiff(diff, mk({ "src/a.ts": content }));
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("特性编号");
  });

  it("模板字符串内容不误报、模板后行注释命中", () => {
    const content = [
      `const s = \`\${name} // ${fid()}\`;`,
      `const t = \`\${name}\`; ${sl()} ${hash()}1937`,
    ].join("\n");
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -0,0 +1,2 @@",
      `+${content.split("\n")[0]}`,
      `+${content.split("\n")[1]}`,
    ].join("\n");
    const { violations } = checkDiff(diff, mk({ "src/a.ts": content }));
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("issue 编号");
  });

  it("M1/S3 技术词豁免、孤立 S1 命中、round 形态命中", () => {
    const content = [
      `${sl()} M1 与 S3 存储兼容`,
      `${sl()} round-2 修复后保留终态`,
      `${sl()} S1`,
    ].join("\n");
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -0,0 +1,3 @@",
      `+${sl()} M1 与 S3 存储兼容`,
      `+${sl()} round-2 修复后保留终态`,
      `+${sl()} S1`,
    ].join("\n");
    const { violations } = checkDiff(diff, mk({ "src/a.ts": content }));
    expect(violations).toHaveLength(2);
    const tokens = violations.map((x) => x.token);
    expect(tokens.some((t) => t.includes("round"))).toBe(true);
    expect(tokens).toContain("S1");
  });

  it("纯删除变更放行", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +0,0 @@",
      `-${sl()} 旧注释`,
    ].join("\n");
    const { addedTotal, diffNonEmpty, violations } = checkDiff(diff, mk({}));
    expect(diffNonEmpty).toBe(true);
    expect(addedTotal).toBe(0);
    expect(violations).toEqual([]);
  });

  it("HTML 注释命中", () => {
    const content = [`<!-- 见 ${fid()} 与 ${hash()}1937 -->`].join("\n");
    const diff = [
      "diff --git a/web/index.html b/web/index.html",
      "--- a/web/index.html",
      "+++ b/web/index.html",
      "@@ -0,0 +1,1 @@",
      `+<!-- 见 ${fid()} 与 ${hash()}1937 -->`,
    ].join("\n");
    const { violations } = checkDiff(diff, mk({ "web/index.html": content }));
    expect(violations.length).toBeGreaterThanOrEqual(2);
  });

  it("CSS 块注释命中", () => {
    const content = [`/* 见 ${fid()} */`].join("\n");
    const diff = [
      "diff --git a/web/a.css b/web/a.css",
      "--- a/web/a.css",
      "+++ b/web/a.css",
      "@@ -0,0 +1,1 @@",
      `+/* 见 ${fid()} */`,
    ].join("\n");
    const { violations } = checkDiff(diff, mk({ "web/a.css": content }));
    expect(violations).toHaveLength(1);
  });

  it("支持代码文件读取失败时抛错（fail-closed）", () => {
    const diff = [
      "diff --git a/src/ghost.ts b/src/ghost.ts",
      "--- a/src/ghost.ts",
      "+++ b/src/ghost.ts",
      "@@ -0,0 +1,1 @@",
      `+${sl()} ${fid()}`,
    ].join("\n");
    expect(() => checkDiff(diff, () => { throw new Error("ENOENT"); })).toThrow(/读取文件失败/);
  });

  it("空 diff 无变更 → diffNonEmpty false", () => {
    const { diffNonEmpty } = checkDiff("", mk({}));
    expect(diffNonEmpty).toBe(false);
  });
});