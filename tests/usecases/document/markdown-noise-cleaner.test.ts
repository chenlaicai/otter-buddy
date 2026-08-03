/**
 * F20260803fbit: markdown 噪声清理单元测试
 */
import { describe, it, expect } from "vitest";
import { cleanMarkdownForFts } from "@usecases/document/markdown-noise-cleaner";

describe("cleanMarkdownForFts - F20260803fbit", () => {
  it("删 HTML 注释", () => {
    expect(cleanMarkdownForFts("a <!-- comment --> b")).toBe("a  b");
  });

  it("删代码围栏开头但保留代码内容", () => {
    const body = "```ts\nconst x = 1;\n```\n文本";
    const cleaned = cleanMarkdownForFts(body);
    expect(cleaned).toContain("const x = 1;");
    expect(cleaned).not.toContain("```");
    expect(cleaned).toContain("文本");
  });

  it("删标题井号但保留标题文本", () => {
    expect(cleanMarkdownForFts("## 标题\n正文")).toBe("标题\n正文");
    expect(cleanMarkdownForFts("###### 深层标题")).toBe("深层标题");
  });

  it("删无序列表符号", () => {
    const cleaned = cleanMarkdownForFts("- 项一\n* 项二\n+ 项三");
    expect(cleaned).toBe("项一\n项二\n项三");
  });

  it("删有序列表编号", () => {
    const cleaned = cleanMarkdownForFts("1. 第一\n2. 第二");
    expect(cleaned).toBe("第一\n第二");
  });

  it("删粗体符号保留内容", () => {
    expect(cleanMarkdownForFts("**重要** 和 __也重要__")).toBe("重要 和 也重要");
  });

  it("删行内代码符号保留内容", () => {
    expect(cleanMarkdownForFts("用 `replaceBySource` 方法")).toBe("用 replaceBySource 方法");
  });

  it("链接保留锚文本去 URL", () => {
    expect(cleanMarkdownForFts("[文档](./doc.md)")).toBe("文档");
  });

  it("表格分隔行删除，内容行保留", () => {
    const body = "| 列1 | 列2 |\n|---|---|\n| a | b |";
    const cleaned = cleanMarkdownForFts(body);
    expect(cleaned).not.toContain("|---|");
    expect(cleaned).toContain("a");
    expect(cleaned).toContain("b");
  });

  it("删引用符号", () => {
    expect(cleanMarkdownForFts("> 引用内容")).toBe("引用内容");
  });

  it("多空行合并", () => {
    expect(cleanMarkdownForFts("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("空字符串", () => {
    expect(cleanMarkdownForFts("")).toBe("");
  });

  it("纯 frontmatter 残留（无正文）返回空串", () => {
    // parseFrontmatterFromContent 已剥离 frontmatter，body 为空或仅换行
    expect(cleanMarkdownForFts("\n\n")).toBe("");
  });

  it("超长 body（100KB）不抛异常不超时", () => {
    const huge = "标题内容\n".repeat(10000); // ~100KB
    const result = cleanMarkdownForFts(huge);
    expect(result.length).toBeGreaterThan(0);
    // "标题内容\n" 不含 markdown 语法，清理后内容不变
    expect(result).toContain("标题内容");
  });

  it("综合：代码块里的函数名保留可搜", () => {
    const body = "## 背景\n\n```ts\nfunction createHash() {\n  return crypto.createHash('sha256');\n}\n```\n\n### 用法\n\n调用 `createHash()` 生成哈希。";
    const cleaned = cleanMarkdownForFts(body);
    // 标题文本保留
    expect(cleaned).toContain("背景");
    expect(cleaned).toContain("用法");
    // 代码内容保留
    expect(cleaned).toContain("createHash");
    expect(cleaned).toContain("sha256");
    // 语法符号删除
    expect(cleaned).not.toContain("```");
    expect(cleaned).not.toContain("##");
    expect(cleaned).not.toContain("###");
    expect(cleaned).not.toContain("`");
  });
});
