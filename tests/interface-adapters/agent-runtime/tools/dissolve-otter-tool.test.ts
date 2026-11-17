/**
 * dissolve_otter 工具测试：同对话范围守卫（F20261117dsgrd）
 *
 * 事故背景：2026-11-16 端云改造大獭按不属本对话的 ID 误解散了「三省吾身」大獭。
 * 修法：
 * - use case 层拒绝 big 獭（见 tests/usecases/otter/dissolve-otter.test.ts）
 * - 工具层拒绝「目标不在当前对话在场名单」的跨对话解散
 *
 * 验证：
 * - 目标在当前对话 → 正常调用 client.otter.dissolve
 * - 目标不在当前对话 → isError 响应，不调用 dissolve
 * - 目标是调用者自己 → isError 响应（既有守卫）
 */
import { describe, it, expect, vi } from "vitest";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ToolContext } from "@usecases/ports/agent-tools";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";
import { DomainError } from "@entities/errors";

function makeDissolveOtterTool(options: {
  participants?: Array<{ otterId: string; otterName: string }>;
  dissolveError?: DomainError;
} = {}) {
  const dissolvedIds: string[] = [];
  const client = {
    otter: {
      dissolve: vi.fn(async (id: string) => {
        if (options.dissolveError) throw options.dissolveError;
        dissolvedIds.push(id);
      }),
    },
    conversation: {
      participant: {
        getActive: async () => options.participants ?? [],
      },
    },
  } as unknown as OtterToolClient;

  const ctx: ToolContext = {
    client,
    otterId: "parent-otter",
    conversationId: "conv-1",
    currentMessageId: "msg-1",
  };

  const tools = createTools(ctx);
  const dissolveOtter = tools.find(t => t.name === "dissolve_otter")!;
  return { dissolveOtter, dissolvedIds };
}

describe("dissolve_otter 工具", () => {
  it("目标在当前对话在场名单 → 调用 client.otter.dissolve", async () => {
    const { dissolveOtter, dissolvedIds } = makeDissolveOtterTool({
      participants: [
        { otterId: "otter-1", otterName: "reviewer" },
        { otterId: "otter-2", otterName: "dev" },
      ],
    });

    const result = await dissolveOtter.execute("c1", { otterId: "otter-1" });

    expect(result.isError).not.toBe(true);
    expect(dissolvedIds).toEqual(["otter-1"]);
  });

  it("F20261117dsgrd：目标不在当前对话在场名单 → 拒绝且不调用 dissolve", async () => {
    const { dissolveOtter, dissolvedIds } = makeDissolveOtterTool({
      participants: [{ otterId: "otter-1", otterName: "reviewer" }],
    });

    const result = await dissolveOtter.execute("c1", { otterId: "otter-elsewhere" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("跨对话");
    expect(dissolvedIds).toHaveLength(0);
  });

  it("目标是调用者自己 → 拒绝", async () => {
    const { dissolveOtter, dissolvedIds } = makeDissolveOtterTool({
      participants: [{ otterId: "parent-otter", otterName: "大獭" }],
    });

    const result = await dissolveOtter.execute("c1", { otterId: "parent-otter" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("不能解散自己");
    expect(dissolvedIds).toHaveLength(0);
  });

  it("use case 抛 DomainError（如 big 獭/已解散）→ 转 errorResponse 不向上抛", async () => {
    const { dissolveOtter, dissolvedIds } = makeDissolveOtterTool({
      participants: [{ otterId: "otter-1", otterName: "reviewer" }],
      dissolveError: new DomainError("大獭（big 獭）不可解散，永久保留: otter-1", "validation"),
    });

    const result = await dissolveOtter.execute("c1", { otterId: "otter-1" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("不可解散");
    expect(dissolvedIds).toHaveLength(0);
  });
});
