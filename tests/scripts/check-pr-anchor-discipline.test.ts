/**
 * check-pr-anchor-discipline 机械闸测试（注释编号禁绝）。
 *
 * 覆盖：TS 编译器级词法（模板/跨行块注释）、轮次判据（孤立序号命中 + 技术词豁免）、
 * issue 全拦截（色值不豁免）、Hash 语言各自注释规则、CSS/SCSS、quoted path、纯删除、
 * 读文件失败 fail-closed。自噬防御：测试数据「注释导引符 + 编号」连续形态运行时拼接。
 */
import { describe, it, expect } from "vitest";
import {
  isExcludedPath,
  isSupportedCodePath,
  isCssLikeLang,
  collectAnchorViolations,
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
    expect(isCssLikeLang("web/styles/globals.scss")).toBe(true);
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

  it("issue 编号全拦截：长短号与 hex 形态均算，region 折叠指令豁免", () => {
    expect(collectAnchorViolations(`见 ${hash()}1911 与 ${hash()}2`).some((x) => x.kind === "issue 编号")).toBe(true);
    expect(collectAnchorViolations(`修复见 ${hash()}123`).some((x) => x.kind === "issue 编号")).toBe(true);
    expect(collectAnchorViolations(`修复见 ${hash()}123456`).some((x) => x.kind === "issue 编号")).toBe(true);
    expect(collectAnchorViolations(`// ${hash()}region 分组`).some((x) => x.kind === "issue 编号")).toBe(false);
    expect(collectAnchorViolations(`// ${hash()}endregion`).some((x) => x.kind === "issue 编号")).toBe(false);
  });

  it("轮次编号：中文动作词 / round / 第N轮 / 孤立单字母序号命中", () => {
    expect(collectAnchorViolations("检视建议 5").some((x) => x.kind === "轮次编号")).toBe(true);
    expect(collectAnchorViolations("round-2 修复").some((x) => x.kind === "轮次编号")).toBe(true);
    expect(collectAnchorViolations("第 2 轮复审").some((x) => x.kind === "轮次编号")).toBe(true);
    expect(collectAnchorViolations("检视轮次 2").some((x) => x.kind === "轮次编号")).toBe(true);
    expect(collectAnchorViolations("S1 修复").some((x) => x.kind === "轮次编号")).toBe(true);
    expect(collectAnchorViolations("r2 处置后").some((x) => x.kind === "轮次编号")).toBe(true);
    expect(collectAnchorViolations("S1").some((x) => x.kind === "轮次编号" && x.token === "S1")).toBe(true);
    expect(collectAnchorViolations("R10").some((x) => x.kind === "轮次编号" && x.token === "R10")).toBe(true);
  });

  it("技术词豁免：M1/M2 芯片、S3 存储、A4 纸；流程描述不误伤", () => {
    const v = collectAnchorViolations("M1 与 M2 芯片均兼容，对象存入 S3 后异步处理，A4 纸张，发现 3 处差异，建议采用");
    expect(v).toEqual([]);
  });
});

describe("annotateFile TS 编译器级词法", () => {
  it("模板字符串跨行内容不是注释，模板后行注释是注释", () => {
    const src = ["const s = `", `${sl()} ${fid()}`, "`;", `const t = \`x\`; ${sl()} ${hash()}1937`].join("\n");
    const ann = annotateFile(src, "src/a.ts");
    expect(ann[0]).toBeNull();
    expect(ann[1]).toBeNull(); // 模板正文第二行非注释
    expect(ann[2]).toBeNull();
    expect(ann[3]).toContain(hash()); // 模板后真行注释
  });

  it("多行块注释闭合行后的字符串不误伤", () => {
    const src = ["/*", "*/", `const design = "${fid()}";`].join("\n");
    const ann = annotateFile(src, "src/a.ts");
    expect(ann[0]).toContain("/*");
    expect(ann[1]).toContain("*/");
    expect(ann[2]).toBeNull(); // 闭合行后的字符串
  });

  it("单行块注释只取闭合标记，其后字符串不纳入", () => {
    const ann = annotateFile(`/* clean */ const design = "${fid()}";`, "src/a.ts");
    expect(ann[0]).toBe("/* clean */");
  });

  it("同行多个注释合并，违规在前或后都命中", () => {
    const a = annotateFile(`/* ${fid()} */ /* clean */`, "src/a.ts");
    expect(a[0]).toContain(fid());
    const b = annotateFile(`/* clean */ /* ${fid()} */`, "src/a.ts");
    expect(b[0]).toContain(fid());
  });

  it("字符串字面量里的 URL 不是注释", () => {
    const ann = annotateFile(`const u = "https://example.test/${fid()}";`, "src/a.ts");
    expect(ann[0]).toBeNull();
  });
});

