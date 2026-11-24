import { describe, expect, it, vi } from "vitest";
import { buildCustomTools, createInvokeRegister, resetInvokeRegister } from "@frameworks/agent/tool-builder";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ActionRunner } from "@usecases/ports/execution-machine";
import type { ToolContext } from "@usecases/ports/agent-tools";
import { createTestLogger } from "../../helpers/logger";

/** 真实工具闭包 + 同一 InvokeRegister：覆盖池复用时所有副作用的当前 conversation 归属。 */
describe("F20261124cnvsc ConversationScope", () => {
  it("A→B 后 speak/artifact/matter/signal/workspace 全部重绑到 B", async () => {
    const speakConversations: string[] = [];
    const artifactConversations: string[] = [];
    const matterConversations: string[] = [];
    const signalConversations: string[] = [];
    const workspaceConversations: string[] = [];
    const client = {
      conversation: {
        entry: {
          createSpeakEntry: vi.fn(async (input: { conversationId: string }) => {
            speakConversations.push(input.conversationId);
            return { id: `speak-${speakConversations.length}`, entryType: "speak", sequenceNum: speakConversations.length, createdAt: new Date().toISOString() };
          }),
        },
      },
      resource: {
        link: vi.fn(async (input: { conversationId: string }) => {
          artifactConversations.push(input.conversationId);
          return { id: `artifact-${artifactConversations.length}`, resourceType: "fact", status: "active", groupId: undefined };
        }),
      },
    };
    const signalRepo = {
      create: vi.fn(async (event: { conversationId: string }) => { signalConversations.push(event.conversationId); }),
    };
    const matterRepo = {
      create: vi.fn(async (matter: { conversationId: string }) => {
        matterConversations.push(matter.conversationId);
      }),
    };
    const actionRunner = {
      run: vi.fn(async (action: { input: { conversationId: string } }) => {
        workspaceConversations.push(action.input.conversationId);
        return undefined;
      }),
    } as unknown as ActionRunner;
    const register = createInvokeRegister();
    resetInvokeRegister(register, "message-A", { currentInvokeId: "invoke-A", currentConversationId: "conversation-A" });
    const { tools } = buildCustomTools({
      otterId: "otter-1",
      conversationId: "conversation-A",
      allowedNames: ["speak", "create_linked_resource", "register_matter", "workspace_write"],
      register,
      otterToolClient: client as never,
      signalRepo: signalRepo as never,
      matterRepo: matterRepo as never,
      createTools: (ctx: ToolContext, healingRepo, logger) => createTools(ctx, healingRepo, logger, actionRunner),
      logger: createTestLogger(),
    });
    const byName = new Map(tools.map(tool => [tool.name, tool]));

    const exercise = async (label: string, expectedSignals: number) => {
      const speak = await byName.get("speak")!.execute(`speak-${label}`, {
        body: `message from ${label}`,
        signal: [{ type: "objection", payload: `${label} scope evidence`, severity: "low" }],
      });
      expect(speak.isError).not.toBe(true);
      await byName.get("create_linked_resource")!.execute(`artifact-${label}`, { resourceType: "fact", content: `${label} artifact` });
      await byName.get("register_matter")!.execute(`matter-${label}`, { title: `${label} matter` });
      await byName.get("workspace_write")!.execute(`workspace-${label}`, { path: "scope.txt", content: label });
      await vi.waitFor(() => expect(signalConversations).toHaveLength(expectedSignals));
    };

    await exercise("A", 1);
    resetInvokeRegister(register, "message-B", { currentInvokeId: "invoke-B", currentConversationId: "conversation-B" });
    await exercise("B", 2);

    expect(speakConversations).toEqual(["conversation-A", "conversation-B"]);
    expect(artifactConversations).toEqual(["conversation-A", "conversation-B"]);
    expect(matterConversations).toEqual(["conversation-A", "conversation-B"]);
    expect(signalConversations).toEqual(["conversation-A", "conversation-B"]);
    expect(workspaceConversations).toEqual(["conversation-A", "conversation-B"]);
  });
});
