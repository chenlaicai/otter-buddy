/**
 * parseMentionsFromText 单元测试（F20260820i333）。
 *
 * 纯函数测试，不依赖数据库。
 */
import { describe, it, expect } from "vitest";
import { parseMentionsFromText } from "@usecases/conversation/mention-parser";

const participants = [
  { otterId: "id-big", otterName: "大獭" },
  { otterId: "id-small", otterName: "小獭" },
  { otterId: "id-debug", otterName: "debug-獭" },
];

describe("parseMentionsFromText", () => {
  it("无 @ 提及时返回空", () => {
    const r = parseMentionsFromText("普通消息", participants);
    expect(r.resolvedIds).toEqual([]);
    expect(r.invalidNames).toEqual([]);
  });

  it("解析单个 @ 提及（名字后有空格）", () => {
    const r = parseMentionsFromText("@大獭 请帮忙看看", participants);
    expect(r.resolvedIds).toEqual(["id-big"]);
    expect(r.invalidNames).toEqual([]);
  });

  it("F20260916ment：@ 紧贴前字在消息末尾（请帮忙@小獭）不算点名——词边界规则的既定代价", () => {
    // 搭档批准的取舍：中文行文「问一下@某人」里 @ 紧贴前字，按 Twitter 词边界规则不算点名；
    // 正确写法是 @ 前加空格（见下方「空白后 @ 正常触发」用例）
    const r = parseMentionsFromText("请帮忙@小獭", participants);
    expect(r.resolvedIds).toEqual([]);
    expect(r.invalidNames).toEqual([]);
  });

  it("解析 @ 后跟中文标点", () => {
    const r = parseMentionsFromText("@大獭，你好", participants);
    expect(r.resolvedIds).toEqual(["id-big"]);
    expect(r.invalidNames).toEqual([]);
  });

  it("F20260916ment：@ 紧贴前字后跟句号（问一下@大獭。）不算点名", () => {
    const r = parseMentionsFromText("问一下@大獭。", participants);
    expect(r.resolvedIds).toEqual([]);
    expect(r.invalidNames).toEqual([]);
  });

  it("解析多个 @ 提及", () => {
    const r = parseMentionsFromText("@大獭 @小獭 你们俩一起", participants);
    expect(r.resolvedIds).toEqual(["id-big", "id-small"]);
    expect(r.invalidNames).toEqual([]);
  });

  it("多个 @ 提及去重", () => {
    const r = parseMentionsFromText("@大獭 问 @大獭 两次", participants);
    expect(r.resolvedIds).toEqual(["id-big"]);
    expect(r.invalidNames).toEqual([]);
  });

  it("识别无效名字（不在场成员）", () => {
    const r = parseMentionsFromText("@不存在的獭 你好", participants);
    expect(r.resolvedIds).toEqual([]);
    expect(r.invalidNames).toEqual(["不存在的獭"]);
  });

  it("混合有效和无效名字", () => {
    const r = parseMentionsFromText("@大獭 @幽灵獭 帮忙", participants);
    expect(r.resolvedIds).toEqual(["id-big"]);
    expect(r.invalidNames).toEqual(["幽灵獭"]);
  });

  it("名字后紧跟感叹号", () => {
    const r = parseMentionsFromText("@大獭！", participants);
    expect(r.resolvedIds).toEqual(["id-big"]);
    expect(r.invalidNames).toEqual([]);
  });

  it("名字后跟问号", () => {
    const r = parseMentionsFromText("@小獭？", participants);
    expect(r.resolvedIds).toEqual(["id-small"]);
    expect(r.invalidNames).toEqual([]);
  });

  it("含连字符的名字（debug-獭）", () => {
    const r = parseMentionsFromText("@debug-獭 帮忙排查", participants);
    expect(r.resolvedIds).toEqual(["id-debug"]);
    expect(r.invalidNames).toEqual([]);
  });

  it("NFC 归一化：兼容 NFD 编码的名字", () => {
    // "小獭" 的 NFD 形式
    const nfdName = "小獭".normalize("NFD");
    const nfdParticipants = [
      { otterId: "id-small", otterName: nfdName },
    ];
    const r = parseMentionsFromText("@小獭 hello", nfdParticipants);
    expect(r.resolvedIds).toEqual(["id-small"]);
  });

  it("英文名字也支持", () => {
    const enParticipants = [
      { otterId: "id-1", otterName: "Alice" },
    ];
    const r = parseMentionsFromText("@Alice hello", enParticipants);
    expect(r.resolvedIds).toEqual(["id-1"]);
  });

  it("空文本返回空", () => {
    const r = parseMentionsFromText("", participants);
    expect(r.resolvedIds).toEqual([]);
    expect(r.invalidNames).toEqual([]);
  });

  it("只有 @ 符号没有名字", () => {
    const r = parseMentionsFromText("@ hello", participants);
    expect(r.resolvedIds).toEqual([]);
    expect(r.invalidNames).toEqual([]);
  });

  it("@ 后跟空格再跟名字不算 @ 提及", () => {
    // @ 紧跟空格，没有匹配到名字
    const r = parseMentionsFromText("@ 大獭", participants);
    expect(r.resolvedIds).toEqual([]);
    expect(r.invalidNames).toEqual([]);
  });

  // F20260916ment：Twitter 词边界规则——@ 前必须是行首/空白/中文标点，
  // 防止行文「在@功能」「npm 包 @scope/pkg@latest」被当成点名（issue 现场回归）
  it("F20260916ment：@ 紧贴前字（在@功能来触发）不算点名", () => {
    const r = parseMentionsFromText("但是系统还当作是在@功能来触发，然后还报错", participants);
    expect(r.resolvedIds).toEqual([]);
    expect(r.invalidNames).toEqual([]);
  });

  it("F20260916ment：npm 包版本号（xxx@latest）不算点名", () => {
    const r = parseMentionsFromText("升级到 openclaw-weixin-cli@latest 试试", participants);
    expect(r.resolvedIds).toEqual([]);
    expect(r.invalidNames).toEqual([]);
  });

  it("F20260916ment：行首 @ 正常触发（词边界含字符串开头）", () => {
    const r = parseMentionsFromText("@大獭 看下这个", participants);
    expect(r.resolvedIds).toEqual(["id-big"]);
  });

  it("F20260916ment：空白后 @ 正常触发", () => {
    const r = parseMentionsFromText("问一下 @大獭 和 @小獭", participants);
    expect(r.resolvedIds).toEqual(["id-big", "id-small"]);
  });

  it("F20260916ment：中文标点后 @ 正常触发", () => {
    const r = parseMentionsFromText("问过了，@大獭 说可以", participants);
    expect(r.resolvedIds).toEqual(["id-big"]);
  });
});
