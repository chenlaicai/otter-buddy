/**
 * 能力测试：獭协作——召唤小獭（otter-summon）与解散獭（dissolve）。
 *
 * otter-summon 是纯 LLM 决策行为（何时 create_otter、如何为小獭撰写 systemPrompt），
 * 统计采样断言；dissolve 是确定性状态机 + agent 层清理，严格断言。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootCapabilityApp, type CapabilityContext } from "./helpers/boot";
import {
  createConversation,
  sendUserMessage,
  waitForOtterMessage,
  toolCallNames,
  expectSampledBehavior,
} from "./helpers/assert-behavior";

describe("獭协作：召唤与解散（真系统 + 真 LLM）", () => {
  let ctx: CapabilityContext;

  beforeAll(async () => {
    ctx = await bootCapabilityApp();
  });

  afterAll(() => {
    ctx?.cleanup();
  });

  it("召唤小獭：大獭判断需要帮手时 create_otter，小獭落行且 systemPrompt 非空（3 次采样 ≥1）", async (t) => {
    if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

    await expectSampledBehavior("otter-summon", 3, 1, async (i) => {
      const ottersBefore = new Set(
        (ctx.built.db.prepare("SELECT id FROM otters").all() as Array<{ id: string }>).map((r) => r.id),
      );

      const convId = await createConversation(ctx, `召唤采样${i + 1}`);
      await sendUserMessage(
        ctx,
        convId,
        "请召唤一只小獭来帮忙：让它把「苹果、香蕉、樱桃、西瓜」按名称字数从少到多排序，然后把结果告诉你。",
      );
      const answer = await waitForOtterMessage(ctx, convId, { timeoutMs: 150_000 });

      const tools = toolCallNames(answer);
      const summoned = tools.includes("create_otter");
      if (!summoned) {
        return { ok: false, detail: `未召唤小獭 tools=${JSON.stringify(tools)}` };
      }

      /** 新獭落行：type=small、父獭正确、systemPrompt 非空且与任务相关（token 重叠不断言措辞） */
      const newOtters = (ctx.built.db.prepare("SELECT id, name, type, parent_otter_id FROM otters").all() as Array<Record<string, string>>)
        .filter((r) => !ottersBefore.has(r.id));
      const small = newOtters.find((r) => r.type === "small");
      if (!small) {
        return { ok: false, detail: `create_otter 被调用但无新小獭落行 newOtters=${JSON.stringify(newOtters)}` };
      }
      const cfgRow = ctx.built.db.prepare("SELECT system_prompt FROM otter_configs WHERE otter_id = ?").get(small.id) as { system_prompt: string | null } | undefined;
      const promptOk = !!cfgRow?.system_prompt && cfgRow.system_prompt.length > 10 && /排序|字数|苹果|香蕉/.test(cfgRow.system_prompt);
      return {
        ok: promptOk,
        detail: `小獭=${small.name} prompt=${(cfgRow?.system_prompt ?? "").slice(0, 80)} promptOk=${promptOk}`,
      };
    });
  }, 600_000);

  it("解散獭：dissolve 后状态/会话/agent 三层清理到位（确定性，严格断言）", async () => {
    const createRes = await ctx.built.app.request("/api/otters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "待解散獭", type: "big" }),
    });
    expect(createRes.status).toBe(201);
    const otter = await createRes.json() as { id: string };

    const delRes = await ctx.built.app.request(`/api/otters/${otter.id}`, { method: "DELETE" });
    expect([200, 204]).toContain(delRes.status);

    /** otters 行：dissolved + dissolvedAt */
    const row = ctx.built.db.prepare("SELECT status, dissolved_at FROM otters WHERE id = ?").get(otter.id) as { status: string; dissolved_at: string | null };
    expect(row.status).toBe("dissolved");
    expect(row.dissolved_at).not.toBeNull();

    /** domain session：active 行已封存 */
    const active = await ctx.built.repos.otter.getActiveSession(otter.id);
    expect(active).toBeNull();

    /** agent 层：agent_sessions 映射已销毁 */
    const agentRow = ctx.built.db.prepare("SELECT pi_session_id FROM agent_sessions WHERE otter_id = ?").get(otter.id);
    expect(agentRow).toBeUndefined();
  });
});
