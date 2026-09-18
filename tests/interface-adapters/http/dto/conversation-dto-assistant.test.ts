import { describe, it, expect } from "vitest";
import { toConversationDTO, isAssistantConversationTitle } from "@interface-adapters/http/dto/conversation-dto";
import type { Conversation } from "@entities/conversation/conversation";

/**
 * F20260918imas：助理对话 kind 标识测试（检视发现 2 处置——真相源零覆盖）。
 * isAssistantConversationTitle 是 DTO 层 kind 标识的唯一判定函数（SQL 侧排序
 * 用 LIKE 镜像同一前缀集，新增渠道需同步两处——见特性文档补丁节已知边界）。
 */
function convFixture(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    title: "普通对话",
    status: "active",
    summary: null,
    pinned: false,
    workspaceDir: null,
    createdAt: "2026-09-18T00:00:00Z",
    updatedAt: "2026-09-18T00:00:00Z",
    completedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

describe("isAssistantConversationTitle（F20260918imas）", () => {
  it("微信/飞书助理前缀判定为 true", () => {
    expect(isAssistantConversationTitle("微信助理 · x12345")).toBe(true);
    expect(isAssistantConversationTitle("飞书助理 · 张三")).toBe(true);
  });

  it("普通标题（含相似前缀变体）判定为 false", () => {
    expect(isAssistantConversationTitle("普通对话")).toBe(false);
    expect(isAssistantConversationTitle("微信助理研究")).toBe(false); // 缺分隔符「 · 」
    expect(isAssistantConversationTitle(" 微信助理 · x")).toBe(false); // 前导空格不匹配
    expect(isAssistantConversationTitle("")).toBe(false);
  });
});

describe("toConversationDTO kind 标识（F20260918imas）", () => {
  it("助理标题 → DTO 带 kind=assistant", () => {
    const dto = toConversationDTO(convFixture({ title: "微信助理 · x12345" }));
    expect(dto.kind).toBe("assistant");
  });

  it("普通标题 → DTO 无 kind 字段（缺省即普通，不显式传 undefined）", () => {
    const dto = toConversationDTO(convFixture({ title: "工作对话" }));
    expect("kind" in dto).toBe(false);
  });
});