describe("annotateFile Hash 语言各自规则", () => {
  it("YAML：空白后 # 是注释，裸 URL 内 # 不是，块标量正文不是注释", () => {
    expect(annotateFile(`url: https://x.test/${hash()}1937`, "a.yml")[0]).toBeNull();
    expect(annotateFile(`key: value ${hash()} 注释`, "a.yml")[0]).toBe(`${hash()} 注释`);
    const src = [`description: |`, `  ${hash()}1937 正文`, `key: v ${hash()} 注释`].join("\n");
    const ann = annotateFile(src, "a.yml");
    expect(ann[1]).toBeNull(); // 块标量正文
    expect(ann[2]).toBe(`${hash()} 注释`);
  });

  it("Python：行内 # 是注释（无需空白），三引号正文跳过，注释里三引号不破坏状态", () => {
    expect(annotateFile(`x=1${hash()}1937`, "a.py")[0]).toBe(`${hash()}1937`);
    const src = [`text = """`, `${hash()}1937`, `"""`, `x=1${hash()}9`].join("\n");
    const ann = annotateFile(src, "a.py");
    expect(ann[0]).toBeNull();
    expect(ann[1]).toBeNull();
    expect(ann[2]).toBeNull();
    expect(ann[3]).toBe(`${hash()}9`);
    const src2 = [`${hash()} 三引号 """ 写法`, `${hash()}1937`].join("\n");
    const ann2 = annotateFile(src2, "a.py");
    expect(ann2[0]).toContain(`"""`);
    expect(ann2[1]).toBe(`${hash()}1937`);
  });

  it("Shell：控制运算符后 # 是注释，heredoc 正文不是注释", () => {
    expect(annotateFile(`echo ok;${hash()}1937`, "a.sh")[0]).toBe(`${hash()}1937`);
    const src = [`cat <<EOF`, `${hash()}1937`, `EOF`, `echo x;${hash()}9`].join("\n");
    const ann = annotateFile(src, "a.sh");
    expect(ann[1]).toBeNull(); // heredoc 正文
    expect(ann[3]).toBe(`${hash()}9`);
  });

  it("TOML：行内 # 是注释；单引号 literal string 不转义反斜杠", () => {
    expect(annotateFile(`x=1${hash()}1937`, "a.toml")[0]).toBe(`${hash()}1937`);
    expect(annotateFile(`path='C:\\'${hash()}1937`, "a.toml")[0]).toBe(`${hash()}1937`);
  });
});

