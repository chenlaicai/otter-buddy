import { describe, it, expect } from "vitest";
import {
  stripHtmlCardFences,
  stripHtmlCardsOnly,
  projectForChannel,
} from "@entities/conversation/message-body-projection";
import { HTML_CARD_STRIP_VECTORS } from "@entities/conversation/html-card-test-vectors";

describe("stripHtmlCardFences（共享测试向量，与前端解析输出一致）", () => {
  for (const vector of HTML_CARD_STRIP_VECTORS) {
    it(vector.name, () => {
      expect(stripHtmlCardFences(vector.input)).toBe(vector.expected);
    });
  }
});

describe("stripHtmlCardFences 补充用例", () => {
  it("无围栏文本原样返回", () => {
    expect(stripHtmlCardFences("普通消息，没有任何围栏")).toBe("普通消息，没有任何围栏");
  });

  it("空字符串原样返回", () => {
    expect(stripHtmlCardFences("")).toBe("");
  });

  it("闭围栏反引号数多于开围栏：合法闭合（CommonMark ≥ 规则）", () => {
    const input = '```html-card title="卡"\n<x/>\n`````\n之后';
    expect(stripHtmlCardFences(input)).toBe("[html-card: 卡]\n之后");
  });

  it("html-card-reply 优先于 html-card 前缀匹配（reply 不会被当作卡片）", () => {
    const input = '```html-card-reply card="m:1"\n{}\n```';
    expect(stripHtmlCardFences(input)).toBe("[html-card-reply: m:1]");
  });

  it("htmlcard / html-card-x 等非契约语言标识不剥离", () => {
    const input = "```htmlcard\n<x/>\n```\n```html-card-x\n<y/>\n```";
    expect(stripHtmlCardFences(input)).toBe(input);
  });

  it("容器中断：blockquote 结束后围栏在容器出口处结束", () => {
    const input = '> ```html-card title="卡"\n> <div/>\n普通行不再属于引用';
    expect(stripHtmlCardFences(input)).toBe("> [html-card: 卡]\n普通行不再属于引用");
  });

  it("title 含等号但无引号：按无 title 处理", () => {
    const input = "```html-card title=无引号\n<x/>\n```";
    expect(stripHtmlCardFences(input)).toBe("[html-card: ]");
  });
});

describe("stripHtmlCardsOnly（注入出口：只剥卡片，保留回执 JSON）", () => {
  it("html-card 剥离、html-card-reply 保留原文", () => {
    const input =
      '```html-card title="问卷"\n<form/>\n```\n\n```html-card-reply card="m1:0"\n{"choice":"B"}\n```';
    expect(stripHtmlCardsOnly(input)).toBe(
      '[html-card: 问卷]\n\n```html-card-reply card="m1:0"\n{"choice":"B"}\n```',
    );
  });

  it("共享向量中卡片部分剥离结果一致（reply 围栏保留）", () => {
    const mixed = HTML_CARD_STRIP_VECTORS.find(v => v.name.startsWith("卡片与回执混合"))!;
    expect(stripHtmlCardsOnly(mixed.input)).toBe(
      '[html-card: 问卷]\n```html-card-reply card="m1:0"\n{"a":1}\n```',
    );
  });
});

describe("projectForChannel（信道投影出口：飞书 post + md）", () => {
  it("html-card 占位符带 Web 链接", () => {
    const body = '前文\n\n```html-card title="薪资对比"\n<div/>\n```\n\n后文';
    const out = projectForChannel(body, {
      webBaseUrl: "https://otter.app",
      conversationId: "conv-abc",
    });
    expect(out).toBe(
      "前文\n\n【交互卡片:薪资对比】\n👉 https://otter.app/conversations/conv-abc\n\n后文",
    );
  });

  it("webBaseUrl 缺省时占位符不带链接", () => {
    const body = '```html-card title="薪资对比"\n<div/>\n```';
    const out = projectForChannel(body);
    expect(out).toBe("【交互卡片:薪资对比】");
  });

  it("webBaseUrl 末尾斜杠被规整", () => {
    const body = '```html-card title="卡"\n<x/>\n```';
    const out = projectForChannel(body, {
      webBaseUrl: "https://otter.app/",
      conversationId: "c1",
    });
    expect(out).toBe("【交互卡片:卡】\n👉 https://otter.app/conversations/c1");
  });

  it("html-card-reply 占位符替换为通用文案", () => {
    const body = '```html-card-reply card="m1:0"\n{"a":1}\n```';
    expect(projectForChannel(body)).toBe("[已提交交互卡片]");
  });

  it("普通 Markdown 透传", () => {
    const body = "# 标题\n\n**加粗**和`代码`";
    expect(projectForChannel(body)).toBe("# 标题\n\n**加粗**和`代码`");
  });

  it("按字节阈值截断,中文 UTF-8 3 字节/字", () => {
    // 构造 5 段,每段 1000 字符 = 3000 字节,设 maxBytes=7500（留 hint 空间）
    const para = "段".repeat(1000);
    const body = Array.from({ length: 5 }, () => para).join("\n\n");
    const out = projectForChannel(body, { maxBytes: 7500 });
    // 总长 > 7500,触发截断
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(7500);
    expect(out).toContain("…(已截断,完整内容见 Web 端)");
  });

  it("截断对齐段落边界,不切断段落", () => {
    const para1 = "A".repeat(100); // 100 bytes ASCII
    const para2 = "B".repeat(100);
    const para3 = "C".repeat(100);
    const body = `${para1}\n\n${para2}\n\n${para3}`;
    const out = projectForChannel(body, { maxBytes: 250 });
    // 250 字节够装 2 段 + hint,但不够 3 段
    expect(out).toContain("AA");
    expect(out).toContain("BB");
    expect(out).not.toContain("CC");
    expect(out).toContain("…(已截断");
  });

  it("自定义 truncationHint", () => {
    const body = "X".repeat(1000);
    const out = projectForChannel(body, { maxBytes: 100, truncationHint: "[TRUNC]" });
    expect(out.endsWith("[TRUNC]")).toBe(true);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(100);
  });

  it("短消息不触发截断", () => {
    expect(projectForChannel("短消息", { maxBytes: 25000 })).toBe("短消息");
  });

  it("卡片 + 截断同时生效:链接占位计入字节预算", () => {
    // 大段文字 + 卡片,确认占位符替换后再截断
    const body = `${"字".repeat(10000)}\n\n\`\`\`html-card title="卡片"\n<x/>\n\`\`\``;
    const out = projectForChannel(body, {
      webBaseUrl: "https://otter.app",
      conversationId: "c1",
      maxBytes: 5000,
    });
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(5000);
    expect(out).toContain("…(已截断");
  });
});
