/**
 * H3 交接采集四态判别测试：collector 抛错 → unavailable（不写「无」）；
 * 真空 → empty；主源失败走降级源 → stale；任一 unavailable → handoffCompleteness incomplete。
 */
import { describe, it, expect, vi } from "vitest";
import { collectStateInventory, renderStateInventory, collectUnavailabilityReasons } from "@frameworks/agent/state-inventory";
import type { StateInventoryDeps } from "@frameworks/agent/state-inventory";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import { createTestLogger } from "../../helpers/logger";

function baseDeps(): StateInventoryDeps {
  return {
    entryReader: { getEntries: vi.fn(async () => []) },
    conversationRepo: {
      listConversationsWithMeta: vi.fn().mockResolvedValue({ items: [{ id: "conv-1", activityStatus: "idle" }], total: 1 }),
    } as unknown as ConversationRepository,
    scheduledTaskRepo: { getByConversationId: vi.fn().mockResolvedValue([]) } as never,
    healingRepo: { findByConversation: vi.fn().mockResolvedValue([]) } as never,
    listArtifacts: vi.fn().mockResolvedValue([]),
    workspacePath: "/tmp/does-not-matter",
    logger: createTestLogger(),
  };
}

describe("state-inventory 采集四态（H3）", () => {
  it("collector 抛错 → unavailable 而非空，渲染「不可用」不写「无」", async () => {
    const deps = baseDeps();
    (deps.scheduledTaskRepo as unknown as { getByConversationId: ReturnType<typeof vi.fn> }).getByConversationId
      .mockRejectedValue(new Error("db locked"));
    (deps.healingRepo as unknown as { findByConversation: ReturnType<typeof vi.fn> }).findByConversation
      .mockRejectedValue(new Error("healing down"));

    const inv = await collectStateInventory("conv-1", "otter-1", deps);
    expect(inv.scheduledTasks.state).toBe("unavailable");
    expect(inv.scheduledTasks.error).toContain("db locked");
    expect(inv.healingOpen.state).toBe("unavailable");
    expect(inv.handoffCompleteness).toBe("incomplete");
    expect(collectUnavailabilityReasons(inv)).toEqual(expect.arrayContaining([
      expect.stringContaining("scheduledTasks:db locked"),
      expect.stringContaining("healingOpen:healing down"),
    ]));

    const text = renderStateInventory(inv);
    expect(text).toContain("- 调度任务：不可用（采集失败：db locked）");
    expect(text).toContain("- Healing：不可用（采集失败：healing down）");
    expect(text).not.toContain("- 调度任务：无");
    expect(text).not.toContain("- Healing：无 open");
  });

  it("真空 → empty（正常读出「无」，不误标不可用）", async () => {
    const deps = baseDeps();
    const inv = await collectStateInventory("conv-1", "otter-1", deps);
    expect(inv.scheduledTasks.state).toBe("empty");
    expect(inv.talkingStone.state).toBe("empty");
    expect(inv.workspaceFiles.state).toBe("empty");
    expect(inv.healingOpen.state).toBe("empty");
    expect(inv.activity.state).toBe("empty");
    // scheduledTaskRepo/healingRepo/workspacePath 均装配且查询成功 → complete
    expect(inv.handoffCompleteness).toBe("complete");

    const text = renderStateInventory(inv);
    expect(text).toContain("- 调度任务：无");
    expect(text).toContain("- 发言石：无");
  });

  it("活动状态主源失败走 entries 降级 → stale，值可用并标降级源", async () => {
    const deps = baseDeps();
    (deps.conversationRepo as unknown as { listConversationsWithMeta: ReturnType<typeof vi.fn> }).listConversationsWithMeta
      .mockRejectedValue(new Error("primary down"));
    (deps.entryReader.getEntries as ReturnType<typeof vi.fn>).mockResolvedValue([
      { senderId: "user-1", senderType: "user", entryType: "user", body: "go", yieldTargets: ["otter-x"], createdAt: "2026-11-25T00:00:00Z" },
    ]);

    const inv = await collectStateInventory("conv-1", "otter-1", deps);
    expect(inv.activity.state).toBe("stale");
    expect(inv.activity.value).toMatchObject({ status: "awaiting", waitingFor: "otter-x" });
    // stale 不算关键失败——值可用
    expect(inv.handoffCompleteness).toBe("complete");
    const text = renderStateInventory(inv);
    expect(text).toContain("- 进行中：awaiting，等待 otter-x（降级源，非权威口径）");
  });

  it("每项带 collectedAt 时间戳（ISO 可解析）", async () => {
    const deps = baseDeps();
    const inv = await collectStateInventory("conv-1", "otter-1", deps);
    for (const key of ["talkingStone", "scheduledTasks", "workspaceFiles", "artifacts", "healingOpen", "activity"] as const) {
      expect(Number.isNaN(Date.parse(inv[key].collectedAt))).toBe(false);
    }
  });

  it("成功采集的渲染内容与旧口径一致（发言石/调度任务/产物行不变）", async () => {
    const deps = baseDeps();
    (deps.entryReader.getEntries as ReturnType<typeof vi.fn>).mockResolvedValue([
      { senderId: "user-1", senderType: "user", entryType: "user", body: "go", yieldTargets: ["otter-big"], createdAt: "2026-11-25T00:00:00Z" },
    ]);
    (deps.scheduledTaskRepo as unknown as { getByConversationId: ReturnType<typeof vi.fn> }).getByConversationId
      .mockResolvedValue([{ senderId: "otter-1", status: "active", name: "daily", scheduleType: "cron", cron: "0 9 * * *" }]);
    (deps.listArtifacts as ReturnType<typeof vi.fn>).mockResolvedValue([
      { status: "active", userFlagged: false, createdAt: "2026-11-25T01:00:00Z", title: "产物甲" },
    ]);

    const inv = await collectStateInventory("conv-1", "otter-1", deps);
    const text = renderStateInventory(inv);
    expect(text).toContain("- 发言石：在 otter-big 手中（user-1 yield）");
    expect(text).toContain('- 调度任务：1 个 active——"daily" 0 9 * * * 下次 0 9 * * *');
    expect(text).toContain("- 产物：1 active");
    expect(text).toContain("｜ 最近：产物甲");
  });
});
