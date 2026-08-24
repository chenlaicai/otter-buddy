/**
 * get_active_participants 工具测试（F20260824aibd）：modelAlias 返回
 *
 * 验证：
 * - 有 otterConfigProvider 时返回 modelAlias
 * - 无 otterConfigProvider 时不返回 modelAlias
 * - 配置中无 modelAlias 时不返回该字段
 */
import { describe, it, expect } from "vitest";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ToolContext } from "@usecases/ports/agent-tools";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";

function makeGetActiveParticipantsTool(options: {
  participants?: Array<{ otterId: string; otterName: string; status: string; joinedAtTurnNumber: number }>;
  otterConfigProvider?: OtterConfigProvider;
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
    otterConfigProvider: options.otterConfigProvider,
  };

  const tools = createTools(ctx);
  const getActiveParticipants = tools.find(t => t.name === "get_active_participants")!;
  return { getActiveParticipants };
}

describe("get_active_participants 工具", () => {
  describe("modelAlias 返回（F20260824aibd）", () => {
    it("有 otterConfigProvider 且配置有 modelAlias 时返回 modelAlias", async () => {
      const participants = [
        { otterId: "otter-1", otterName: "大獭", status: "active", joinedAtTurnNumber: 0 },
        { otterId: "otter-2", otterName: "小獭", status: "active", joinedAtTurnNumber: 1 },
      ];

      const otterConfigProvider: OtterConfigProvider = {
        getConfig: (otterId: string) => {
          if (otterId === "otter-1") return { otterType: "big", modelAlias: "mimo" };
          if (otterId === "otter-2") return { otterType: "small", modelAlias: "kimi" };
          return null;
        },
        setConfig: () => {},
        deleteConfig: () => {},
        hasConfig: () => true,
      };

      const { getActiveParticipants } = makeGetActiveParticipantsTool({
        participants,
        otterConfigProvider,
      });

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

    it("有 otterConfigProvider 但配置无 modelAlias 时不返回 modelAlias 字段", async () => {
      const participants = [
        { otterId: "otter-1", otterName: "大獭", status: "active", joinedAtTurnNumber: 0 },
      ];

      const otterConfigProvider: OtterConfigProvider = {
        getConfig: (otterId: string) => {
          if (otterId === "otter-1") return { otterType: "big" }; // 无 modelAlias
          return null;
        },
        setConfig: () => {},
        deleteConfig: () => {},
        hasConfig: () => true,
      };

      const { getActiveParticipants } = makeGetActiveParticipantsTool({
        participants,
        otterConfigProvider,
      });

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

    it("无 otterConfigProvider 时不返回 modelAlias 字段", async () => {
      const participants = [
        { otterId: "otter-1", otterName: "大獭", status: "active", joinedAtTurnNumber: 0 },
      ];

      const { getActiveParticipants } = makeGetActiveParticipantsTool({
        participants,
        // 无 otterConfigProvider
      });

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

    it("otterConfigProvider.getConfig 返回 null 时不返回 modelAlias 字段", async () => {
      const participants = [
        { otterId: "otter-1", otterName: "大獭", status: "active", joinedAtTurnNumber: 0 },
      ];

      const otterConfigProvider: OtterConfigProvider = {
        getConfig: () => null,
        setConfig: () => {},
        deleteConfig: () => {},
        hasConfig: () => false,
      };

      const { getActiveParticipants } = makeGetActiveParticipantsTool({
        participants,
        otterConfigProvider,
      });

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
  });
});
