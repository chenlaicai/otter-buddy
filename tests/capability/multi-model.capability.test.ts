/**
 * 能力测试：多模型路由（确定性部分）。
 *
 * 验证：带 modelAlias 建獭 → 别名持久化 otter_configs → ModelPool 解析到独立模型对象
 * （非回退默认）→ agent session 建立。这些是路由机制的完整代码路径。
 *
 * 范围说明（设计决策）：「别名模型真实 invoke」未纳入——别名可指向同一端点，
 * invoke 链路本身已由 restart/身份注入用例覆盖（默认模型），此处不重复烧钱；
 * 且跨对话点名加入参与者依赖活跃回合的时序，不适合能力层断言。本测试不依赖 LLM。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootCapabilityApp, type CapabilityContext } from "./helpers/boot";

describe("多模型路由：modelAlias 持久化 + 模型解析（确定性）", () => {
  let ctx: CapabilityContext;

  beforeAll(async () => {
    ctx = await bootCapabilityApp();
  });

  afterAll(() => {
    ctx?.cleanup();
  });

  it("带 test-secondary 别名的獭：别名落库 + 解析非回退 + agent session 建立", async () => {
    expect(ctx.built.modelPool.hasModel("test-secondary"), "测试配置应含第二别名").toBe(true);

    const otter = await ctx.built.usecases.createOtter.execute({
      name: "别名獭",
      type: "small",
      modelAlias: "test-secondary",
      systemPrompt: "你是一只测试用小獭，只读代码、简短回答。",
    });

    /** 别名持久化 */
    const cfgRow = ctx.built.db.prepare("SELECT model_alias FROM otter_configs WHERE otter_id = ?").get(otter.id) as { model_alias: string | null } | undefined;
    expect(cfgRow?.model_alias, "modelAlias 应持久化到 otter_configs").toBe("test-secondary");

    /** ModelPool 解析：别名模型与默认模型是不同对象（不是缺失回退） */
    const aliased = ctx.built.modelPool.getModel("test-secondary");
    const fallback = ctx.built.modelPool.getModel("nonexistent-alias");
    expect(aliased).not.toBe(fallback);

    /** agent session 已建立（create 路由到别名模型成功） */
    const agentRow = ctx.built.db.prepare("SELECT pi_session_id FROM agent_sessions WHERE otter_id = ?").get(otter.id) as { pi_session_id: string } | undefined;
    expect(agentRow?.pi_session_id, "别名獭的 agent session 应建立").toBeTruthy();
  });
});
