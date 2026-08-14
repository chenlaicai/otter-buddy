/**
 * 旗舰能力测试：记忆系统跨对话事实召回。
 *
 * 验证的能力（用户可感知）：「告诉獭一个事实 → 后来在全新对话里问，獭能查记忆答出来」。
 * 这正是此前 mock 体系从未真实验证、且出过能力缺失的链路：
 *   StoreMemory（真 bge-m3 向量化）→ 混合检索（FTS5+vec RRF 融合）→ 獭主动 search_memory → 答案含事实。
 *
 * 断言全部为行为不变量：检索命中、工具轨迹顺序、答案含关键 token；不断言具体措辞。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootCapabilityApp, type CapabilityContext } from "./helpers/boot";
import {
  createConversation,
  sendUserMessage,
  waitForOtterMessage,
  listMessages,
  toolCallNamesForExchange,
  latestUserSeq,
  expectEventually,
  expectSampledBehavior,
} from "./helpers/assert-behavior";
import { StoreMemory } from "@usecases/memory/store-memory";
import { createTestLogger } from "../helpers/logger";

/** 独特事实：不可能出现在训练数据或文档库中，召回必来自真实记忆链路 */
const FACT_TOKEN = "ZX7-QW9-3384";
const FACT_TEXT = `幻影灯塔计划的门禁验证码是 ${FACT_TOKEN}。`;

