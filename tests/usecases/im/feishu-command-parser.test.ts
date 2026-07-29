import { describe, it, expect } from "vitest";
import {
  parseCommand,
  formatConversationList,
  formatMessageHistory,
  HELP_TEXT,
} from "@usecases/im/feishu-command-parser";

describe("parseCommand", () => {
  it("解析 /list 命令", () => {
    expect(parseCommand("/list")).toEqual({ command: "list" });
    expect(parseCommand("  /list  ")).toEqual({ command: "list" });
  });

  it("解析 /in 命令", () => {
    expect(parseCommand("/in conv-1")).toEqual({ command: "in", conversationId: "conv-1" });
    expect(parseCommand("  /in conv-123  ")).toEqual({ command: "in", conversationId: "conv-123" });
  });

  it("解析 /history 命令", () => {
    expect(parseCommand("/history")).toEqual({ command: "history" });
    expect(parseCommand("  /history  ")).toEqual({ command: "history" });
  });

  it("解析 /help 命令", () => {
    expect(parseCommand("/help")).toEqual({ command: "help" });
    expect(parseCommand("  /help  ")).toEqual({ command: "help" });
  });

  it("解析未知命令", () => {
    expect(parseCommand("/unknown")).toEqual({ command: "unknown", raw: "/unknown" });
    expect(parseCommand("hello")).toEqual({ command: "unknown", raw: "hello" });
    expect(parseCommand("/in")).toEqual({ command: "unknown", raw: "/in" });
    expect(parseCommand("/in   ")).toEqual({ command: "unknown", raw: "/in" }); // trim 后
  });
});

describe("formatConversationList", () => {
  it("空列表返回提示", () => {
    expect(formatConversationList([])).toBe("当前没有活跃的对话");
  });

  it("格式化单个对话", () => {
    const result = formatConversationList([
      { id: "conv-1", title: "测试对话" },
    ]);
    expect(result).toBe("活跃对话列表:\n1. 测试对话 (conv-1)");
  });

  it("格式化多个对话", () => {
    const result = formatConversationList([
      { id: "conv-1", title: "对话一" },
      { id: "conv-2", title: "对话二" },
    ]);
    expect(result).toBe("活跃对话列表:\n1. 对话一 (conv-1)\n2. 对话二 (conv-2)");
  });

  it("显示占用状态", () => {
    const result = formatConversationList([
      { id: "conv-1", title: "对话一", occupiedBy: "飞书群A" },
      { id: "conv-2", title: "对话二" },
    ]);
    expect(result).toBe("活跃对话列表:\n1. 对话一 (conv-1) [占用: 飞书群A]\n2. 对话二 (conv-2)");
  });
});

describe("formatMessageHistory", () => {
  it("空列表返回提示", () => {
    expect(formatMessageHistory([])).toBe("暂无历史消息");
  });

  it("格式化用户消息", () => {
    const result = formatMessageHistory([
      { senderType: "user", body: "你好", createdAt: "2026-07-29T10:00:00Z" },
    ]);
    expect(result).toContain("用户");
    expect(result).toContain("你好");
  });

  it("格式化 Otter 消息", () => {
    const result = formatMessageHistory([
      { senderType: "otter", body: "你好！有什么可以帮助你的？", createdAt: "2026-07-29T10:01:00Z" },
    ]);
    expect(result).toContain("水獭");
    expect(result).toContain("你好！有什么可以帮助你的？");
  });

  it("格式化系统消息", () => {
    const result = formatMessageHistory([
      { senderType: "system", body: "小獭加入了对话", createdAt: "2026-07-29T10:02:00Z" },
    ]);
    expect(result).toContain("系统");
    expect(result).toContain("小獭加入了对话");
  });

  it("处理空消息体", () => {
    const result = formatMessageHistory([
      { senderType: "user", body: null, createdAt: "2026-07-29T10:00:00Z" },
    ]);
    expect(result).toContain("(空消息)");
  });

  it("格式化多条消息", () => {
    const result = formatMessageHistory([
      { senderType: "user", body: "消息一", createdAt: "2026-07-29T10:00:00Z" },
      { senderType: "otter", body: "消息二", createdAt: "2026-07-29T10:01:00Z" },
    ]);
    expect(result).toContain("最近消息:");
    expect(result).toContain("消息一");
    expect(result).toContain("消息二");
  });
});

describe("HELP_TEXT", () => {
  it("包含所有命令说明", () => {
    expect(HELP_TEXT).toContain("/list");
    expect(HELP_TEXT).toContain("/in");
    expect(HELP_TEXT).toContain("/history");
    expect(HELP_TEXT).toContain("/help");
  });
});
