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

describe("ManageKeyInfo - F20260821scrt secrets 脱敏", () => {
  it("fact content 含密钥时本体表存脱敏后内容", async () => {
    const { repo, memoryIndex } = createMocks();
    const uc = new ManageKeyInfo(repo, memoryIndex);

    await uc.linkResource({
      conversationId: "conv-1",
      resourceType: "fact",
      content: "部署密钥是 api_key: 0123456789abcdef01234567",
      linkedBy: "user-1",
      autoLinked: false,
    }, 1);

    const resource = (repo.linkResource as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(resource.content).not.toContain("0123456789abcdef");
    expect(resource.content).toContain("[REDACTED]");
  });

  it("metadata 字符串值含密钥时同样脱敏", async () => {
    const { repo, memoryIndex } = createMocks();
    const uc = new ManageKeyInfo(repo, memoryIndex);

    await uc.linkResource({
      conversationId: "conv-1",
      resourceType: "fact",
      content: "普通事实",
      metadata: { note: "密码: hunter2xx" },
      linkedBy: "user-1",
      autoLinked: false,
    }, 1);

    const resource = (repo.linkResource as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(String(resource.metadata.note)).not.toContain("hunter2xx");
  });

  it("普通 content 与 metadata 原样保存", async () => {
    const { repo, memoryIndex } = createMocks();
    const uc = new ManageKeyInfo(repo, memoryIndex);

    await uc.linkResource({
      conversationId: "conv-1",
      resourceType: "fact",
      content: "项目约定：部署走 worktree",
      metadata: { count: 2 },
      linkedBy: "user-1",
      autoLinked: false,
    }, 1);

    const resource = (repo.linkResource as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(resource.content).toBe("项目约定：部署走 worktree");
    expect(resource.metadata).toEqual({ count: 2 });
  });
});

describe("ManageKeyInfo - 二轮审视#5 索引侧传脱敏后内容", () => {
  it("indexLinkedResource 收到的 fact 内容已脱敏（不依赖 StoreMemory 二次脱敏）", async () => {
    const { repo, memoryIndex } = createMocks();
    const uc = new ManageKeyInfo(repo, memoryIndex);

    await uc.linkResource({
      conversationId: "conv-1",
      resourceType: "fact",
      content: "密钥是 api_key: 0123456789abcdef01234567",
      linkedBy: "user-1",
      autoLinked: false,
    }, 1);

    const indexedContent = (memoryIndex.indexLinkedResource as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(String(indexedContent)).not.toContain("0123456789abcdef");
    expect(String(indexedContent)).toContain("[REDACTED]");
  });
});

describe("ManageKeyInfo - F20260829gvid groupId 必填校验（#580）", () => {
  it("linkResource: worktree 无 groupId 时拒绝（gssf/ptun 两次漏传的根因场景）", async () => {
    const { repo, memoryIndex } = createMocks();
    const uc = new ManageKeyInfo(repo, memoryIndex);

    await expect(
      uc.linkResource({
        conversationId: "conv-1",
        resourceType: "worktree",
        url: "/wt/feature-x",
        linkedBy: "user-1",
        autoLinked: false,
      }),
    ).rejects.toThrow("必须提供 groupId");
  });

  it("linkResource: branch 纯空白 groupId 视为漏传", async () => {
    const { repo, memoryIndex } = createMocks();
    const uc = new ManageKeyInfo(repo, memoryIndex);

    await expect(
      uc.linkResource({
        conversationId: "conv-1",
        resourceType: "branch",
        url: "feature/x",
        groupId: "   ",
        linkedBy: "user-1",
        autoLinked: false,
      }),
    ).rejects.toThrow("必须提供 groupId");
  });

  it("linkResource: pr 带 groupId 正常创建", async () => {
    const { repo, memoryIndex } = createMocks();
    const uc = new ManageKeyInfo(repo, memoryIndex);

    const result = await uc.linkResource({
      conversationId: "conv-1",
      resourceType: "pr",
      url: "https://github.com/x/y/pull/1",
      groupId: "F20260829gvid",
      linkedBy: "user-1",
      autoLinked: false,
    });

    expect(result.groupId).toBe("F20260829gvid");
    expect(repo.linkResource).toHaveBeenCalledOnce();
  });

  it("linkResource: fact / url / file 类型 groupId 仍可选（散点事实与临时文件无组）", async () => {
    const { repo, memoryIndex } = createMocks();
    const uc = new ManageKeyInfo(repo, memoryIndex);

    await expect(uc.linkResource({
      conversationId: "conv-1", resourceType: "url", url: "https://example.com",
      linkedBy: "user-1", autoLinked: false,
    })).resolves.toBeTruthy();
    await expect(uc.linkResource({
      conversationId: "conv-1", resourceType: "file", url: "/tmp/x.md",
      linkedBy: "user-1", autoLinked: false,
    })).resolves.toBeTruthy();
    await expect(uc.linkResource({
      conversationId: "conv-1", resourceType: "fact", content: "事实",
      linkedBy: "user-1", autoLinked: false,
    })).resolves.toBeTruthy();
  });

  it("supersedeResource: 新输入无 groupId 但旧资源有组 → 继承放行（ptun 补救路径不能被打断）", async () => {
    const { repo, memoryIndex } = createMocks();
    (repo.getLinkedResourceById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "old-1", status: "active", groupId: "F20260828ptun",
    });
    const uc = new ManageKeyInfo(repo, memoryIndex);

    const result = await uc.supersedeResource("old-1", {
      conversationId: "conv-1",
      resourceType: "pr",
      url: "https://github.com/x/y/pull/561",
      linkedBy: "user-1",
      autoLinked: false,
    }, 10);

    expect(result.groupId).toBe("F20260828ptun");
    expect(repo.supersedeLinkedResource).toHaveBeenCalledOnce();
  });

  it("supersedeResource: 旧资源也无 groupId（历史漏传存量）→ effective groupId 缺失时拒绝", async () => {
    const { repo, memoryIndex } = createMocks();
    (repo.getLinkedResourceById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "old-2", status: "active", groupId: null,
    });
    const uc = new ManageKeyInfo(repo, memoryIndex);

    await expect(
      uc.supersedeResource("old-2", {
        conversationId: "conv-1",
        resourceType: "worktree",
        url: "/wt/legacy",
        linkedBy: "user-1",
        autoLinked: false,
      }, 10),
    ).rejects.toThrow("必须提供 groupId");
  });
});
