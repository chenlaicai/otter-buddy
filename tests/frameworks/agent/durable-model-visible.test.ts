/**
 * durable 模型可见输入回归：本地录音网关捕获真实 wire，零外部 LLM。
 * 不只检查 options/装配参数，而是断言身份与 skills 最终确实进入 system 面。
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { bootCapabilityApp, type CapabilityContext } from "../../capability/helpers/boot";
import {
  createConversation,
  sendUserMessage,
  waitForOtterMessage,
  listMessages,
  latestUserSeq,
} from "../../capability/helpers/assert-behavior";
import { RecordingGateway, speakScript, yieldScript } from "../../capability/helpers/model-visible";

describe("durable 模型可见身份与 skills（录音网关）", () => {
  let gateway: RecordingGateway;
  let ctx: CapabilityContext;

  beforeAll(async () => {
    gateway = await RecordingGateway.start();
    gateway.queue([
      speakScript("第一轮固定答复"),
      yieldScript(),
      speakScript("第二轮固定答复"),
      yieldScript(),
    ]);
    ctx = await bootCapabilityApp({ recordingGatewayUrl: gateway.url });
  }, 300_000);

  afterAll(async () => {
    ctx?.cleanup();
    await gateway?.stop();
  });

  it("两轮 4 次请求都携带身份，首轮 system 含真实 skills", async () => {
    const convId = await createConversation(ctx, "durable wire 身份与技能");
    await sendUserMessage(ctx, convId, "第一轮：请直接收尾。");
    const first = await waitForOtterMessage(ctx, convId, { timeoutMs: 120_000 });
    expect(first.status).toBe("completed");

    await sendUserMessage(ctx, convId, "第二轮：再次收尾。");
    const userSeq2 = latestUserSeq((await listMessages(ctx, convId)).filter(m => m.st === "user"));
    const second = await waitForOtterMessage(ctx, convId, { timeoutMs: 120_000, afterSeq: userSeq2 });
    expect(second.status).toBe("completed");

    expect(gateway.requests.length).toBe(4);
    for (const request of gateway.requests) {
      const system = JSON.stringify((request as { system?: unknown }).system ?? "");
      expect(system.length).toBeGreaterThan(100);
      expect(system).toContain("大獭");
    }
    const firstSystem = JSON.stringify((gateway.requests[0] as { system?: unknown }).system ?? "");
    expect(firstSystem).toContain("<available_skills>");
    expect(firstSystem).toContain("requirement-analysis");
  }, 300_000);
});
