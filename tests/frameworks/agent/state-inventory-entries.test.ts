/**
 * F20260913ctlv 收尾批1：state-inventory 历史读取切 entries 回归测试。
 *
 * B1 发言石盘点：读最新 user entry 的 yieldTargets（原 messages.talkingStonePassedTo）；
 * B6 活动状态降级：同样读 user entry。
 */
import { describe, it, expect, vi } from "vitest";
import { collectStateInventory } from "@frameworks/agent/state-inventory";
import type { StateInventoryDeps } from "@frameworks/agent/state-inventory";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import { createTestLogger } from "../../helpers/logger";

function makeDeps(entryOverrides?: {
  user?: Array<{ senderId: string | null; yieldTargets: string[] | null; senderType: string | null; createdAt: string }>;
}): StateInventoryDeps {
  return {
    entryReader: {
      getEntries: vi.fn(async (_convId: string, options?: { entryType?: string }) => {
        if (options?.entryType === "user") return entryOverrides?.user ?? [];
        return [];
      }),
    },
    conversationRepo: {
      getLinkedResources: vi.fn().mockResolvedValue([]),
      listConversationsWithMeta: vi.fn().mockRejectedValue(new Error("降级路径")),
    } as unknown as ConversationRepository,
    listArtifacts: vi.fn().mockResolvedValue([]),
    logger: createTestLogger(),
  };
}

describe("state-inventory 切 entries（收尾批1）", () => {
  it("B1 发言石 = 最新 user entry 的 yieldTargets", async () => {
    const deps = makeDeps({
      user: [{ senderId: "user-1", yieldTargets: ["otter-big"], senderType: "user", createdAt: "2026-09-12T00:00:00Z" }],
    });
    const inv = await collectStateInventory("conv-1", "otter-1", deps);
    expect(inv.talkingStone).toEqual({ holders: ["otter-big"], from: "user-1" });
  });

  it("无 user entry（或 yieldTargets 空）→ talkingStone null", async () => {
    const deps = makeDeps({ user: [{ senderId: "user-1", yieldTargets: [], senderType: "user", createdAt: "2026-09-12T00:00:00Z" }] });
    const inv = await collectStateInventory("conv-1", "otter-1", deps);
    expect(inv.talkingStone).toBeNull();
  });

  it("B6 活动状态降级：读 user entry 的 yieldTargets → awaiting", async () => {
    const deps = makeDeps({
      user: [{ senderId: "user-1", yieldTargets: ["otter-a", "otter-b"], senderType: "user", createdAt: "2026-09-12T00:00:00Z" }],
    });
    const inv = await collectStateInventory("conv-1", "otter-1", deps);
    expect(inv.activity.status).toBe("awaiting");
    expect(inv.activity.waitingFor).toBe("otter-a, otter-b");
  });

  it("数据源是 entries——deps 不再有 queryMessage（messages 表退役验证）", () => {
    const deps = makeDeps();
    expect("queryMessage" in deps).toBe(false);
    expect("entryReader" in deps).toBe(true);
  });
});
