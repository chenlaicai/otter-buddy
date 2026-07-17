import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "@frameworks/agent/system-prompt-builder";
import type { OtterPromptConfig } from "@contract/api/otter";

describe("buildSystemPrompt", () => {
  /** 调用 buildSystemPrompt 并返回生成的 prompt 字符串 */
  function call(
    platformPrompt: string,
    otterConfig: OtterPromptConfig = {},
    dynamicContext?: { sessionSummary?: string; memoryRetrieval?: string },
  ): string {
    const fn = buildSystemPrompt(platformPrompt, otterConfig, dynamicContext);
    return fn({});
  }

  it("平台 prompt 单独注入", () => {
    const result = call("你是所有 AI 必须遵守的原则。");
    expect(result).toBe("你是所有 AI 必须遵守的原则。");
  });

  it("Otter prompt 单独注入（无平台 prompt）", () => {
    const result = call("", { systemPrompt: "你是一个翻译助手。" });
    expect(result).toBe("你是一个翻译助手。");
  });

  it("两层 prompt 叠加：平台 + Otter", () => {
    const result = call("平台铁律", { systemPrompt: "Otter 定义" });
    expect(result).toBe("平台铁律\n\nOtter 定义");
  });

  it("system reminder 注入", () => {
    const result = call("平台", {
      reminders: [{ content: "记得检查拼写", priority: "high" }],
    });
    expect(result).toContain("平台");
    expect(result).toContain("<system-reminder>\n记得检查拼写\n</system-reminder>");
  });

  it("system reminder 按优先级排序（high 优先）", () => {
    const result = call("平台", {
      reminders: [
        { content: "低优先级", priority: "low" },
        { content: "高优先级", priority: "high" },
        { content: "中优先级", priority: "medium" },
      ],
    });
    const highIdx = result.indexOf("高优先级");
    const midIdx = result.indexOf("中优先级");
    const lowIdx = result.indexOf("低优先级");
    expect(highIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(lowIdx);
  });

  it("动态上下文：会话摘要", () => {
    const result = call("平台", {}, { sessionSummary: "上次讨论了 X" });
    expect(result).toContain("## 会话摘要\n上次讨论了 X");
  });

  it("动态上下文：记忆检索结果", () => {
    const result = call("平台", {}, { memoryRetrieval: "记忆片段 (score: 0.95)" });
    expect(result).toContain("## 记忆检索结果\n记忆片段 (score: 0.95)");
  });

  it("完整组装：平台 + Otter + reminders + 动态上下文", () => {
    const result = call(
      "平台铁律",
      {
        systemPrompt: "你是翻译助手。",
        reminders: [{ content: "检查语法", priority: "high" }],
      },
      { sessionSummary: "摘要", memoryRetrieval: "记忆" },
    );
    const idxPlatform = result.indexOf("平台铁律");
    const idxOtter = result.indexOf("你是翻译助手。");
    const idxReminder = result.indexOf("<system-reminder>");
    const idxSession = result.indexOf("## 会话摘要");
    const idxMemory = result.indexOf("## 记忆检索结果");
    expect(idxPlatform).toBeLessThan(idxOtter);
    expect(idxOtter).toBeLessThan(idxReminder);
    expect(idxReminder).toBeLessThan(idxSession);
    expect(idxSession).toBeLessThan(idxMemory);
  });

  it("空 prompt 场景：全部为空时返回空字符串", () => {
    const result = call("", {});
    expect(result).toBe("");
  });

  it("无优先级的 reminder 视为 medium", () => {
    const result = call("平台", {
      reminders: [
        { content: "无优先级" },
        { content: "高优先级", priority: "high" },
      ],
    });
    const highIdx = result.indexOf("高优先级");
    const noIdx = result.indexOf("无优先级");
    expect(highIdx).toBeLessThan(noIdx);
  });
});
