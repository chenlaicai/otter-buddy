/**
 * get_active_participants 工具测试：modelAlias 返回
 *
 * F20260824aibd：tool 曾在循环内逐个 getConfig 补 modelAlias；
 * #446 后 modelAlias 由 ManageParticipant.getActiveParticipants 批量预取，
 * 经 HTTP DTO 透传到 tool 层——tool 只做 DTO → JSON 的字段选择，不再查配置。
 *
 * 验证：
 * - DTO 带 modelAlias 时返回该字段
 * - DTO 无 modelAlias 时不返回该字段
 * - 混合场景（部分有部分无）逐参与者正确
 */
import { describe, it, expect } from "vitest";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ToolContext } from "@usecases/ports/agent-tools";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";

function makeGetActiveParticipantsTool(options: {
  participants?: Array<{ otterId: string; otterName: string; status: string; joinedAtTurnNumber: number; modelAlias?: string }>;
} = {}) {
  const client = {
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
  const getActiveParticipants = tools.find(t => t.name === "get_active_participants")!;
  return { getActiveParticipants };
}

describe("get_active_participants 工具", () => {
  describe("modelAlias 返回（#446：DTO 透传）", () => {
    it("DTO 带 modelAlias 时返回 modelAlias", async () => {
      const participants = [
        { otterId: "otter-1", otterName: "大獭", status: "active", joinedAtTurnNumber: 0, modelAlias: "mimo" },
        { otterId: "otter-2", otterName: "小獭", status: "active", joinedAtTurnNumber: 1, modelAlias: "kimi" },
      ];

      const { getActiveParticipants } = makeGetActiveParticipantsTool({ participants });

      const result = await getActiveParticipants.execute("c1", {});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toEqual({
        otterId: "otter-1",
        otterName: "大獭",
        status: "active",
        joinedAtTurnNumber: 0,
        modelAlias: "mimo",
      });
      expect(parsed[1]).toEqual({
        otterId: "otter-2",
        otterName: "小獭",
        status: "active",
        joinedAtTurnNumber: 1,
        modelAlias: "kimi",
      });
    });

    it("DTO 无 modelAlias 时不返回 modelAlias 字段", async () => {
      const participants = [
        { otterId: "otter-1", otterName: "大獭", status: "active", joinedAtTurnNumber: 0 },
      ];

      const { getActiveParticipants } = makeGetActiveParticipantsTool({ participants });

      const result = await getActiveParticipants.execute("c1", {});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual({
        otterId: "otter-1",
        otterName: "大獭",
        status: "active",
        joinedAtTurnNumber: 0,
      });
      expect(parsed[0]).not.toHaveProperty("modelAlias");
    });

    it("混合场景：部分参与者有 modelAlias 部分无，逐参与者正确", async () => {
      const participants = [
        { otterId: "otter-1", otterName: "大獭", status: "active", joinedAtTurnNumber: 0, modelAlias: "mimo" },
        { otterId: "otter-2", otterName: "小獭", status: "active", joinedAtTurnNumber: 1 },
        { otterId: "otter-3", otterName: "检视獭", status: "active", joinedAtTurnNumber: 2, modelAlias: "kimi" },
      ];

      const { getActiveParticipants } = makeGetActiveParticipantsTool({ participants });

      const result = await getActiveParticipants.execute("c1", {});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed).toHaveLength(3);
      expect(parsed[0]).toHaveProperty("modelAlias", "mimo");
      expect(parsed[1]).not.toHaveProperty("modelAlias");
      expect(parsed[2]).toHaveProperty("modelAlias", "kimi");
    });
  });
});
