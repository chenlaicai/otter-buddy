/**
 * HTML 卡片围栏剥离的共享测试向量（F20260728htar）。
 * 后端剥离函数（entities/message-body-projection）与前端解析（web/src/lib/html-card.ts、
 * useCardBridge 扫描）共享同一组向量，保证两侧输出一致。
 * 纯数据文件：不 import 任何实现，前后端均可直接引用。
 */
export interface HtmlCardStripTestVector {
  /** 用例名（测试描述用） */
  name: string;
  input: string;
  expected: string;
}

export const HTML_CARD_STRIP_VECTORS: HtmlCardStripTestVector[] = [
  {
    name: "基本替换：html-card 带 title",
    input: '前言\n\n```html-card title="方案对比"\n<table>...</table>\n```\n\n后记',
    expected: "前言\n\n[html-card: 方案对比]\n\n后记",
  },
  {
    name: "html-card 无 title 属性：占位符 title 为空",
    input: "```html-card\n<div>x</div>\n```",
    expected: "[html-card: ]",
  },
  {
    name: "html-card-reply 带 card 属性",
    input: '选择了方案 B\n\n```html-card-reply card="abc-123:0"\n{"choice":"B"}\n```',
    expected: "选择了方案 B\n\n[html-card-reply: abc-123:0]",
  },
  {
    name: "html-card-reply 无 card 属性：占位符 cardId 为空",
    input: "```html-card-reply\n{}\n```",
    expected: "[html-card-reply: ]",
  },
  {
    name: "四反引号包三反引号：外层围栏正确配对",
    input: '````html-card title="嵌套"\n<div>\n```\n内层代码\n```\n</div>\n````\n之后',
    expected: "[html-card: 嵌套]\n之后",
  },
  {
    name: "四反引号围栏内的三反引号不算闭合",
    input: "````html-card\n```\n````\n保留",
    expected: "[html-card: ]\n保留",
  },
  {
    name: "未闭合围栏：吃到文件尾（CommonMark 规则）",
    input: '前文\n```html-card title="未闭合"\n<div>\n永远没有结束',
    expected: "前文\n[html-card: 未闭合]",
  },
  {
    name: "多卡片：一条消息两张卡逐一替换",
    input: '```html-card title="卡一"\n<a/>\n```\n间隔文字\n```html-card title="卡二"\n<b/>\n```',
    expected: "[html-card: 卡一]\n间隔文字\n[html-card: 卡二]",
  },
  {
    name: "卡片与回执混合：按各自占位符替换",
    input: '```html-card title="问卷"\n<form/>\n```\n```html-card-reply card="m1:0"\n{"a":1}\n```',
    expected: "[html-card: 问卷]\n[html-card-reply: m1:0]",
  },
  {
    name: "围栏在 blockquote 内：容器前缀保留",
    input: '> 引用前文\n> ```html-card title="引用卡"\n> <div>x</div>\n> ```\n> 引用后文',
    expected: "> 引用前文\n> [html-card: 引用卡]\n> 引用后文",
  },
  {
    name: "围栏在 list 内：缩进前缀保留",
    input: '- 项目\n  ```html-card title="列表卡"\n  <div>x</div>\n  ```\n  之后',
    expected: "- 项目\n  [html-card: 列表卡]\n  之后",
  },
  {
    name: "围栏缩进 ≤3 空格：仍是合法围栏（占位符保留缩进前缀）",
    input: '   ```html-card title="缩进"\n   <div/>\n   ```',
    expected: "   [html-card: 缩进]",
  },
  {
    name: "缩进 4 空格：是缩进代码块不是围栏，不剥离",
    input: '    ```html-card title="伪卡"\n    <div/>\n    ```',
    expected: '    ```html-card title="伪卡"\n    <div/>\n    ```',
  },
  {
    name: "普通代码块不受影响",
    input: "```markdown\n# 标题\n```\n\n```html\n<div>普通 html 块不剥离</div>\n```",
    expected: "```markdown\n# 标题\n```\n\n```html\n<div>普通 html 块不剥离</div>\n```",
  },
  {
    name: "title 含等号与中文标点：取引号内全文",
    input: '```html-card title="方案对比 · 消息渲染架构 v2=final"\n<x/>\n```',
    expected: "[html-card: 方案对比 · 消息渲染架构 v2=final]",
  },
  {
    name: "info string 中 title 之后的额外 meta 被忽略",
    input: '```html-card title="卡" other="x"\n<x/>\n```',
    expected: "[html-card: 卡]",
  },
  {
    name: "围栏外文本原样保留（含疑似占位符的纯文本）",
    input: "这是 [html-card: 伪造] 纯文本，不是围栏",
    expected: "这是 [html-card: 伪造] 纯文本，不是围栏",
  },
  {
    name: "普通围栏是不透明块：内部的 html-card 字样只是代码示例，不剥离",
    input: '```markdown\n示例：\n```html-card title="示例"\n<x/>\n```\n```',
    expected: '````markdown\n示例：\n```html-card title="示例"\n<x/>\n```\n````'.replace(/````/g, "```"),
  },
  {
    name: "~~~ 围栏同样不透明：内部的 html-card 字样不剥离",
    input: '~~~\n```html-card title="示例"\n~~~',
    expected: '~~~\n```html-card title="示例"\n~~~',
  },
];
