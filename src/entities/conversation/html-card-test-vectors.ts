/**
 * HTML 卡片围栏的共享测试向量（F20260728htar）。
 * - HTML_CARD_STRIP_VECTORS：后端剥离函数（entities/message-body-projection）消费
 * - HTML_CARD_REPLY_DERIVE_VECTORS：前端已回复集合派生（web/src/lib/html-card.ts）消费
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
  {
    name: "普通围栏内的 reply 字样不剥离（四反引号外层）",
    input: '````markdown\n```html-card-reply card="fake:0"\n{}\n```\n````',
    expected: '````markdown\n```html-card-reply card="fake:0"\n{}\n```\n````',
  },
  {
    name: "~~~ 卡片围栏：与反引号围栏等价剥离",
    input: '~~~html-card title="波浪卡"\n<div/>\n~~~',
    expected: "[html-card: 波浪卡]",
  },
  {
    name: "~~~ 回执围栏：与反引号围栏等价剥离",
    input: '~~~html-card-reply card="m:0"\n{}\n~~~',
    expected: "[html-card-reply: m:0]",
  },
  {
    name: "list 同级新项：围栏在首项内剥离，后续列表项不受影响",
    input: '- 项目\n  ```html-card title="卡"\n  <div/>\n  ```\n- 第二项',
    expected: "- 项目\n  [html-card: 卡]\n- 第二项",
  },
  {
    name: "blockquote 裸 > 行：空引用行是围栏内容，不构成容器中断",
    input: '> ```html-card title="卡"\n> <div/>\n>\n> ```\n> 引用后文',
    expected: "> [html-card: 卡]\n> 引用后文",
  },
  {
    name: "≥4 空格缩进在 list 项内：仍是合法围栏（项内容缩进），正常剥离",
    input: '- 项目\n    ```html-card title="嵌套"\n    <div/>\n    ```\n- 之后',
    expected: "- 项目\n    [html-card: 嵌套]\n- 之后",
  },
  {
    name: "GFM footnote 定义内的围栏：footnote 是容器块，正常剥离（R9：解析管线挂 remarkGfm 与渲染对齐）",
    input: '[^注]: 脚注\n\n    ```html-card title="脚注卡"\n    <div/>\n    ```\n\n正文',
    expected: "[^注]: 脚注\n\n    [html-card: 脚注卡]\n\n正文",
  },
  {
    name: "首部 BOM：剥除 BOM 后切片不错位（micromark offset 基于剥 BOM 后的值）",
    input: '\uFEFF前文\n\n```html-card title="b"\n<x/>\n```\n\n后文',
    expected: "前文\n\n[html-card: b]\n\n后文",
  },
];

/** 已回复集合派生（deriveRepliedCardIds）的共享向量：前端消费。
 *  messages 带 st（sender 类型）：只扫 user 消息的回执围栏 */
export interface HtmlCardReplyDeriveTestVector {
  name: string;
  messages: Array<{ st: "user" | "otter" | "system"; content: string }>;
  /** 期望派生出的 cardId 集合（排序后比较） */
  expected: string[];
}

export const HTML_CARD_REPLY_DERIVE_VECTORS: HtmlCardReplyDeriveTestVector[] = [
  {
    name: "user 回执围栏：提取 cardId",
    messages: [{ st: "user", content: '选择了方案 B\n\n```html-card-reply card="msg-1:0"\n{"choice":"B"}\n```' }],
    expected: ["msg-1:0"],
  },
  {
    name: "普通围栏内 reply 字样：只是代码示例，不派生",
    messages: [{ st: "user", content: '看这段：\n\n````markdown\n```html-card-reply card="fake:0"\n{}\n```\n````' }],
    expected: [],
  },
  {
    name: "~~~ 回执：与反引号围栏等价派生",
    messages: [{ st: "user", content: '~~~html-card-reply card="m:7"\n{}\n~~~' }],
    expected: ["m:7"],
  },
  {
    name: "otter 消息中的 reply 围栏：不扫描（回执只认 user）",
    messages: [{ st: "otter", content: '```html-card-reply card="m:9"\n{}\n```' }],
    expected: [],
  },
  {
    name: "blockquote 内回执：容器前缀不影响派生",
    messages: [{ st: "user", content: '> ```html-card-reply card="m:1"\n> {}\n> ```' }],
    expected: ["m:1"],
  },
  {
    name: "无 card 属性 / 纯文本提及 cardId 不派生",
    messages: [
      { st: "user", content: "```html-card-reply\n{}\n```" },
      { st: "user", content: "我回复过 m:5 那张卡" },
    ],
    expected: [],
  },
  {
    name: "多消息混合：user 多回执全部派生，otter 忽略",
    messages: [
      { st: "user", content: '```html-card-reply card="m1:0"\n{}\n```' },
      { st: "otter", content: '```html-card title="新卡"\n<x/>\n```' },
      { st: "user", content: '前文\n```html-card-reply card="m2:1"\n{"a":1}\n```' },
    ],
    expected: ["m1:0", "m2:1"],
  },
];