describe("记忆系统：跨对话事实召回（真 bge-m3 + 真 LLM）", () => {
  let ctx: CapabilityContext;

  beforeAll(async () => {
    ctx = await bootCapabilityApp();
  });

  afterAll(() => {
    ctx?.cleanup();
  });

  it("embedding 就绪（本层禁止静默降级 FTS-only）", () => {
    expect(ctx.built.embeddingService.available).toBe(true);
  });

  it("事实经 StoreMemory 落入记忆，混合检索（真 bge-m3 + FTS）可召回", async () => {
    const storeMemory = new StoreMemory(ctx.built.repos.memory, ctx.built.embeddingService, createTestLogger());
    await storeMemory.execute({
      layer: "working",
      contentType: "fact",
      sourceId: "capability-plant-1",
      sourceTable: "capability_test",
      conversationId: undefined,
      granularity: "coarse",
      content: FACT_TEXT,
    });

    /** 走 HTTP 层断言（用户视角的检索能力），而非直接调 usecase */
    await expectEventually(async () => {
      const res = await ctx.built.app.request(
        `/api/memory/search?query=${encodeURIComponent("幻影灯塔计划门禁验证码")}&limit=5`,
      );
      if (res.status !== 200) return false;
      const body = await res.json() as { entries: Array<{ content: string }> };
      return body.entries.some((e) => e.content.includes(FACT_TOKEN));
    }, { message: "混合检索未召回植入事实" });
  });

  /**
   * 统计断言：mimo 模型 speak 协议遵从不稳定（发现已记录 F20260805mspk）。
   * 采样 3 次、断言 ≥1 次全链路成功——既防止套件因模型抖动长红，又不掩盖问题：
   * 每次采样结果都打印，成功率掉到 0 时测试失败。
   *
   * 工具轨迹用回合级聚合（toolCallNamesForTurn）：speak 未收尾触发自动重试时，
   * 首试的 search_memory 落在 failed 消息上，只看最终 completed 消息会漏测
   * （第二轮对抗检视实证：系统健康但重试时此断言确定性红）。
   */
  it("新对话的獭通过 search_memory 召回事实并回答（3 次采样 ≥1 次全链路）", async (vitestCtx) => {
    if (!ctx.llmAvailable) {
      vitestCtx.skip(`LLM 未配置：${ctx.skipReason}`);
    }

    const SAMPLES = 3;
    let successes = 0;
    const outcomes: string[] = [];

    for (let i = 0; i < SAMPLES; i++) {
      const convId = await createConversation(ctx, `记忆召回采样${i + 1}`);
      await sendUserMessage(ctx, convId, "幻影灯塔计划的门禁验证码是什么？");
      const answer = await waitForOtterMessage(ctx, convId, { timeoutMs: 120_000 });

      const allMessages = await listMessages(ctx, convId);
      /** 交换级聚合：首试（failed）与 speak-retry 重试（新 turn）的工具轨迹都要算 */
      const tools = toolCallNamesForExchange(allMessages, latestUserSeq(allMessages));
      const searched = tools.includes("search_memory");
      const searchedBeforeSpeak = searched && tools.includes("speak")
        && tools.indexOf("search_memory") < tools.lastIndexOf("speak");
      const spoke = tools.includes("speak") && answer.status === "completed";
      const correct = answer.content.includes(FACT_TOKEN);
      const ok = searchedBeforeSpeak && spoke && correct;
      if (ok) successes++;
      outcomes.push(
        `#${i + 1}: searched=${searched} searchedBeforeSpeak=${searchedBeforeSpeak} spoke=${spoke} correct=${correct}`
        + ` tools=${JSON.stringify(tools)} answer=${answer.content.slice(0, 100)}`,
      );
    }

    console.log(`[capability] 记忆召回采样结果（${successes}/${SAMPLES} 全链路成功）:\n${outcomes.join("\n")}`);
    expect(
      successes,
      `3 次采样至少 1 次全链路成功（mimo speak 协议不稳定，发现见 F20260805mspk）\n${outcomes.join("\n")}`,
    ).toBeGreaterThanOrEqual(1);
  }, 600_000);

  /**
   * F20260814mbex：隐性历史信号下的主动背景探索。
   *
   * 与上文的区别：问题不带任何显性历史信号（没有"上次/为什么/之前"），
   * 只有一个记忆里才存在的计划名。旧行为（search_memory 描述"不要每次回复前都搜索"）
   * 会压制这种场景的检索；新引导语要求 agent 收到实质问题先自问"有前因吗"。
   *
   * 断言：search_memory 先于 speak，且回答引用召回事实的不可幻觉判据（决策编号或"青砾岩"代号）。
   */
  it("隐性信号问题：agent 主动背景探索后再答（3 次采样 ≥1 次全链路）", async (vitestCtx) => {
    if (!ctx.llmAvailable) {
      vitestCtx.skip(`LLM 未配置：${ctx.skipReason}`);
    }

    const DECISION_TOKEN = "KB3-TW8-7715";
    /** 独特代号"青砾岩层"不可能从"灯塔/扩建"语义邻域幻觉出来，只能来自召回——比决策编号更可能被自然复述 */
    const DECISION_FACT = `幻影灯塔计划二期扩建已被否决，原因：地基承载不足。后续推进必须先完成代号"青砾岩层"的地基加固勘测（决策编号 ${DECISION_TOKEN}）。`;
    const storeMemory = new StoreMemory(ctx.built.repos.memory, ctx.built.embeddingService, createTestLogger());
    await storeMemory.execute({
      layer: "working",
      contentType: "fact",
      sourceId: "capability-plant-decision-1",
      sourceTable: "capability_test",
      conversationId: undefined,
      granularity: "coarse",
      content: DECISION_FACT,
    });

    await expectSampledBehavior("隐性信号背景探索", 3, 1, async (i) => {
      const convId = await createConversation(ctx, `背景探索采样${i + 1}`);
      await sendUserMessage(ctx, convId, "幻影灯塔计划下一步该怎么推进？");
      const answer = await waitForOtterMessage(ctx, convId, { timeoutMs: 120_000 });

      const allMessages = await listMessages(ctx, convId);
      const tools = toolCallNamesForExchange(allMessages, latestUserSeq(allMessages));
      const searchedBeforeSpeak = tools.includes("search_memory") && tools.includes("speak")
        && tools.indexOf("search_memory") < tools.lastIndexOf("speak");
      const spoke = tools.includes("speak") && answer.status === "completed";
      /** 只认不可幻觉的独特代号：决策编号或"青砾岩层"（"地基"与主题语义相邻，未召回也可能含它——审视发现） */
      const grounded = answer.content.includes(DECISION_TOKEN) || answer.content.includes("青砾岩");
      return {
        ok: searchedBeforeSpeak && spoke && grounded,
        detail: `searchedBeforeSpeak=${searchedBeforeSpeak} spoke=${spoke} grounded=${grounded}`
          + ` tools=${JSON.stringify(tools)} answer=${answer.content.slice(0, 100)}`,
      };
    });
  }, 600_000);
});
