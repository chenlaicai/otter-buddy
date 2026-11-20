import { describe, it, expect } from "vitest";
import { truncateToolResult, textResponse, MAX_TOOL_RESULT_CHARS } from "@usecases/ports/agent-tools";
import { validateSpeakBody, hasCardFences, extractPlayableCardSummary, stripToolCallSerializationLeak } from "../../src/interface-adapters/agent-runtime/tools/tool-helpers";

/** validateSpeakBody 新校验逻辑测试 */
describe("validateSpeakBody（F20260915hcel 弹性化）", () => {
  it("空 body 被拒绝", () => {
    expect(validateSpeakBody(undefined, "")).toContain("body 不能为空");
    expect(validateSpeakBody(undefined, "  ")).toContain("body 不能为空");
  });

  it("纯文本无卡片通过", () => {
    expect(validateSpeakBody(undefined, "你好世界")).toBeNull();
  });

  it("1 张小卡片通过", () => {
    const body = '前置文本\n```html-card title="测试"\n<div>hello</div>\n```\n后置文本';
    expect(validateSpeakBody(undefined, body)).toBeNull();
  });

  it("2 张卡片通过", () => {
    const body = '```html-card title="A"\n<div>a</div>\n```\n中间\n```html-card title="B"\n<div>b</div>\n```';
    expect(validateSpeakBody(undefined, body)).toBeNull();
  });

  it("3 张卡片被拒绝", () => {
    const body = '```html-card title="A"\n<div>a</div>\n```\n```html-card title="B"\n<div>b</div>\n```\n```html-card title="C"\n<div>c</div>\n```';
    const result = validateSpeakBody(undefined, body);
    expect(result).toContain("3 张");
    expect(result).toContain("最多支持 2 张");
  });

  it("F20261009csp2：活类与普通卡共享卡数预算（1 普通 + 1 活类通过；+1 活类被拒）", () => {
    const two = '```html-card title="A"\n<div>a</div>\n```\n```html-card-play title="游戏"\n<canvas></canvas>\n```';
    expect(validateSpeakBody(undefined, two)).toBeNull();
    const three = two + '\n```html-card-play title="又一个"\n<canvas></canvas>\n```';
    const result = validateSpeakBody(undefined, three);
    expect(result).toContain("3 张");
    expect(result).toContain("最多支持 2 张");
  });

  it("F20261009csp2：纯活类卡 1 张通过，体积校验与普通卡同口径", () => {
    const one = '```html-card-play title="贪吃蛇"\n<canvas id="g"></canvas>\n```';
    expect(validateSpeakBody(undefined, one)).toBeNull();
    expect(hasCardFences(one)).toBe(true);
  });

  it("单卡 256KB 边界通过（恰好 262144 字节，F20261120diags 放宽）", () => {
    const content = "x".repeat(262144 - 20); // 留点余量给围栏语法
    const body = `\`\`\`html-card title="大卡"\n${content}\n\`\`\``;
    expect(validateSpeakBody(undefined, body)).toBeNull();
  });

  it("单卡超 256KB 被拒绝（只量围栏内 HTML，不量正文散文）", () => {
    const content = "x".repeat(262145);
    const body = `\`\`\`html-card title="超大卡"\n${content}\n\`\`\``;
    const result = validateSpeakBody(undefined, body);
    expect(result).toContain("超出");
    expect(result).toContain("体积限制");
  });

  it("正文散文不计入体积校验（60KB 卡 + 10KB 正文通过）", () => {
    const cardContent = "x".repeat(60000); // 60KB 卡片
    const prose = "y".repeat(10000); // 10KB 正文
    const body = `${prose}\n\`\`\`html-card title="合规卡"\n${cardContent}\n\`\`\`\n${prose}`;
    expect(validateSpeakBody(undefined, body)).toBeNull();
  });

  it("卡片写在 speak 外被拒绝", () => {
    const turnText = '```html-card title="外"\n<div>outside</div>\n```';
    const body = "正文没有卡片";
    const result = validateSpeakBody(turnText, body);
    expect(result).toContain("speak 之外");
  });

  it("html-card-reply 不算卡片", () => {
    const body = '```html-card-reply card="m:0"\n{}\n```';
    expect(validateSpeakBody(undefined, body)).toBeNull();
  });

  // 嵌套围栏 under-measure 修复回归——改 remark 解析后体积完整测量。
  it("F20261022cfme：嵌套围栏（开4内嵌3）卡片体积完整测量——超上限被拒（修复前正则 under-measure 漏报）", () => {
    const big = "x".repeat(270000);
    const body = '````html-card title="嵌套大卡"\n<p>head</p>\n```\nembedded\n```\n' + big + '\n````';
    const result = validateSpeakBody(undefined, body);
    expect(result).toContain("超出");
    expect(result).toContain("体积限制");
  });

  it("F20261022cfme：嵌套围栏（开4内嵌3）卡片体积小——通过", () => {
    const body = '````html-card title="嵌套小卡"\n<p>head</p>\n```\nembedded\n```\n<div>tail</div>\n````';
    expect(validateSpeakBody(undefined, body)).toBeNull();
  });

  it("F20261022cfme：反引号开 + ~~~ 嵌套卡片体积完整测量——超上限被拒", () => {
    const big = "x".repeat(270000);
    const body = '```html-card title="波浪嵌套"\n<p>head</p>\n~~~\nembedded\n~~~\n' + big + '\n```';
    const result = validateSpeakBody(undefined, body);
    expect(result).toContain("超出");
    expect(result).toContain("体积限制");
  });

  it("F20261022cfme：嵌套围栏卡计数为 1 张（内嵌代码块不误计为独立卡，count/measure 同源）", () => {
    const one = '````html-card title="嵌套"\n<p>a</p>\n```\ncode\n```\n<b>b</b>\n````';
    expect(hasCardFences(one)).toBe(true);
    // 2 张嵌套卡同 message：计数应为 2（不超限），且内嵌围栏不额外计卡
    const two = one + '\n' + one;
    expect(validateSpeakBody(undefined, two)).toBeNull();
  });

  it("F20261022cfme（S2）：「卡片写在 speak 外」检测——body 有卡时不误报（presence 复用 count，remark 口径）", () => {
    const card = '```html-card title="a"\n<x/>\n```';
    // assistant 与 body 都有卡：不报「卡片写在 speak 外」（反向补全）
    expect(validateSpeakBody(card, card)).toBeNull();
  });

  // （补牙）：两条行为变化的有牙回归——旧正则下修复前红（case A 丢卡放行、case B 误拦）。
  it("F20261022cfme（S2 行为）：body 假围栏字样 + assistant 真卡——仍报 speak 之外（防静默丢卡回退）", () => {
    const turn = '```html-card title="外"\n<div>x</div>\n```';
    const body = '说明：\n\n    ```html-card\n    字样\n';
    expect(validateSpeakBody(turn, body)).toContain("speak 之外");
  });

  it("F20261022cfme（S2 行为）：assistant 散文提及围栏字样——不误报 speak 之外（防误拦回退）", () => {
    expect(validateSpeakBody("这里提到 ```html-card 这种写法", "正常正文")).toBeNull();
  });
});

