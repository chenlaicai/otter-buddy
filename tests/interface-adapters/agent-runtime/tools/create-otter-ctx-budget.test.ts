/**
 * #1247：create_otter 注入体积预算前置检查单测。
 *
 * 验证面：预算估算（密度上限 × prompt 字符 + 固定底线 vs 窗口 × 0.8）→ 超预算硬拦
 * （返回 [错误] 且不产生参与者记录）、预算内放行、窗口未知/异常值 fail-soft、
 * 默认模型路径（未传 modelAlias）同样受检。
 *
 * mock 策略：ctx.client.otter.create 记录调用——硬拦路径断言未被调用（不产僵尸记录）。
 */
import { describe, it, expect, vi } from "vitest";
import type { ToolContext } from "@usecases/ports/agent-tools";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";

function makeCtx(overrides: Record<string, unknown> = {}): { ctx: ToolContext; created: string[] } {
  const created: string[] = [];
  const ctx = {
    otterId: "otter-big",
    conversationId: "conv-1",
    currentMessageId: "msg-1",
    client: {
      otter: {
        create: vi.fn(async (p: { name: string }) => {
          created.push(p.name);
          return { id: `otter-${p.name}`, name: p.name };
        }),
      },
      conversation: {
        participant: {
          getActive: vi.fn(async () => []),
          join: vi.fn(async () => ({})),
        },
      },
      dispatch: { createRecord: vi.fn(async () => {}) },
    },
    ...overrides,
  } as unknown as ToolContext;
  return { ctx, created };
}

function poolWithWindow(alias: string, window: number | undefined) {
  return {
    hasModel: (a: string) => a === alias,
    describeModels: () => [{ alias }],
    getDefaultAlias: () => alias,
    getContextWindow: (a?: string) => (a === alias ? window : undefined),
  };
}

function findCreateOtter(ctx: ToolContext) {
  const tool = createTools(ctx).find((t) => t.name === "create_otter");
  expect(tool, "create_otter 应注册").toBeDefined();
  return tool!;
}

const M = 1000;
/** kimi-256k 窗口 262144 × 0.8 = 209715；扣除 30K 底线 → prompt 预算 179715/1.5 ≈ 119810 字符 */
const K256 = 262144;
const PROMPT_BUDGET_CHARS = Math.floor((K256 * 0.8 - 30000) / 1.5);

describe("#1247 create_otter 注入体积预算前置检查", () => {
  it("超预算硬拦：kimi-256k + 超长 systemPrompt → [错误] 且不创建", async () => {
    const { ctx, created } = makeCtx({ modelPool: poolWithWindow("kimi-256k", K256) });
    const tool = findCreateOtter(ctx);
    const longPrompt = "x".repeat(PROMPT_BUDGET_CHARS + 1000);
    const res = await tool.execute("t1", { name: "开发獭-x", systemPrompt: longPrompt, modelAlias: "kimi-256k" });
    const text = res.content[0].text;
    expect(text).toContain("[错误]");
    expect(text).toContain("注入体积超预算");
    expect(text).toContain("kimi-256k");
    expect(created).toEqual([]);
  });
  it("预算内放行：同样 prompt 长度 + 1M 窗口模型 → 正常创建", async () => {
    const { ctx, created } = makeCtx({ modelPool: poolWithWindow("kimi", 1000000) });
    const tool = findCreateOtter(ctx);
    const prompt = "x".repeat(PROMPT_BUDGET_CHARS + 1000);
    const res = await tool.execute("t2", { name: "开发獭-ok", systemPrompt: prompt, modelAlias: "kimi" });
    expect(res.content[0].text).toContain("Otter created");
    expect(created).toEqual(["开发獭-ok"]);
  });

  it("窗口未配置（getContextWindow 缺失/undefined）fail-soft 放行", async () => {
    const poolNoWindow = { hasModel: () => true, describeModels: () => [{ alias: "kimi-256k" }] };
    const { ctx, created } = makeCtx({ modelPool: poolNoWindow });
    const tool = findCreateOtter(ctx);
    await tool.execute("t3", { name: "开发獭-soft", systemPrompt: "x".repeat(500 * M), modelAlias: "kimi-256k" });
    // 无窗口信息不硬拦（fail-soft，同 quota hint 先例）
    expect(created).toEqual(["开发獭-soft"]);
  });

  it("异常小窗口（<8K）跳过检查不误拦", async () => {
    const { ctx, created } = makeCtx({ modelPool: poolWithWindow("weird", 4000) });
    const tool = findCreateOtter(ctx);
    await tool.execute("t4", { name: "开发獭-weird", systemPrompt: "正常长度的提示词", modelAlias: "weird" });
    expect(created).toEqual(["开发獭-weird"]);
  });

  it("未传 modelAlias：默认模型窗口同样受检", async () => {
    const { ctx, created } = makeCtx({ modelPool: poolWithWindow("glm", K256) });
    const tool = findCreateOtter(ctx);
    const res = await tool.execute("t5", { name: "开发獭-def", systemPrompt: "x".repeat(PROMPT_BUDGET_CHARS + 2000) });
    const text = res.content[0].text;
    expect(text).toContain("[错误]");
    expect(text).toContain("注入体积超预算");
    expect(created).toEqual([]);
  });

  it("未知模型别名仍被既有校验先拦（预算检查不越位）", async () => {
    const { ctx, created } = makeCtx({ modelPool: poolWithWindow("glm", 1000000) });
    const tool = findCreateOtter(ctx);
    const res = await tool.execute("t6", { name: "开发獭-alias", systemPrompt: "短提示", modelAlias: "no-such-model" });
    expect(res.content[0].text).toContain("[错误] 未知的模型别名");
    expect(created).toEqual([]);
  });
});