describe("annotateFile CSS/SCSS/HTML", () => {
  it("CSS：块注释命中、字符串里块注释标记不误伤、多行闭合行后代码不误伤", () => {
    expect(annotateFile(`/* 见 ${fid()} */`, "a.css")[0]).toContain("/*");
    expect(annotateFile(`.x { content: "/* ${fid()} */"; }`, "a.css")[0]).toBeNull();
    const src = [`/*`, `*/ .x { content: "${fid()}"; }`].join("\n");
    const ann = annotateFile(src, "a.css");
    expect(ann[0]).toContain("/*");
    expect(ann[1]).toBe("*/");
  });

  it("SCSS：行注释命中，裸 URL 的 // 不误判", () => {
    expect(annotateFile(`${sl()} ${fid()}`, "a.scss")[0]).toBe(`${sl()} ${fid()}`);
    expect(annotateFile(`.x { background: url(https://x.test/${fid()}); }`, "a.scss")[0]).toBeNull();
  });

  it("HTML：注释跨行命中", () => {
    const ann = annotateFile([`<!--`, `${fid()}`, `-->`].join("\n"), "a.html");
    expect(ann[0]).toContain("<!--");
    expect(ann[1]).toContain(fid());
    expect(ann[2]).toContain("-->");
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
  const mk = (files: Record<string, string>) => (p: string) => {
    if (!(p in files)) throw new Error(`mock 文件不存在: ${p}`);
    return files[p];
  };

  it("字符串字面量里的 URL 与模板正文不误判", () => {
    const content = [
      `const design = "https://example.test/${fid()}";`,
      "const s = `",
      `${sl()} ${fid()}`,
      "`;",
    ].join("\n");
    const diff = [
      "diff --git a/src/normal.ts b/src/normal.ts",
      "--- a/src/normal.ts",
      "+++ b/src/normal.ts",
      "@@ -0,0 +1,4 @@",
      ...content.split("\n").map((l) => `+${l}`),
    ].join("\n");
    const { violations } = checkDiff(diff, mk({ "src/normal.ts": content }));
    expect(violations).toEqual([]);
  });

  it("模板后真行注释命中", () => {
    const content = ["const t = `x`;", `${sl()} ${hash()}1937`].join("\n");
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

  it("无星号块注释正文仍命中（跨行块注释）", () => {
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

  it("issue 全拦截（短号/hex 形态），region 豁免", () => {
    const content = [
      `${sl()} 修复见 ${hash()}123`,
      `${sl()} ${hash()}region 分组`,
      `${sl()} ${hash()}fff`,
    ].join("\n");
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -0,0 +1,3 @@",
      `+${sl()} 修复见 ${hash()}123`,
      `+${sl()} ${hash()}region 分组`,
      `+${sl()} ${hash()}fff`,
    ].join("\n");
    const { violations } = checkDiff(diff, mk({ "src/a.ts": content }));
    expect(violations).toHaveLength(2);
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

  it("CSS 块注释命中、CSS 字符串里块注释标记不误伤", () => {
    const c1 = [`/* 见 ${fid()} */`].join("\n");
    const d1 = [
      "diff --git a/web/a.css b/web/a.css",
      "--- a/web/a.css",
      "+++ b/web/a.css",
      "@@ -0,0 +1,1 @@",
      `+/* 见 ${fid()} */`,
    ].join("\n");
    expect(checkDiff(d1, mk({ "web/a.css": c1 })).violations).toHaveLength(1);

    const c2 = [`.x { content: "/* ${fid()} */"; }`].join("\n");
    const d2 = [
      "diff --git a/web/a.css b/web/a.css",
      "--- a/web/a.css",
      "+++ b/web/a.css",
      "@@ -0,0 +1,1 @@",
      `+.x { content: "/* ${fid()} */"; }`,
    ].join("\n");
    expect(checkDiff(d2, mk({ "web/a.css": c2 })).violations).toEqual([]);
  });

  it("SCSS 行注释命中", () => {
    const content = [`${sl()} ${fid()}`].join("\n");
    const diff = [
      "diff --git a/web/a.scss b/web/a.scss",
      "--- a/web/a.scss",
      "+++ b/web/a.scss",
      "@@ -0,0 +1,1 @@",
      `+${sl()} ${fid()}`,
    ].join("\n");
    const { violations } = checkDiff(diff, mk({ "web/a.scss": content }));
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
    const { diffNonEmpty } = checkDiff("", () => "");
    expect(diffNonEmpty).toBe(false);
  });
});