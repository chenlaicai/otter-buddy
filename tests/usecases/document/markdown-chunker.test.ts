import { describe, it, expect } from "vitest";
import { chunkMarkdown } from "@usecases/document/markdown-chunker";

/** 生成超 CHUNK_THRESHOLD(3000) 的 body，确保走分段逻辑而非单 chunk 分支 */
const big = (n: number) => "x".repeat(n);

describe("chunkMarkdown", () => {
  it("空 body 返回 []", () => {
    expect(chunkMarkdown("")).toEqual([]);
  });

  it("全空白 body 返回 []", () => {
    expect(chunkMarkdown("   \n\n  \t ")).toEqual([]);
  });

  it("短文档（< 阈值）单 chunk，headingPath=[]", () => {
    const body = "## 背景\n这是简短内容。";
    const result = chunkMarkdown(body);
    expect(result).toHaveLength(1);
    expect(result[0].headingPath).toEqual([]);
    expect(result[0].content).toBe(body);
  });

  it("去除 H1 标题行", () => {
    const body = "# 文档标题\n## 背景\n短内容";
    const result = chunkMarkdown(body);
    expect(result).toHaveLength(1);
    expect(result[0].content).not.toContain("# 文档标题");
    expect(result[0].content).toContain("## 背景");
  });

  it("按 H2 分段（body 超阈值）", () => {
    const section1 = "## 背景\n" + big(1700);
    const section2 = "## 设计\n" + big(1700);
    const body = section1 + "\n" + section2;
    const result = chunkMarkdown(body);
    expect(result.length).toBe(2);
    expect(result[0].headingPath).toEqual(["背景"]);
    expect(result[0].content).toContain("## 背景");
    expect(result[1].headingPath).toEqual(["设计"]);
  });

  it("H2 超阈值下沉 H3", () => {
    const h3a = "### 决策1\n" + big(1600);
    const h3b = "### 决策2\n" + big(1600);
    const h2 = "## 设计\n" + h3a + "\n" + h3b;
    const body = "## 背景\n" + big(800) + "\n" + h2;
    const result = chunkMarkdown(body);
    const paths = result.map(c => c.headingPath);
    expect(paths.some(p => p.length === 2 && p[0] === "设计" && p[1] === "决策1")).toBe(true);
    expect(paths.some(p => p.length === 2 && p[0] === "设计" && p[1] === "决策2")).toBe(true);
  });

  it("H3 仍超阈值按段落兜底切分", () => {
    const longPara1 = big(2000);
    const longPara2 = big(2000);
    const h3 = "### 长内容\n" + longPara1 + "\n\n" + longPara2;
    const body = "## 背景\n" + big(200) + "\n" + h3;
    const result = chunkMarkdown(body);
    expect(result.length).toBeGreaterThan(2);
  });

  it("代码块不被截断到两个 chunk", () => {
    const code = "```ts\n" + "const x = 1;\n".repeat(40) + "```";
    const h3 = "### 代码段\n" + code;
    const body = "## 背景\n" + big(2000) + "\n" + h3;
    const result = chunkMarkdown(body);
    // 含 ```ts 的 chunk 也应含 ``` 结尾围栏（同一 chunk 内开闭配对）
    const codeChunks = result.filter(c => c.content.includes("```ts"));
    for (const c of codeChunks) {
      const fences = (c.content.match(/```/g) || []).length;
      expect(fences % 2).toBe(0); // 开闭配对
    }
  });

  it("~~~ 围栏也被识别为代码块", () => {
    const code = "~~~ts\nconst y = 2;\n~~~";
    const h3 = "### tilde围栏\n" + code;
    const body = "## 背景\n" + big(2000) + "\n" + h3;
    const result = chunkMarkdown(body);
    const tildeChunks = result.filter(c => c.content.includes("~~~ts"));
    expect(tildeChunks.length).toBeGreaterThan(0);
  });

  it("短 chunk 合并到相邻", () => {
    const section1 = "## A\n" + big(1700);
    const tinySection = "## B\n短";
    const section3 = "## C\n" + big(1700);
    const body = section1 + "\n" + tinySection + "\n" + section3;
    const result = chunkMarkdown(body);
    const tinyChunks = result.filter(c => c.charCount < 10);
    expect(tinyChunks.length).toBe(0);
  });

  it("无标题纯文本（超阈值）按段落切分", () => {
    const para1 = big(2000);
    const para2 = big(2000);
    const body = para1 + "\n\n" + para2;
    const result = chunkMarkdown(body);
    expect(result.length).toBeGreaterThan(1);
  });

  it("连续 H2 无实质内容不产生空 chunk", () => {
    const body = "## A\n## B\n## C\n" + big(2000);
    const result = chunkMarkdown(body);
    for (const c of result) {
      expect(c.charCount).toBeGreaterThan(0);
      expect(c.content.trim().length).toBeGreaterThan(0);
    }
  });

  it("headingPath 反映标题层级", () => {
    const h2 = "## 设计\n" + big(1700);
    const h3 = "### 子决策\n" + big(1700);
    const body = h2 + "\n" + h3;
    const result = chunkMarkdown(body);
    const designChunk = result.find(c => c.headingPath.join("/") === "设计");
    expect(designChunk).toBeDefined();
  });

  it("未闭合代码块兜底（超长按行切分）", () => {
    // 未闭合：只有开头 ``` 没有结尾
    const unclosed = "```ts\n" + "const z = 1;\n".repeat(500); // ~7000 字符，无结尾围栏
    const h3 = "### 未闭合\n" + unclosed;
    const body = "## 背景\n" + big(500) + "\n" + h3;
    const result = chunkMarkdown(body);
    // 不应产生单个 >6000 字符的 chunk（forceSplit 兜底）
    const oversized = result.filter(c => c.charCount > 6000);
    expect(oversized.length).toBe(0);
  });
});
