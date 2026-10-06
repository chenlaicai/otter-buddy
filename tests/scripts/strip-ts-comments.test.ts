/**
 * #1128 stripTsComments 正则字面量识别修复测试。
 *
 * 现场修复动机：PR #1126 在 tool-factory.ts 写含裸引号的正则字面量 /["']/ 时，
 * 旧状态机把正则内的 ' 当字符串起始 → 后续真注释不再剥离 → 注释内锚点被误报
 * 注入面，开发者被迫改用 RegExp 构造器规避。
 *
 * 验证矩阵（纯函数直接 import 断言）：
 * 1. 正则内裸引号 /["']/：后续行注释正常剥离（误报路径，#1126 现场）
 * 2. 正则内 //（转义 /\d\//）：正则后的字符串内容不被误吞（漏检路径）
 * 3. 正则内 /*（字符类 /[/*]/）：不触发块注释误剥
 * 4. 除法 / 不误判为正则：后续注释正常剥离、除法符号保留
 * 5. 关键字后正则（return /re/）：正确识别为正则
 * 6. 除法误判自愈：} 后除法跨行，回退按除法重扫
 * 7. 真锚点不回归：description 字符串内锚点仍保留在输出（gate 仍拦截）
 * 8. 行号保持：块注释剥离后换行回填
 */
import { describe, it, expect } from "vitest";
import { stripTsComments } from "../../scripts/strip-ts-comments.mjs";

describe("正则字面量识别（#1128 修复）", () => {
  it("正则内裸引号 /['\"]/ + 后续行注释含锚点：注释被剥离（#1126 踩坑现场）", () => {
    const src = [
      `const desc = "禁止 shell 元字符 " +`,
      `  /["']/.source + // F20260921vsds 决策：正则含裸引号`,
      `  "（显式拒绝）";`,
    ].join("\n");
    const out = stripTsComments(src);
    // 误报路径：正则内 ' 不再被当字符串起始，行注释正常剥离
    expect(out).not.toContain("F20260921vsds");
    // 正则本体与字符串本体保留
    expect(out).toContain(`/["']/.source`);
    expect(out).toContain("（显式拒绝）");
  });

  it("正则内 //（/\\d\\//）：正则后的字符串锚点不被误吞（漏检路径）", () => {
    const src = `const re = /\\d\\//;\nconst desc = "see #1234 and F20260101abcd";`;
    const out = stripTsComments(src);
    // 修复前 /\\// 里的 // 被当行注释起始，吞掉后续全部内容 → #1234 漏检
    expect(out).toContain("#1234");
    expect(out).toContain("F20260101abcd");
    expect(out).toContain(`/\\d\\//`);
  });

  it("正则内 /*（字符类 /[/*]/）：不触发块注释误剥", () => {
    const src = `const re = /[/*]/;\nconst desc = "锚点 #567 在后面";`;
    const out = stripTsComments(src);
    // 修复前 / 后的 /* 被当块注释起始，吞到下一个 */ 或文末 → 后续锚点漏检
    expect(out).toContain("#567");
    expect(out).toContain(`/[/*]/`);
  });

  it("字符类内的 / 不终止正则：/a[/]b/.test(x)", () => {
    const src = `if (/a[/]b/.test(s)) { const t = "ok #890"; }`;
    const out = stripTsComments(src);
    expect(out).toContain("/a[/]b/");
    expect(out).toContain("#890");
  });
});

