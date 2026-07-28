import { describe, it, expect } from "vitest";
import {
  stripHtmlCardFences,
  stripHtmlCardsOnly,
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
