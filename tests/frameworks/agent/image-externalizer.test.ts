import { describe, it, expect } from "vitest";
import { externalizeHistoricalImages } from "@frameworks/agent/image-externalizer";

/** 构造 assistant 消息（匹配 SDK AssistantMessage 结构） */
function assistant(content: Array<{ type: string; [k: string]: unknown }>) {
  return { role: "assistant" as const, content, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: "stop" as const, api: "anthropic-messages" as const, provider: "glm" as const, model: "glm-4.6", timestamp: Date.now() };
}

/** 构造 user 消息 */
function user(text: string) {
  return { role: "user" as const, content: text, timestamp: Date.now() };
}

/** 构造 toolResult 消息 */
function toolResult(content: Array<{ type: string; [k: string]: unknown }>, toolCallId = "tc-1", toolName = "read") {
  return { role: "toolResult" as const, toolCallId, toolName, content, isError: false, timestamp: Date.now() };
}

/** 构造 image 块（匹配 SDK ImageContent） */
function image(data = "iVBORw0KGgoAAAANSUhEUg==", mimeType = "image/png") {
  return { type: "image" as const, data, mimeType };
}

/** 构造 text 块 */
function textBlock(t: string) {
  return { type: "text" as const, text: t };
}

/** 构造 read 工具调用块 */
function readCall(path: string, id = "tc-read-1") {
  return { type: "toolCall" as const, id, name: "read", arguments: { path } };
}

/** 构造 read 工具调用块（file_path 参数形态） */
function readCallFilePath(path: string, id = "tc-read-fp") {
  return { type: "toolCall" as const, id, name: "read", arguments: { file_path: path } };
}

/** 典型读图三元组：assistant(toolCall read) → toolResult(text+image) → assistant(text 分析) */
function imageReadTriplet(path: string, analysis: string, tcId: string, img?: ReturnType<typeof image>) {
  return [
    assistant([readCall(path, tcId)]),
    toolResult([textBlock(`Read image file [${img?.mimeType ?? "image/png"}]`), img ?? image()], tcId),
    assistant([textBlock(analysis)]),
  ];
}