describe("除法与正则的区分（启发式）", () => {
  it("标识符后除法：a / b 的 / 不误判为正则", () => {
    const src = `const x = total / count; // F20260202xyza 决策注释`;
    const out = stripTsComments(src);
    expect(out).toContain("total / count");
    expect(out).not.toContain("F20260202xyza"); // 注释正常剥离
  });

  it(")/]/引号后除法：不误判为正则", () => {
    const src = [
      `const a = (p + q) / 2; // F20260303bcde`,
      `const b = arr[0] / 2; // F20260404fghi`,
      `const c = "10" / 2; // F20260505jklm`,
    ].join("\n");
    const out = stripTsComments(src);
    expect(out).toContain("(p + q) / 2");
    expect(out).toContain("arr[0] / 2");
    expect(out).toContain('"10" / 2');
    expect(out).not.toContain("F20260303bcde");
    expect(out).not.toContain("F20260404fghi");
    expect(out).not.toContain("F20260505jklm");
  });

  it("关键字后正则：return /re/ 正确识别为正则", () => {
    const src = `function f() {\n  return /["']/.test(s); // F20260606nopq 决策\n}`;
    const out = stripTsComments(src);
    expect(out).toContain(`/["']/.test(s)`);
    expect(out).not.toContain("F20260606nopq");
  });

  it("除法误判自愈：} 后除法跨行，回退按除法重扫", () => {
    // } 后的 / 被启发式判为正则起始（块结束→新语句位置），但跨行未闭合
    // → 回填原文，行内后续内容正常识别
    const src = `const o = {}\n/ 2\n; const t = "F20260707qrst";`;
    const out = stripTsComments(src);
    expect(out).toContain("F20260707qrst"); // 自愈后正常扫描
    expect(out).toContain("/ 2");
  });

  it("检视发现①（严重）：自愈区间含奇数引号不得卡字符串态——回填原文而非重扫", () => {
    // {} 后除法误判正则，区间 `a'b` 含奇数引号——旧实现回填 / 后重扫，
    // ' 开字符串态卡到下一引号，后续注释不剥离（误报）/内容被吞（漏检）
    const src = `x = {} / a'b\n;\nconst d = "F20260101abcd 决策";\n// F20260202xyza 注释\n`;
    const out = stripTsComments(src);
    expect(out).not.toContain("F20260202xyza"); // 行注释正常剥离
    expect(out).toContain("F20260101abcd"); // 字符串本体保留
    expect(out.split("\n").length).toBe(src.split("\n").length); // 行号不乱
  });

  it("检视发现②：if 语句位正则 if (x) /['\"]/.test(s) 后续注释正常剥离", () => {
    const src = `if (x) /["']/.test(s); // F20260909aaaa 决策\nconst u = "see #4321";`;
    const out = stripTsComments(src);
    expect(out).toContain(`/["']/.test(s)`);
    expect(out).not.toContain("F20260909aaaa"); // 误报路径修复
    expect(out).toContain("#4321"); // 漏检路径同步修复
  });

  it("检视发现②变体：嵌套括号 if (foo(a, b)) /re/ 语句位正则", () => {
    const src = `if (foo(a, b)) /\\d\\//.test(s); // F20260909bbbb\n`;
    const out = stripTsComments(src);
    expect(out).not.toContain("F20260909bbbb");
  });

  it("glm终检严重①：if 条件字符串内括号不污染回溯——语句位正则不误判除法（漏检方向封口）", () => {
    // if (s.includes("(")) /["']/; ——字符串内 "(" 污染朴素括号平衡，
    // 回溯找到错误的开括号 → 正则误判为除法 → 正则体内引号按裸字符串语义扫描
    // 配对错位吞后续行（漏检方向无自愈兜底——自愈只挂在正则态）。
    // 修复：matchingOpenParen 对字符串/模板字面量内括号免疫。
    const src =
      `if (s.includes("(")) /["']/;\n` +
      `const meta = { description: "真锚点 F20261006rgxf" };\n` +
      `const y = 2;`;
    const out = stripTsComments(src);
    expect(out).toContain(`/["']/;`); // 正则本体保留
    expect(out).toContain("F20261006rgxf"); // 后续行字符串锚点不被吞（漏检封口）
  });

  it("glm终检严重①变体：正则体内 // 吞行尾代码锚点（括号污染 + 漏检双要素）", () => {
    const src = `if (s.includes(")")) /a\\/\\/b/.test(t); const tag = "F20261006rgxf";`;
    const out = stripTsComments(src);
    expect(out).toContain("F20261006rgxf"); // 行尾字符串锚点存活
  });

  it("检视发现③：行首语句位正则不误判为除法", () => {
    const src = `const a = 1\n/["']/.test(s); // F20260909cccc 决策\n`;
    const out = stripTsComments(src);
    expect(out).toContain(`/["']/.test(s)`);
    expect(out).not.toContain("F20260909cccc");
  });

  it("检视发现④：EOF 未闭合正则不丢内容（原文保留）并告警", () => {
    const src = `const a = /unclosed tail #9999`;
    const out = stripTsComments(src);
    expect(out).toContain("unclosed tail"); // 不再静默丢弃
    expect(out).toContain("#9999"); // 丢弃内容里的锚点曾致漏检
  });
});

describe("既有行为不回归", () => {
  it("真锚点不回归：description 字符串内锚点仍保留（gate 仍拦截）", () => {
    const src = `const tool = { description: "参见 #1128 的方案" };`;
    const out = stripTsComments(src);
    expect(out).toContain("#1128");
  });

  it("行号保持：块注释剥离后换行回填", () => {
    const src = `const a = 1; /* 多行\n块注释\n*/ const b = 2;`;
    const out = stripTsComments(src);
    expect(out.split("\n").length).toBe(3); // 行数不变，行号对齐
    expect(out).toContain("const a = 1;");
    expect(out).toContain("const b = 2;");
  });

  it("字符串内的 // 与 /* 不被当注释剥离", () => {
    const src = `const u = "https://example.com/*path*/#1234";`;
    const out = stripTsComments(src);
    expect(out).toContain("https://example.com/*path*/#1234");
  });

  it("字符串内的正则形内容不影响字符串状态", () => {
    const src = `const s = "not a /regex/ here"; // F20260808uvwx`;
    const out = stripTsComments(src);
    expect(out).toContain("not a /regex/ here");
    expect(out).not.toContain("F20260808uvwx");
  });
});
