/**
 * F20260903cmpk capability e2e：session_before_compact 钩子真实链路。
 *
 * 验证三件事：
 * 1. inline extension（extensionFactories）注册的钩子能被 createAgentSession 的 session 接到
 * 2. session.compact()（manual 路径）触发钩子，preparation 携带 Pi 算好的切口
 * 3. 钩子返回自定义 compaction → Pi 原样落盘（fromHook 标记 + summary 原文）
 *
 * 关键前置（实测发现）：DefaultResourceLoader 必须 await reload() 之后
 * extensionsResult 才包含 inline extension，否则钩子静默丢失（hasHandlers=false）。
 *
 * 不 mock Pi 内部——用真实 createAgentSession，模型层用假模型（不真调 LLM API）。
 */
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

async function loadSdk() {
  return await import("@earendil-works/pi-coding-agent");
}

function makeFakeModel(contextWindow: number) {
  return {
    id: "fake-model",
    name: "Fake Model",
    provider: "fake",
    api: "openai-completions",
    contextWindow,
    maxTokens: 4096,
    reasoning: false,
    baseUrl: "http://localhost:0",
  } as never;
}

describe("F20260903cmpk spike: session_before_compact 钩子", () => {
  it("注册 inline extension → compact() 触发钩子 → 自定义 compaction 落盘", async () => {
    const sdk = await loadSdk();
    const events: Array<{ reason: string; hadPreparation: boolean; toSummarizeCount?: number }> = [];
    const customSummary = "## 交接摘要（自定义七段）\n① 下一步：验证钩子\n⑦ 谱系：gen1 spike";

    const loader = new sdk.DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: sdk.getAgentDir(),
      extensionFactories: [
        {
          name: "otter-compaction-hook",
          hidden: true,
          factory: (pi) => {
            pi.on("session_before_compact", async (event) => {
              events.push({
                reason: event.reason,
                hadPreparation: !!event.preparation?.firstKeptEntryId,
                toSummarizeCount: event.preparation.messagesToSummarize?.length,
              });
              // 自定义压缩结果：summary + Pi 算好的切口（firstKeptEntryId 必须来自 preparation）
              return {
                compaction: {
                  summary: customSummary,
                  firstKeptEntryId: event.preparation.firstKeptEntryId,
                  tokensBefore: event.preparation.tokensBefore,
                  details: { fromOtter: true },
                },
              };
            });
          },
        },
      ],
    });
    // spike 实测：不 reload 则 inline extension 静默丢失
    await loader.reload();

    const { session } = await sdk.createAgentSession({
      model: makeFakeModel(32_000),
      cwd: process.cwd(),
      sessionManager: sdk.SessionManager.inMemory(),
      resourceLoader: loader,
    } as never);

    // 造大文本历史（Pi 切口按 chars/4 估算，消息足够大切口才落在中间）
    const sm = (session as unknown as {
      sessionManager: { appendMessage: (m: unknown) => string; getBranch: () => SessionEntry[] };
    }).sessionManager;
    for (let i = 0; i < 30; i++) {
      sm.appendMessage({ role: "user", content: `问题 ${i}：${"细节 ".repeat(500)}`, timestamp: Date.now() + i });
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `回答 ${i}：${"进展 ".repeat(1000)}` }],
        stopReason: "stop",
        usage: { input: 12000, output: 2000, cacheRead: 0, cacheWrite: 0, totalTokens: 14000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });
    }

    // 手动触发压缩（manual 路径同样走 session_before_compact 钩子）
    await session.compact();

    // 验证 1/2：钩子被调用一次，preparation 带 Pi 算好的切口
    expect(events.length).toBe(1);
    expect(events[0].reason).toBe("manual");
    expect(events[0].hadPreparation).toBe(true);
    // 切口确实切在中间（有历史被摘要），不是"没东西可压"
    expect(events[0].toSummarizeCount ?? 0).toBeGreaterThan(0);

    // 验证 3：自定义 summary 原样落盘，fromHook 标记 extension 来源
    const branch = sm.getBranch();
    const compactionEntry = branch.find((e) => e.type === "compaction") as
      | { type: "compaction"; summary: string; fromHook?: boolean; details?: unknown }
      | undefined;
    expect(compactionEntry).toBeDefined();
    expect(compactionEntry!.summary).toBe(customSummary);
    expect(compactionEntry!.fromHook).toBe(true);
  }, 30_000);
});