describe("externalizeHistoricalImages", () => {
  it("历史图片（上一 turn）文本化为三段式占位符：所见摘录 + 来源路径 + 尺寸", () => {
    const messages = [
      user("验收一下页面"),
      ...imageReadTriplet("web/dist/index.html 截图.png", "页面骨架渲染成功但数据全空——API 请求没吃到 mock。", "tc-1"),
      user("继续修"),
      assistant([textBlock("当前 turn 的回复")]),
    ];

    const result = externalizeHistoricalImages(messages);

    const projected = result[2]; // toolResult
    expect(projected.content[0]).toEqual(textBlock("Read image file [image/png]")); // text 块不动
    expect(projected.content[1].type).toBe("text");
    expect(projected.content[1].text).toBe(
      "[图片已外置 | 所见: 页面骨架渲染成功但数据全空——API 请求没吃到 mock。 | web/dist/index.html 截图.png image/png 18B]",
    );
    // 其他消息原引用不动
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);
    expect(result[3]).toBe(messages[3]);
    expect(result[4]).toBe(messages[4]);
  });

  it("当轮图片（最后一个 user 之后）原样保留", () => {
    const messages = [
      user("先读一张"),
      ...imageReadTriplet("a.png", "第一张图的分析。", "tc-1"),
      user("再读一张对比"),
      assistant([readCall("b.png", "tc-2")]),
      toolResult([textBlock("Read image file [image/png]"), image("AAA=")], "tc-2"),
    ];

    const result = externalizeHistoricalImages(messages);

    // 历史区（tc-1）：文本化
    expect(result[2].content[1].type).toBe("text");
    // 当轮区（tc-2）：原引用，image 块完整保留
    expect(result[6]).toBe(messages[6]);
    expect(result[6].content[1]).toEqual(image("AAA="));
  });

  it("同一 invoke 内多步工具调用链中的图片属当轮，保留", () => {
    // user → assistant(toolCall) → toolResult(image) → assistant(toolCall 又调别的) → toolResult → ……
    // 链中没有新的 user：整个链都是当前 turn，读图后模型可能还要看图继续操作
    const img = image();
    const messages = [
      user("读图后告诉我尺寸"),
      assistant([readCall("icon.png", "tc-1")]),
      toolResult([textBlock("Read image file [image/png]"), img], "tc-1"),
      assistant([{ type: "toolCall" as const, id: "tc-2", name: "bash", arguments: { command: "identify icon.png" } }]),
      toolResult([textBlock("256x256")], "tc-2", "bash"),
    ];

    const result = externalizeHistoricalImages(messages);

    expect(result[2]).toBe(messages[2]); // 原引用，image 保留
  });

  it("读图后无 assistant text → 退化为纯元数据占位符，不阻塞", () => {
    const messages = [
      user("读图"),
      assistant([readCall("c.png", "tc-1")]),
      toolResult([textBlock("Read image file [image/png]"), image()], "tc-1"),
      // 读图后 assistant 只调工具没有 text
      assistant([readCall("d.png", "tc-2")]),
      toolResult([textBlock("Read image file [image/png]"), image()], "tc-2"),
      user("下一条"),
    ];

    const result = externalizeHistoricalImages(messages);

    // tc-1 的摘录取自 tc-2 toolResult 之前？——tc-1 之后没有任何 assistant text（链中无 text），
    // 但边界外也没有（最后 user 之后无 assistant）→ 纯元数据
    expect(result[2].content[1].text).toBe("[图片已外置 | c.png image/png 18B]");
    // tc-2 之后同样无 assistant text → 纯元数据
    expect(result[4].content[1].text).toBe("[图片已外置 | d.png image/png 18B]");
  });

  it("摘录不限紧邻：读图后隔着一个工具调用对的 assistant text 也能摘到", () => {
    const messages = [
      user("看图排查"),
      assistant([readCall("e.png", "tc-1")]),
      toolResult([textBlock("Read image file [image/png]"), image()], "tc-1"),
      assistant([{ type: "toolCall" as const, id: "tc-2", name: "bash", arguments: { command: "ls" } }]),
      toolResult([textBlock("file list")], "tc-2", "bash"),
      assistant([textBlock("图里看到报错弹窗遮挡了提交按钮。")]),
      user("修吧"),
    ];

    const result = externalizeHistoricalImages(messages);

    expect(result[2].content[1].text).toBe(
      "[图片已外置 | 所见: 图里看到报错弹窗遮挡了提交按钮。 | e.png image/png 18B]",
    );
  });

  it("多图场景：同 toolResult 内多 image 块 + 多个历史 toolResult 全部文本化", () => {
    const messages = [
      user("对比三张截图"),
      assistant([readCall("s1.png", "tc-1")]),
      toolResult([textBlock("Read image file [image/png]"), image("AAA="), image("BBB=")], "tc-1"),
      assistant([textBlock("三张截图的布局差异如下。")]),
      assistant([readCall("s2.png", "tc-2")]),
      toolResult([textBlock("Read image file [image/png]"), image("CCC=")], "tc-2"),
      assistant([textBlock("第二张的间距问题更明显。")]),
      user("好"),
      assistant([textBlock("收尾")]),
    ];

    const result = externalizeHistoricalImages(messages);

    // tc-1（同 toolResult 双图）：摘录取自其后首条 assistant text（「三张截图的布局差异如下。」）
    expect(result[2].content[1].text).toContain("[图片已外置 | 所见: 三张截图的布局差异如下。 | s1.png");
    expect(result[2].content[2].text).toContain("[图片已外置 | 所见: 三张截图的布局差异如下。 | s1.png");
    expect(result[2].content[1].text).toContain("3B"); // AAA= → 3 字节
    // tc-2 的摘录取自其后的 text
    expect(result[5].content[1].text).toBe("[图片已外置 | 所见: 第二张的间距问题更明显。 | s2.png image/png 3B]");
  });

  it("来源路径支持 file_path 参数形态；无 read 配对（toolCall 缺失）时占位符无路径段", () => {
    const messages = [
      user("看图"),
      assistant([readCallFilePath("/tmp/fp.png", "tc-fp")]),
      toolResult([textBlock("x"), image()], "tc-fp"),
      toolResult([textBlock("orphan"), image()], "tc-orphan"), // 无配对 toolCall
      assistant([textBlock("两张都看到了。")]),
      user("继续"),
    ];

    const result = externalizeHistoricalImages(messages);

    expect(result[2].content[1].text).toBe("[图片已外置 | 所见: 两张都看到了。 | /tmp/fp.png image/png 18B]");
    // 孤儿 toolResult：无路径段，元数据仍在
    expect(result[3].content[1].text).toBe("[图片已外置 | 所见: 两张都看到了。 | image/png 18B]");
  });

  it("摘录超 150 字截断并加省略号；无标点长句硬截断", () => {
    const longSentence = "这是一段很长很长的分析文字，".repeat(30) + "结尾。";
    const noPunct = "无标点".repeat(100);
    const messages = [
      user("读图"),
      assistant([readCall("g.png", "tc-1")]),
      toolResult([textBlock("x"), image()], "tc-1"),
      assistant([textBlock(longSentence)]),
      assistant([readCall("h.png", "tc-2")]),
      toolResult([textBlock("x"), image()], "tc-2"),
      assistant([textBlock(noPunct)]),
      user("继续"),
    ];

    const result = externalizeHistoricalImages(messages);

    const excerpt1 = result[2].content[1].text;
    expect(excerpt1.length).toBeLessThan(200);
    expect(excerpt1).toContain("…");
    const excerpt2 = result[5].content[1].text;
    expect(excerpt2).toContain("…");
    // 摘录主体 ≤150 字（+「所见: 」前缀 + 省略号 + 元数据模板）
    const body = excerpt2.match(/所见: (.*)… \|/)?.[1];
    expect(body!.length).toBeLessThanOrEqual(150);
  });

  it("无图片的消息数组原样返回（零拷贝）", () => {
    const messages = [
      user("普通问题"),
      assistant([textBlock("普通回答")]),
      user("继续"),
      assistant([textBlock("继续回答")]),
    ];
    const result = externalizeHistoricalImages(messages);
    expect(result).toBe(messages);
  });

  it("空数组与全当轮（无边界消息）原样返回", () => {
    expect(externalizeHistoricalImages([])).toEqual([]);
    const currentTurnOnly = [
      assistant([readCall("x.png", "tc-1")]),
      toolResult([textBlock("x"), image()], "tc-1"),
    ];
    const result = externalizeHistoricalImages(currentTurnOnly);
    expect(result[1]).toBe(currentTurnOnly[1]); // 无 user/compactionSummary 边界 → 全部当轮，保留
  });

  it("compactionSummary 也构成 turn 边界：压缩前的图片文本化", () => {
    // SDK createCompactionSummaryMessage 真实结构：{ role, summary, tokensBefore, timestamp }（无 content 字段）
    const summary = { role: "compactionSummary" as const, summary: "摘要", tokensBefore: 1000, timestamp: Date.now() };
    const messages = [
      user("读图"),
      assistant([readCall("old.png", "tc-1")]),
      toolResult([textBlock("x"), image()], "tc-1"),
      assistant([textBlock("老图的分析。")]),
      summary,
      assistant([readCall("new.png", "tc-2")]),
      toolResult([textBlock("x"), image("NEW=")], "tc-2"),
    ];

    const result = externalizeHistoricalImages(messages);

    expect(result[2].content[1].text).toBe("[图片已外置 | 所见: 老图的分析。 | old.png image/png 18B]");
    expect(result[6]).toBe(messages[6]); // 压缩点之后 = 当前 turn，保留
  });

  it("真实 session 对照（issue #779 现场结构）：9 张截图中仅最后一张（当轮）保留", () => {
    // 模拟《健康面板404》session 结构：同一界面重复读 3-4 遍的验收流
    const messages: any[] = [user("验收 UI，截图给我看")];
    for (let i = 1; i <= 9; i++) {
      messages.push(
        assistant([readCall(`shot-${i}.png`, `tc-${i}`)]),
        toolResult([textBlock("Read image file [image/png]"), image(`BASE64_${i}`)], `tc-${i}`),
        assistant([textBlock(`第 ${i} 次验收：骨架渲染正常。`)]),
      );
    }
    messages.push(user("第 9 张还有问题，再截一张对比"), assistant([readCall("shot-10.png", "tc-10")]), toolResult([textBlock("Read image file [image/png]"), image("BASE64_10")], "tc-10"));

    const result = externalizeHistoricalImages(messages);

    // 前 9 张全部文本化
    for (let i = 1; i <= 9; i++) {
      const tr = result[1 + (i - 1) * 3 + 1];
      expect(tr.content[1].type).toBe("text");
      expect(tr.content[1].text).toContain(`shot-${i}.png`);
      expect(tr.content[1].text).toContain(`第 ${i} 次验收`);
      expect(tr.content[1].text).not.toContain("BASE64");
    }
    // 第 10 张（当轮）保留
    const last = result[result.length - 1];
    expect(last.content[1]).toEqual(image("BASE64_10"));
  });

  it("assistant 的 text 块为空串/纯空白时跳过（继续找下一条）", () => {
    const messages = [
      user("读图"),
      assistant([readCall("k.png", "tc-1")]),
      toolResult([textBlock("x"), image()], "tc-1"),
      assistant([textBlock("   ")]),
      assistant([textBlock("真正的分析。")]),
      user("继续"),
    ];

    const result = externalizeHistoricalImages(messages);
    expect(result[2].content[1].text).toBe("[图片已外置 | 所见: 真正的分析。 | k.png image/png 18B]");
  });

  it("检视发现 1 回归：同 turn 无 assistant text 时摘录不跨 turn 抓换话题后的无关 text", () => {
    const messages = [
      user("读图 A"),
      assistant([readCall("a.png", "tc-1")]),
      toolResult([textBlock("x"), image()], "tc-1"),
      // 读图后 assistant 只调工具没写分析
      assistant([readCall("b.png", "tc-2")]),
      toolResult([textBlock("y"), image()], "tc-2"),
      user("做别的"), // turn 边界
      assistant([textBlock("别的分析，与图 A 无关。")]),
    ];

    const result = externalizeHistoricalImages(messages);

    // 图 A 的摘录不得抓到「别的分析」（跨 turn 张冠李戴）——同 turn 无 text，退化纯元数据
    expect(result[2].content[1].text).toBe("[图片已外置 | a.png image/png 18B]");
    // 图 B 同 turn 内仍无 text（其后 user 前无 assistant text）→ 纯元数据
    expect(result[4].content[1].text).toBe("[图片已外置 | b.png image/png 18B]");
  });
});