describe("hasCardFences", () => {
  it("有卡片返回 true", () => {
    expect(hasCardFences('```html-card title="a"\n<x/>\n```')).toBe(true);
  });

  it("无卡片返回 false", () => {
    expect(hasCardFences("纯文本")).toBe(false);
  });

  it("html-card-reply 不算", () => {
    expect(hasCardFences('```html-card-reply card="m:0"\n{}\n```')).toBe(false);
  });
});

describe("truncateToolResult", () => {
  it("短结果不被截断", () => {
    const result = textResponse("hello world");
    const truncated = truncateToolResult(result);
    expect(truncated.content[0].text).toBe("hello world");
  });

  it("恰好 MAX_TOOL_RESULT_CHARS 字符的结果不被截断", () => {
    const text = "a".repeat(MAX_TOOL_RESULT_CHARS);
    const result = textResponse(text);
    const truncated = truncateToolResult(result);
    expect(truncated.content[0].text).toBe(text);
  });

  it("超过阈值的 text block 被截断并附加提示", () => {
    const longText = "x".repeat(20_000);
    const result = textResponse(longText);
    const truncated = truncateToolResult(result);
    expect(truncated.content[0].text).toContain("[结果已截断");
    expect(truncated.content[0].text).toContain("请缩小查询范围");
  });

  // 质疑 1 修复：JSON 截断必须走到条目边界分支，不能假通过
  it("JSON 数组在条目边界截断，结果是合法 JSON", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`,
      content: "x".repeat(1000),
      score: 0.5,
    }));
    const jsonText = JSON.stringify(entries);
    const result = textResponse(jsonText);
    const truncated = truncateToolResult(result);
    const text = truncated.content[0].text;

    // 截断提示存在（不泄露长度信息）
    expect(text).toContain("[结果已截断");
    expect(text).not.toMatch(/\d+ 字符/);

    // \n] 之前的部分必须是合法 JSON（条目边界截断）
    const bracketIdx = text.indexOf("\n]");
    expect(bracketIdx).toBeGreaterThan(0);
    const jsonPart = text.slice(0, bracketIdx + 2);
    const parsed = JSON.parse(jsonPart);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.length).toBeLessThan(20); // 确实截断了
    // 每个保留的条目结构完整
    expect(parsed[0]).toHaveProperty("id");
    expect(parsed[0]).toHaveProperty("content");
  });

  // 质疑 2 修复：非 JSON 文本截断路径
  it("非 JSON 长文本走纯字符截断，不产生 JSON 闭合", () => {
    const longText = "A".repeat(20_000);
    const result = textResponse(longText);
    const truncated = truncateToolResult(result);
    const text = truncated.content[0].text;

    // 被截断了
    expect(text).toContain("[结果已截断");
    // 不应以 \n] 结尾（不是 JSON 分支）
    expect(text).not.toMatch(/\n\]$/);
    // 截断后的主体部分长度 <= 阈值
    const tipIdx = text.indexOf("\n\n[结果已截断");
    expect(tipIdx).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });

  // 质疑 4 修复：多 block 时各 block 独立截断
  it("多 block 时各 block 独立截断，block 数量不变", () => {
    const result = {
      content: [
        { type: "text" as const, text: "x".repeat(20_000) },
        { type: "text" as const, text: "short" },
      ],
      details: {},
    };
    const truncated = truncateToolResult(result);
    expect(truncated.content.length).toBe(2);
    expect(truncated.content[0].text).toContain("[结果已截断");
    expect(truncated.content[1].text).toBe("short");
  });

  // 质疑 9 修复：details/terminate 透传
  it("details 和 terminate 字段透传不丢失", () => {
    const result = {
      content: [{ type: "text" as const, text: "hello" }],
      details: { foo: "bar", nested: { a: 1 } },
      terminate: true,
    };
    const truncated = truncateToolResult(result);
    expect(truncated.details).toEqual({ foo: "bar", nested: { a: 1 } });
    expect(truncated.terminate).toBe(true);
  });

  // 质疑 3 补充：大条目 JSON 退化路径
  it("JSON 数组单条目超阈值时退化到纯截断不崩溃", () => {
    const entries = [{ id: "e1", content: "x".repeat(16_000) }];
    const jsonText = JSON.stringify(entries);
    const result = textResponse(jsonText);
    const truncated = truncateToolResult(result);
    expect(truncated.content[0].text).toContain("[结果已截断");
  });

  // 观察 1 补充：嵌套 JSON 结构支持
  it("嵌套 JSON 结构（wrapper + array）在条目边界截断", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`,
      content: "x".repeat(1000),
    }));
    const jsonText = JSON.stringify({ data: entries, total: 20 });
    const result = textResponse(jsonText);
    const truncated = truncateToolResult(result);
    const text = truncated.content[0].text;

    expect(text).toContain("[结果已截断");
    // 应在数组内条目边界截断
    const arrStart = text.indexOf("[");
    expect(arrStart).toBeGreaterThanOrEqual(0);
    const bracketIdx = text.indexOf("\n]");
    expect(bracketIdx).toBeGreaterThan(arrStart);
  });

  // 观察 3 补充：空 JSON 数组
  it("空 JSON 数组不被截断", () => {
    const result = textResponse("[]");
    const truncated = truncateToolResult(result);
    expect(truncated.content[0].text).toBe("[]");
  });
});

