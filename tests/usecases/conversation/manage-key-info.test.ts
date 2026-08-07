import { describe, it, expect, vi } from "vitest";
import { ManageKeyInfo } from "@usecases/conversation/manage-key-info";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { MemoryIndexGateway } from "@usecases/conversation/memory-index-gateway";

function createMocks() {
  const repo = {
    linkResource: vi.fn().mockResolvedValue(undefined),
    getLinkedResources: vi.fn().mockResolvedValue([]),
    getLinkedResourceById: vi.fn().mockResolvedValue(null),
    getLinkedResourcesByGroup: vi.fn().mockResolvedValue([]),
    updateResourceStatus: vi.fn().mockResolvedValue(undefined),
    supersedeLinkedResource: vi.fn().mockResolvedValue(undefined),
    deleteLinkedResource: vi.fn().mockResolvedValue(undefined),
    flagResource: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConversationRepository;

  const memoryIndex = {
    indexMessage: vi.fn().mockResolvedValue(undefined),
    indexLinkedResource: vi.fn().mockResolvedValue(undefined),
  } as unknown as MemoryIndexGateway;

  return { repo, memoryIndex };
}

describe("ManageKeyInfo.linkResource validation", () => {
  it("throws when fact type has no content", async () => {
    const { repo, memoryIndex } = createMocks();
    const uc = new ManageKeyInfo(repo, memoryIndex);

    await expect(
      uc.linkResource({
        conversationId: "conv-1",
        resourceType: "fact",
        linkedBy: "user-1",
        autoLinked: false,
      }),
    ).rejects.toThrow("fact 类型资源必须提供 content");
  });

  it("throws when fact content is pure whitespace", async () => {
    const { repo, memoryIndex } = createMocks();
    const uc = new ManageKeyInfo(repo, memoryIndex);

    await expect(
      uc.linkResource({
        conversationId: "conv-1",
        resourceType: "fact",
        content: "   \t\n ",
        linkedBy: "user-1",
        autoLinked: false,
      }),
    ).rejects.toThrow("fact 类型资源必须提供 content");
  });

  it("throws when non-fact type has no url", async () => {
    const { repo, memoryIndex } = createMocks();
    const uc = new ManageKeyInfo(repo, memoryIndex);

    await expect(
      uc.linkResource({
        conversationId: "conv-1",
        resourceType: "pr",
        linkedBy: "user-1",
        autoLinked: false,
      }),
    ).rejects.toThrow("非 fact 类型资源必须提供 url");
  });

  it("creates fact resource with content", async () => {
    const { repo, memoryIndex } = createMocks();
    const uc = new ManageKeyInfo(repo, memoryIndex);

    const result = await uc.linkResource({
      conversationId: "conv-1",
      resourceType: "fact",
      content: "Important fact",
      linkedBy: "user-1",
      autoLinked: false,
    });

    expect(result.resourceType).toBe("fact");
    expect(result.content).toBe("Important fact");
    expect(result.url).toBeNull();
    expect(repo.linkResource).toHaveBeenCalledOnce();
    expect(memoryIndex.indexLinkedResource).toHaveBeenCalledOnce();
  });

  it("throws when fact content exceeds 500 characters", async () => {
    const { repo, memoryIndex } = createMocks();
    const uc = new ManageKeyInfo(repo, memoryIndex);

    const longContent = "x".repeat(501);
    await expect(
      uc.linkResource({
        conversationId: "conv-1",
        resourceType: "fact",
        content: longContent,
        linkedBy: "user-1",
        autoLinked: false,
      }),
    ).rejects.toThrow("fact 类型资源的 content 不能超过 500 字符");
  });

  it("creates fact resource with content at exactly 500 characters", async () => {
    const { repo, memoryIndex } = createMocks();
    const uc = new ManageKeyInfo(repo, memoryIndex);

    const exactContent = "x".repeat(500);
    const result = await uc.linkResource({
      conversationId: "conv-1",
      resourceType: "fact",
      content: exactContent,
      linkedBy: "user-1",
      autoLinked: false,
    });

    expect(result.resourceType).toBe("fact");
    expect(result.content).toBe(exactContent);
  });

  it("creates url resource with url", async () => {
    const { repo, memoryIndex } = createMocks();
    const uc = new ManageKeyInfo(repo, memoryIndex);

    const result = await uc.linkResource({
      conversationId: "conv-1",
      resourceType: "url",
      url: "https://example.com",
      linkedBy: "user-1",
      autoLinked: false,
    });

    expect(result.resourceType).toBe("url");
    expect(result.url).toBe("https://example.com");
    expect(result.content).toBeNull();
  });
});

describe("ManageKeyInfo.supersedeResource validation", () => {
  it("throws when fact type has no content", async () => {
    const { repo, memoryIndex } = createMocks();
    const uc = new ManageKeyInfo(repo, memoryIndex);

    await expect(
      uc.supersedeResource("existing-id", {
        conversationId: "conv-1",
        resourceType: "fact",
        linkedBy: "user-1",
        autoLinked: false,
      }, 1),
    ).rejects.toThrow("fact 类型资源必须提供 content");
  });

  it("throws when non-fact type has no url", async () => {
    const { repo, memoryIndex } = createMocks();
    const uc = new ManageKeyInfo(repo, memoryIndex);

    await expect(
      uc.supersedeResource("existing-id", {
        conversationId: "conv-1",
        resourceType: "worktree",
        linkedBy: "user-1",
        autoLinked: false,
      }, 1),
    ).rejects.toThrow("非 fact 类型资源必须提供 url");
  });
});
