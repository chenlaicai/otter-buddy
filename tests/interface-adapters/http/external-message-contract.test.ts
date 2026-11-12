import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { MessageController } from "@interface-adapters/http/controllers/message-controller";
import type { Logger } from "@usecases/ports/logger";

function harness() {
  const sendUserEntry = vi.fn();
  const controller = new MessageController(
    {} as never,
    {} as never,
    { invokeConversation: vi.fn() } as never,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
    {} as never,
    { executeChain: vi.fn() } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    { sendUserEntry } as never,
  );
  const app = new Hono();
  app.post("/api/conversations/:id/messages", c => controller.sendMessage(c));
  return { app, sendUserEntry };
}

describe("外部消息 source/profile 入口契约", () => {
  it("external: 身份缺 source=external 时在落库前拒绝", async () => {
    const { app, sendUserEntry } = harness();
    const response = await app.request("/api/conversations/conv-1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ senderId: "external:alice", body: "不得进入普通记忆" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "external_source_required" });
    expect(sendUserEntry).not.toHaveBeenCalled();
  });
});