/** 补丁：活类卡登记摘要提取——script/style 源码不得漏进摘要（乱码卡实证） */
describe("extractPlayableCardSummary（活类卡登记摘要）", () => {
  const gameHtml = `<div><div style="display:none">终章灰盒试玩：先占卜获取情报，召唤洞察獭补自测盲区，最后念出封印咒语。</div><div id="screen">镜湖。水面没有倒影。</div><div id="hud">幼獭 HP 100</div></div>
<script>
(function(){
  var S = { hp:100, mp:60, divined:false, ally:false };
  var TALKS = ['"力气就是一切。"', '"同伴？我自己就是全部。"'];
})();
</script>`;

  it("script 源码不漏进摘要（修复前此用例失败：摘要以 (function(){ 开头）", () => {
    const summary = extractPlayableCardSummary(gameHtml);
    expect(summary.startsWith("终章灰盒试玩")).toBe(true);
    expect(summary).not.toContain("(function");
    expect(summary).not.toContain("hp:100");
  });

  it("纯 script 卡退化为空摘要（登记侧显示「无可提取文本」）", () => {
    const onlyScript = '<div id="app"></div><script>var x = 1;</script>';
    expect(extractPlayableCardSummary(onlyScript)).toBe("");
  });

  it("style 块同样被剥除", () => {
    const withStyle = "<style>.hp{color:red}</style><div>血条 UI</div>";
    expect(extractPlayableCardSummary(withStyle)).toBe("血条 UI");
  });

  it("maxLen 截断生效", () => {
    const long = "<div>" + "很长".repeat(200) + "</div>";
    expect(extractPlayableCardSummary(long, 50).length).toBe(50);
  });
});

