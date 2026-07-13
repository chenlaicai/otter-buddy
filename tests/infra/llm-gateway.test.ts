import { describe, it, expect } from "vitest";
import { initFauxLLMGateway } from "@infra/llm-gateway";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

describe("llm-gateway", () => {
  it("chat 基本调用返回 LLMResponse", async () => {
    const { gateway, faux } = await initFauxLLMGateway([
      fauxAssistantMessage([fauxText("Hello, world!")]),
    ]);
    void faux;

    const response = await gateway.chat([
      { role: "user", content: "Hi" },
    ]);

    expect(response.content).toBe("Hello, world!");
    expect(response.usage).toBeDefined();
  });

  it("streamChat 返回 AsyncIterable<LLMStreamChunk>", async () => {
    const { gateway } = await initFauxLLMGateway([
      fauxAssistantMessage([fauxText("Streaming response")]),
    ]);

    const chunks: string[] = [];
    for await (const chunk of gateway.streamChat([{ role: "user", content: "Hi" }])) {
      if (chunk.delta) chunks.push(chunk.delta);
      expect(typeof chunk.done).toBe("boolean");
    }

    expect(chunks.join("")).toBe("Streaming response");
  });

  it("chat 包含 system 消息时正确传递 systemPrompt", async () => {
    const { gateway } = await initFauxLLMGateway([
      fauxAssistantMessage([fauxText("OK")]),
    ]);

    const response = await gateway.chat([
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
    ]);

    expect(response.content).toBe("OK");
  });

  it("getModel 返回底层 Model 对象", async () => {
    const { gateway } = await initFauxLLMGateway([]);

    const model = gateway.getModel();
    expect(model).toBeDefined();
  });
});
