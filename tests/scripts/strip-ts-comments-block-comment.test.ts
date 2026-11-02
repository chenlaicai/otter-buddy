/**
 * #1291：isLineStart 穿跨行块注释——行首续行除法被误判正则。
 *
 * bug 形态：跨行块注释（subtotal 后接块注释再接行首除法）的第三行 `/` 是除法
 * 续行（块注释是 token 间空白），但 isLineStart 遇换行即判语句位正则 →
 * 正则态吞到注释首个 `/` 闭合、剩余注释文本再进正则态自愈回填 →
 * 尾部真注释不剥离（误报方向）。同行形态（标识符后接块注释再接除法）同病：
 * lastNonWhitespace 落在块注释结束符的斜杠上，被「其余→正则」误判。
 *
 * 修复口径（与检视发现③的赌注协调）：仅当 `/` 与上一代码 token 之间
 * 存在块注释时穿透判定（块注释=token 间空白，除法语义强）；纯换行
 * 维持「行首赌正则」既有取舍（检视发现③行为不回归）。
 */
import { describe, it, expect } from "vitest";
import { stripTsComments } from "../../scripts/strip-ts-comments.mjs";

describe("块注释穿透（#1291 修复）", () => {
  it("issue 现场：跨行块注释后行首续行除法——尾部真注释正常剥离", () => {
    const src = [
      `const ratio =`,
      `  subtotal`,
      `  /* 跨行`, // 块注释跨两行
      `     块注释 */`,
      `  / 100; // F20261101aaaa 决策注释`,
      `const t = "锚点 F20261101bbbb";`,
    ].join("\n");
    const out = stripTsComments(src);
    // 除法语义：/ 100 保留为代码
    expect(out).toContain("/ 100;");
    // 误报方向封口：尾部真注释剥离（修复前残留）
    expect(out).not.toContain("F20261101aaaa");
    // 漏检方向不回归：字符串锚点保留
    expect(out).toContain("F20261101bbbb");
  });

  it("同行块注释 + 除法：a /* c */ / b 不误判正则，注释剥离", () => {
    const src = `const avg = subtotal /* 加权注释 */ / count; // F20261101cccc`;
    const out = stripTsComments(src);
    expect(out).toContain("/ count;"); // 除法保留
    expect(out).not.toContain("加权注释"); // 块注释剥离
    expect(out).not.toContain("F20261101cccc"); // 行注释剥离（修复前残留）
  });

  it("块注释后行首正则不回归：完整语句（; 结尾）+ 注释 + 语句位正则", () => {
    const src = [
      `const a = 1;`,
      `/* 头注释 */`,
      `/re/.test(s); // F20261101dddd`,
    ].join("\n");
    const out = stripTsComments(src);
    expect(out).toContain("/re/.test(s);"); // 穿透后前一 token 是 ; → 语句位正则
    expect(out).not.toContain("F20261101dddd"); // 注释正常剥离
  });

  it("控制流 + 块注释 + 语句位正则：if (x) /* ok */ /['\"]/.test(s)", () => {
    const src = `if (x) /* ok */ /["']/.test(s); // F20261101eeee`;
    const out = stripTsComments(src);
    expect(out).toContain(`/["']/.test(s);`); // 穿透后遇 ) → 回溯 if → 正则
    expect(out).not.toContain("F20261101eeee");
  });

  it("文件头块注释 + 正则：/* header */ 后的 /re/ 仍为正则", () => {
    const src = `/* 文件头注释 */\n/re/.test(s); // F20261101ffff`;
    const out = stripTsComments(src);
    expect(out).toContain("/re/.test(s);"); // 穿透后无 token（文件头）→ 正则
    expect(out).not.toContain("F20261101ffff");
  });

  it("多个连续块注释：a /* x */ /* y */ / b 按除法处理", () => {
    const src = `const v = a /* x */ /* y */ / b; // F20261101gggg`;
    const out = stripTsComments(src);
    expect(out).toContain("/ b;"); // 除法保留
    expect(out).not.toContain("F20261101gggg");
  });

  it("字符串内伪块注释结束符形态：主循环正常处理，注释剥离不回归", () => {
    // 字符串里的伪结束符是字符内容不是真注释；本用例锁主循环在此形态下稳定
    const src = 'const s = "a */ b"; // F20261101iiii';
    const out = stripTsComments(src);
    expect(out).toContain('"a */ b"'); // 字符串本体保留
    expect(out).not.toContain("F20261101iiii"); // 行注释正常剥离
  });

  it("块注释 + 除法跨多行空白混合形态", () => {
    const src = [
      `const total = base`,
      `  /* 权重`,
      `     说明 */`,
      `  / 2`,
      `  ; // F20261101hhhh`,
    ].join("\n");
    const out = stripTsComments(src);
    expect(out).toContain("/ 2");
    expect(out).not.toContain("F20261101hhhh");
  });
});