/** 检视处置 /（对抗审视，检视獭1396 报告） */
describe("extractPlayableCardSummary（检视处置补丁）", () => {
  it("A1：未闭合 script（截断卡）不漏源码——剥到结尾", () => {
    const truncated = '<div>镜湖开场文案</div><script>var S = { hp:100, mp:60, divined:false';
    const summary = extractPlayableCardSummary(truncated);
    expect(summary.startsWith("镜湖开场文案")).toBe(true);
    expect(summary).not.toContain("hp:100");
    expect(summary).not.toContain("var S");
  });

  it("A2：截断不产生孤立代理对（emoji 安全）", () => {
    const emoji = "🦦⚔️🐲".repeat(50); // 每字符 ≥1 个多码元 emoji
    const summary = extractPlayableCardSummary("<div>" + emoji + "</div>", 10);
    expect(summary).not.toMatch(/[\uD800-\uDBFF]$/); // 尾部不是高代理
    expect(summary).not.toMatch(/^[\uDC00-\uDFFF]/); // 开头不是低代理
    // 码点数恰为 10
    expect(Array.from(summary).length).toBe(10);
  });
});



/** 工具调用序列化泄漏剥离 */
describe("stripToolCallSerializationLeak", () => {
  // 真实事故字节（durable-sessions/30288072 entry 333 hexdump）：左尖括号 + 全角竖线
  // （U+FF5C）+ 大写 DSML + 全角竖线 + 标签名。用 Unicode 转义拼接，避免源码直写全角。
  const FULLWIDTH_BAR = "\uFF5C"; // 全角竖线
  const DSML_PREFIX = "\u003c" + FULLWIDTH_BAR + "DSML" + FULLWIDTH_BAR;
  const THINK_CLOSE = "\u003c/think\u003e"; // thinking 闭合标签

  it("无泄漏：原样返回且 leaked=false", () => {
    const r = stripToolCallSerializationLeak("正常发言内容");
    expect(r).toEqual({ body: "正常发言内容", leaked: false });
  });

  it("全角变体（真实事故字节）：截断到正文，清掉思维闭合标签残留", () => {
    const body =
      "你定个倾向，我据此把 P2 的触发写死。" + THINK_CLOSE + "\n\n" +
      DSML_PREFIX + "tool_calls>\n" +
      DSML_PREFIX + "invoke name=\"yield\">\n" +
      DSML_PREFIX + "parameter name=\"reason\" string=\"true\">已按搭档两点裁决修正方案";
    const r = stripToolCallSerializationLeak(body);
    expect(r.leaked).toBe(true);
    expect(r.body).toBe("你定个倾向，我据此把 P2 的触发写死。");
  });

  it("半角下划线锚点变体（issue 转写的半角分隔 + 思维闭合标签）：也命中", () => {
    const body = "正文。" + THINK_CLOSE + "\n\n<dsml_calls>\n<dsml_invoke name=\"yield\">";
    const r = stripToolCallSerializationLeak(body);
    expect(r.leaked).toBe(true);
    expect(r.body).toBe("正文。");
  });

  it("裸 invoke/parameter 标签不带 DSML 前缀：不误剥（检视发现：合法代码示例防截断）", () => {
    const body = "代码示例：\n```xml\n<invoke name=\"yield\">\n<parameter name=\"reason\" string=\"true\">\n```\n后续正文保留。";
    const r = stripToolCallSerializationLeak(body);
    expect(r.leaked).toBe(false);
    expect(r.body).toContain("后续正文保留");
  });

    it("围栏内展示全角 DSML 序列化示例（讨论本 bug 的合法场景）：不误剥（检视 delta 发现）", () => {
    const body = "事故字节如下：\n```\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name=\"yield\">\n```\n正文继续。";
    const r = stripToolCallSerializationLeak(body);
    expect(r.leaked).toBe(false);
    expect(r.body).toContain("正文继续");
  });

  it("围栏内展示半角 dsml_ 序列化示例：不误剥", () => {
    const body = "转写如下：\n```\n<dsml_calls>\n<dsml_invoke name=\"yield\">\n```\n后续正文。";
    const r = stripToolCallSerializationLeak(body);
    expect(r.leaked).toBe(false);
    expect(r.body).toContain("后续正文");
  });

it("剥离后为空串（整段都是泄漏）→ 由 validateSpeakBody 空检兜底拒绝", () => {
    // 思维闭合标签后带空行，与真实事故字节同构（若不带空行会被 remark 视为单个 HTML 块）
    const body = THINK_CLOSE + "\n\n" + DSML_PREFIX + "tool_calls>\n" + DSML_PREFIX + "invoke name=\"yield\">";
    const r = stripToolCallSerializationLeak(body);
    expect(r.leaked).toBe(true);
    expect(r.body).toBe("");
  });

  it("句号后接 DSML 示例再续正文：不误剥（检视 delta 发现）", () => {
    const body = "事故语法如下。\n" + DSML_PREFIX + "tool_calls>\n后面是分析正文。";
    const r = stripToolCallSerializationLeak(body);
    expect(r.leaked).toBe(false);
    expect(r.body).toContain("分析正文");
  });

  it("正文提及 invoke 一词但无标签语法：不误剥离", () => {
    const r = stripToolCallSerializationLeak("关于 invoke 工具的说明：先 speak 再 yield。");
    expect(r.leaked).toBe(false);
    expect(r.body).toContain("invoke 工具");
  });

  it("围栏内完整事故回放（含思维闭合标签 + DSML）：不误剥（检视 delta3 发现 🔴）", () => {
    const body =
      "事故 body 原文如下：\n```\n写死。 " + THINK_CLOSE + "\n\n" +
      DSML_PREFIX + "tool_calls>\n" + DSML_PREFIX + "invoke name=\"yield\">\n" +
      "```\n后续分析正文保留。";
    const r = stripToolCallSerializationLeak(body);
    expect(r.leaked).toBe(false);
    expect(r.body).toContain("后续分析正文保留");
  });

  it("行内代码内的完整事故回放（含思维闭合标签 + DSML）：不误剥（检视 delta4 发现 🔴）", () => {
    const body =
      "行内事故示例：`" + THINK_CLOSE + "\n" +
      DSML_PREFIX + "tool_calls>\n" + DSML_PREFIX + "invoke name=\"yield\">` 后续分析正文保留。";
    const r = stripToolCallSerializationLeak(body);
    expect(r.leaked).toBe(false);
    expect(r.body).toContain("后续分析正文保留");
  });

  it("HTML 原始块（pre）内的完整事故回放：不误剥（检视 delta5 发现 🔴）", () => {
    const PRE_OPEN = "\u003cpre\u003e";
    const PRE_CLOSE = "\u003c/pre\u003e";
    const body =
      PRE_OPEN + "写死。 " + THINK_CLOSE + "\n\n" +
      DSML_PREFIX + "tool_calls>\n" + DSML_PREFIX + "invoke name=\"yield\">\n" +
      PRE_CLOSE + "后续分析正文保留。";
    const r = stripToolCallSerializationLeak(body);
    expect(r.leaked).toBe(false);
    expect(r.body).toContain("后续分析正文保留");
  });

  it("行内 HTML code 包装内的完整事故回放：不误剥（检视 delta6 发现 🔴）", () => {
    const CODE_OPEN = "\u003ccode\u003e";
    const CODE_CLOSE = "\u003c/code\u003e";
    const body =
      CODE_OPEN + "正文 " + THINK_CLOSE + "\n" +
      DSML_PREFIX + "tool_calls>\n" + DSML_PREFIX + "invoke name=\"yield\">" +
      CODE_CLOSE + "后续分析正文保留。";
    const r = stripToolCallSerializationLeak(body);
    expect(r.leaked).toBe(false);
    expect(r.body).toContain("后续分析正文保留");
  });

  it("issue #1916 转写原形态（句号 + 英文 response 单词 + 半角 dsml_）：不剥（fail-open，转写失真非可靠指纹）", () => {
    const body = "…你定个倾向，我据此把 P2 的触发写死。 response\n\n<dsml_calls>\n<dsml_invoke name=\"yield\">";
    const r = stripToolCallSerializationLeak(body);
    expect(r.leaked).toBe(false);
    expect(r.body).toBe(body);
  });
});
