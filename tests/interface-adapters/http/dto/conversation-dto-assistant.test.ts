import { describe, it, expect } from "vitest";
import { toConversationDTO, isAssistantConversationTitle } from "@interface-adapters/http/dto/conversation-dto";
import { normalizeConversationInput } from "@entities/conversation/conversation";
import type { Conversation } from "@entities/conversation/conversation";

/**
 * F20260918imas / F20260920imax：助理对话 kind 标识测试。
 * F20260920imax：真相源已从 title 前缀约定改为 schema 字段 conversation.kind
 * （存量库迁移回填，见 migration.ts ensureConversationsKindColumn）；
 * isAssistantConversationTitle 仅供迁移回填与展示用途。
 */
function convFixture(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    title: "普通对话",
    status: "active",
    summary: null,
    pinned: false,
    kind: "normal",
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

describe("toConversationDTO kind 标识（F20260920imax：schema 字段真相源）", () => {
  it("kind=assistant → DTO 带 kind=assistant（不再依赖标题前缀）", () => {
    const dto = toConversationDTO(convFixture({ title: "家人对话", kind: "assistant" }));
    expect(dto.kind).toBe("assistant");
  });

  it("kind=normal（即便标题带助理前缀）→ DTO 无 kind 字段", () => {
    const dto = toConversationDTO(convFixture({ title: "微信助理 · x12345", kind: "normal" }));
    expect("kind" in dto).toBe(false);
  });

  // 检视发现 3 补：迁移前存量语义边界（实体层 kind 必填，缺省场景由
  // rowToConversation/normalizeConversationInput 归一化为 normal——DTO 侧不出现 undefined 流入）
  it("构造层归一化：缺省 kind 由 normalizeConversationInput 补 normal，DTO 不含 kind", () => {
    const normalized = normalizeConversationInput({ ...convFixture(), kind: undefined });
    expect(normalized.kind).toBe("normal");
    expect("kind" in toConversationDTO(normalized)).toBe(false);
  });
});
