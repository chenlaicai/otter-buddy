/**
 * 能力测试：獭生命周期（重启獭生 / 身份注入 / speak 协议）。
 *
 * restart 是本系统出过的真实事故点（F20260805rsto：双层 session 断裂、restart 空操作），
 * 且依赖"agent 层 + domain 层 + 记忆层"三层联动——只有真系统 + 真 LLM 才能验证。
 *
 * LLM 行为断言采用统计采样（mimo speak 协议不稳定性见 F20260805mspk）；
 * 账本/记忆层转换等确定性断言保持严格。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootCapabilityApp, type CapabilityContext } from "./helpers/boot";
import {
  createConversation,
  sendUserMessage,
  waitForOtterMessage,
  toolCallNames,
  expectSpeakCompliance,
} from "./helpers/assert-behavior";
import { readSessionMessages, getSessionFile } from "./helpers/session-file";

/** BIG_OTTER.md 的身份标记（改文案需同步——这是有意的文案存在性守护） */
const IDENTITY_MARKER = "海獭团队的头儿";

async function getConversationOtterId(ctx: CapabilityContext, convId: string): Promise<string> {
  const res = await ctx.built.app.request(`/api/conversations/${convId}/participants`);
  expect(res.status).toBe(200);
  const participants = await res.json() as Array<Record<string, unknown>>;
  const otter = participants.find((p) => (p.otterType ?? p.type) !== "user" && (p.otterId ?? p.id));
  expect(otter, "对话中应有一只獭").toBeTruthy();
  return (otter!.otterId ?? otter!.id) as string;
}

describe("獭生命周期：重启獭生 + 身份注入 + speak 协议（真系统 + 真 LLM）", () => {
  let ctx: CapabilityContext;

  beforeAll(async () => {
    ctx = await bootCapabilityApp();
  });

  afterAll(() => {
    ctx?.cleanup();
  });

  it("restart 全链路：对话 → 重启 → 账本封存建链 + 记忆转历史 + 新獭生可用", async (t) => {
    if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

    // 1. 建对话（自动建大獭）并真实对话一轮
    const convId = await createConversation(ctx, "重启验证");
    const otterId = await getConversationOtterId(ctx, convId);
    await sendUserMessage(ctx, convId, "你好，随便说点什么");
    await waitForOtterMessage(ctx, convId, { timeoutMs: 120_000 });

    const firstSession = await ctx.built.repos.otter.getActiveSession(otterId);
    expect(firstSession, "F20260805rsto 不变量：有对话即有 active domain session").not.toBeNull();

    // 2. 重启獭生
    const restartRes = await ctx.built.app.request(`/api/otters/${otterId}/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "前世摘要：寒暄过一轮" }),
    });
    expect(restartRes.status).toBe(201);
    const restartBody = await restartRes.json() as { id: string };

    // 3. 账本断言（确定性，严格）：旧行封存 + 新行建链 + summary 双写
    const history = await ctx.built.repos.otter.getSessionHistory(otterId);
    expect(history).toHaveLength(2);
    const oldRow = history.find((s) => s.id === firstSession!.id)!;
    expect(oldRow.status).toBe("restarted");
    expect(oldRow.archiveReason).toBe("restart");
    expect(oldRow.summary).toBe("前世摘要：寒暄过一轮");
    const newRow = history.find((s) => s.id !== firstSession!.id)!;
    expect(newRow.status).toBe("active");
    expect(newRow.previousSessionId).toBe(firstSession!.id);
    expect(newRow.summary).toBe("前世摘要：寒暄过一轮");
    expect(restartBody.id).toBe(newRow.id);

    // 4. 记忆层转换：该对话的 working 记忆全部转 historical
    const layers = ctx.built.db.prepare(
      "SELECT DISTINCT layer FROM memory_entries WHERE conversation_id = ?",
    ).all(convId) as Array<{ layer: string }>;
    expect(layers.length).toBeGreaterThan(0);
    for (const { layer } of layers) {
      expect(layer, "restart 后前世记忆应转 historical").toBe("historical");
    }

    // 5. 新獭生可用：再发消息能走到终态（真 LLM invoke 链路完好）
    await sendUserMessage(ctx, convId, "你还在吗？回复一下");
    const after = await waitForOtterMessage(ctx, convId, { timeoutMs: 120_000 });
    expect(after.status).toBe("completed");
  }, 600_000);

  it("身份注入：首次 invoke 注入身份前缀，后续轮次不重复注入", async (t) => {
    if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

    const convId = await createConversation(ctx, "身份注入验证");
    const otterId = await getConversationOtterId(ctx, convId);

    await sendUserMessage(ctx, convId, "你好");
    await waitForOtterMessage(ctx, convId, { timeoutMs: 120_000 });

    const sessionFile = getSessionFile(ctx.built.db, otterId);
    expect(sessionFile, "agent_sessions 应有 session_file").toBeTruthy();

    const firstRound = readSessionMessages(sessionFile!);
    const firstUser = firstRound.find((e) => e.isUser);
    expect(firstUser, "session 中应有用户消息").toBeTruthy();
    expect(firstUser!.text, "首条用户消息应携带身份前缀（BIG_OTTER.md 注入）").toContain(IDENTITY_MARKER);

    // 第二轮：不应重复注入
    await sendUserMessage(ctx, convId, "再说一句");
    await waitForOtterMessage(ctx, convId, { timeoutMs: 120_000 });

    const secondRound = readSessionMessages(sessionFile!);
    const identityCount = secondRound.filter((e) => e.isUser && e.text.includes(IDENTITY_MARKER)).length;
    expect(identityCount, "身份前缀只应注入一次").toBe(1);
  }, 600_000);

  it("speak 协议合规：3 次采样 ≥1 次合规（统计断言，F20260805mspk）", async (t) => {
    if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

    const SAMPLES = 3;
    let compliant = 0;
    const outcomes: string[] = [];

    for (let i = 0; i < SAMPLES; i++) {
      const convId = await createConversation(ctx, `speak 采样${i + 1}`);
      await sendUserMessage(ctx, convId, "用一句话介绍你自己");
      const answer = await waitForOtterMessage(ctx, convId, { timeoutMs: 120_000 });
      const tools = toolCallNames(answer);
      let ok = tools.includes("speak");
      let violation = "";
      try {
        expectSpeakCompliance(answer, ["user", "capability-tester"]);
      } catch (err) {
        ok = false;
        violation = String(err).slice(0, 120);
      }
      if (ok) compliant++;
      outcomes.push(`#${i + 1}: tools=${JSON.stringify(tools)} status=${answer.status} compliant=${ok}${violation ? ` (${violation})` : ""}`);
    }

    console.log(`[capability] speak 协议采样结果（${compliant}/${SAMPLES} 合规）:\n${outcomes.join("\n")}`);
    expect(compliant, `3 次采样至少 1 次 speak 合规\n${outcomes.join("\n")}`).toBeGreaterThanOrEqual(1);
  }, 600_000);
});
