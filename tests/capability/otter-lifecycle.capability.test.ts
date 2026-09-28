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

/** BIG_OTTER.md 的身份标记（改文案需同步——这是有意的文案存在性守护）。
 *  鉴别力依据（检视獭-1192 发现 1 修复）：动态上下文（在场成员/对话历史/工作区）
 *  只泄漏獭名（「大獭」），完整称谓「海獭团队的头儿」及其组成词不进 user message——
 *  模型自称它只能来自 system role 注入的身份行。 */
const IDENTITY_MARKER = "海獭团队的头儿";
/** 身份自称的强 token 向量（任一命中即判身份注入生效）——均源自 BIG_OTTER.md 身份内容，
 *  不在动态上下文泄漏面（名册段只泄漏獭名「大獭」，不含称谓/角色词；run10 实证模型
 *  会用「统筹全场的那只海獭」改写，单一 token 向量过窄导致误红，按身份内容全谱系取）。
 *  不断言「大獭」「海獭」：名册段直接泄漏，自称无鉴别力。 */
const IDENTITY_SELF_CLAIM_TOKENS = ["海獭团队", "头儿", "统筹", "编排"];

/** 测试提问原文（刻意不含任何身份 token——行为断言的鉴别力来自提示词不泄漏答案；
 *  检视獭-1192 发现 1：旧版「逐字包含『海獭团队的头儿』」是断言空转，无论身份注入
 *  是否生效，指令跟随的模型都会输出标记词，测试对注入失效零鉴别力） */
const IDENTITY_PROMPTS = [
  "你好，请用一句话介绍你自己",
  "好的，请你再完整地自我介绍一次",
];

/** 从 jsonl entry 提取用户消息纯文本（拼接全部 text 块——单块是当前设计
 *  （buildMessageWithContext 返回单串），多块拼接防 SDK 演进后后续块漏检：
 *  检视獭-1192 建议 1 的未锁定假设，显式收拢）；解析失败返回空串。
 *  负向断言用：session-file helper 的 text 是整行 JSON 序列化，嵌套转义会干扰包含性判定。 */
function extractUserText(entry: { raw: Record<string, unknown> }): string {
  const msg = entry.raw.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
  return (msg?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

/** 提取叠加式档案「① 交接意图书」层的内容（剥标题行，至下一节标题或档案尾）。
 *  两种形态标题后缀不同（机械转储「触发方自总结原话」/叙事合成「触发方原话，不转述」），
 *  匹配只锚「### ① 交接意图书」前缀。检视獭-1192 发现 2 修复：原话必须恰在 ① 层内
 *  且不被转述/截断/追加——toContain 三连只锁「原话在档案某处」，锁不了归属与完整性。 */
function extractHandoffSectionOne(archive: string): string {
  const after = archive.split("### ① 交接意图书")[1];
  if (!after) return "";
  const body = after.split("\n").slice(1).join("\n"); // 剥标题行（后缀两形态不定）
  return body.split(/\n###/)[0].trim(); // 行首 ### 才是节标题，到下一节止
}

/** 断言模型回答含身份自称强 token（任一命中即过）。
 *  行为断言遵守 helper 纪律：只断不变量（身份 token 出现），不断言具体措辞。 */
function expectIdentitySelfClaim(content: string, label: string): void {
  const hit = IDENTITY_SELF_CLAIM_TOKENS.filter((t) => content.includes(t));
  expect(
    hit.length > 0,
    `${label}：模型应自称身份（命中 token：${JSON.stringify(IDENTITY_SELF_CLAIM_TOKENS)}；实际回答头 120 字：${content.slice(0, 120)}）`,
  ).toBe(true);
}

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
    /** afterSeq 必须基于本轮终态，否则下一轮 wait 命中本轮的 completed 旧消息（空转断言） */
    const firstRound = await waitForOtterMessage(ctx, convId, { timeoutMs: 120_000 });

    const firstSession = await ctx.built.repos.otter.getActiveSession(otterId);
    expect(firstSession, "F20260805rsto 不变量：有对话即有 active domain session").not.toBeNull();

    // 1b. 种子前置：为该对话写入 working 记忆（restart 管线「工作记忆转历史」的输入）。
    // F20260928cl1a：原断言隐式依赖「对话消息自动写入 working 记忆」——该链路已被 #886
    // （F20260913ctlv，messages 表族退役）删除 indexMessage 后中断（生产库 9/13 后 message 类
    // 记忆零新增，另立 issue 跟踪产品侧恢复）。本用例改为显式构造前置数据：经真实装配的
    // memoryWriter 写入，验证 restart 管线自身的转换职责（archiveSession 第 5 步 updateLayer）。
    await ctx.built.repos.memoryWriter.storeEntry({
      id: `mem-restart-${Date.now()}`,
      layer: "working",
      contentType: "message",
      sourceId: `seed-${convId}`,
      sourceTable: "entries",
      conversationId: convId,
      granularity: "fine",
      content: "前世工作记忆：restart 验证种子",
      metadata: null,
      createdAt: new Date().toISOString(),
    });

    // 2. 重启獭生（携带手工 summary——F20260917rsta 搭档语义：填了就按你的）
    const restartRes = await ctx.built.app.request(`/api/otters/${otterId}/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "前世摘要：寒暄过一轮" }),
    });
    expect(restartRes.status).toBe(201);
    const restartBody = await restartRes.json() as { id: string };

    // 3. 账本断言（确定性，严格）：旧行封存 + 新行建链。
    // F20260928cl1a 断言语义更新（对齐 #1146/F20260920uhuc 统一交接管线的有意变更，非回归）：
    // 生产装配（OtterController 带 agentInvoker）下 restart 恒走 restartWithUnifiedHandoff，
    // summary 字段落账的是「叠加式档案」全文（narrative-synthesis-engine assembleHandoffArchive /
    // buildMechanicalArchive 组装），手工 selfSummary 以 ① 交接意图书 原话层嵌在档案内——
    // 这正是 F20260917rsta 搭档语义的实现形态（「填了就按我的」= 原话独立保留在 ① 层，
    // 不被叙事合成转述吞掉）。真跑环境合成模型不可用/降级时档案为机械转储形态，
    // ① 层结构不变，断言对两种形态都成立。
    const history = await ctx.built.repos.otter.getSessionHistory(otterId);
    expect(history).toHaveLength(2);
    const oldRow = history.find((s) => s.id === firstSession!.id)!;
    expect(oldRow.status).toBe("restarted");
    expect(oldRow.archiveReason).toBe("restart");
    /** 档案断言（形式不变量 + 层位全等，不锁档案全文——合成内容非确定）：
     *  ① 是档案（叠加式结构头）而非裸透传；② ① 交接意图书 层存在；
     *  ③ 层内内容恰为手工 summary 原话（检视獭-1192 发现 2 修复：锁归属与完整性，
     *  防原话被转述进 ② 层或层内被追加篡改而 toContain 全绿的漏检） */
    expect(oldRow.summary, "旧行 summary 应为叠加式档案（unified handoff 管线写入）").toContain("前世档案");
    expect(oldRow.summary, "手工 summary 应以 ① 交接意图书 层原话保留").toContain("### ① 交接意图书");
    expect(
      extractHandoffSectionOne(oldRow.summary!),
      "① 层内容应恰为手工 summary 原话（不转述、不截断、不追加——F20260917rsta 层位契约）",
    ).toBe("前世摘要：寒暄过一轮");
    const newRow = history.find((s) => s.id !== firstSession!.id)!;
    expect(newRow.status).toBe("active");
    expect(newRow.previousSessionId).toBe(firstSession!.id);
    /** 双写不变量保留（F20260805rsto）：新旧行 summary 同源（同一次 restartSession(archive) 写入） */
    expect(newRow.summary).toBe(oldRow.summary);
    expect(restartBody.id).toBe(newRow.id);

    // 4. 记忆层转换：验证 restart 管线把种子 working 记忆转为 historical
    const layers = ctx.built.db.prepare(
      "SELECT DISTINCT layer FROM memory_entries WHERE conversation_id = ?",
    ).all(convId) as Array<{ layer: string }>;
    expect(layers.length).toBeGreaterThan(0);
    for (const { layer } of layers) {
      expect(layer, "restart 后前世记忆应转 historical").toBe("historical");
    }

    // 5. 新獭生可用：再发消息能走到终态（真 LLM invoke 链路完好）
    await sendUserMessage(ctx, convId, "你还在吗？回复一下");
    const after = await waitForOtterMessage(ctx, convId, { timeoutMs: 120_000, afterSeq: firstRound.seq });
    expect(after.status).toBe("completed");
  }, 600_000);

  it("身份注入：身份经 system role 注入（首末等权）+ 用户消息不携带身份前缀", async (t) => {
    if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

    const convId = await createConversation(ctx, "身份注入验证");
    const otterId = await getConversationOtterId(ctx, convId);

    await sendUserMessage(ctx, convId, IDENTITY_PROMPTS[0]);
    const round1 = await waitForOtterMessage(ctx, convId, { timeoutMs: 120_000 });
    expect(round1.status).toBe("completed");

    // ── 断言面 A：行为证据——身份注入有效性的开放提问验证（提示词不泄漏答案）──
    // 大獭的身份（BIG_OTTER.md「你是大獭 🦦，海獭团队的头儿」）经 system role 注入
    // （F20260810piab S1：before_agent_start handler 注入 system prompt，不持久化到
    // session jsonl、也不拼在 user message——session 文件里抓不到，行为是第一等证据面）。
    // 鉴别力：提问不含任何身份 token，动态上下文只泄漏獭名（「大獭」）不泄漏称谓——
    // 模型自称「海獭团队」/「头儿」只能来自 system 注入的身份行（检视獭-1192 发现 1 修复：
    // 旧版引导模型逐字复述标记词是断言空转，对注入失效零鉴别力）。
    expectIdentitySelfClaim(round1.content, "第一轮：大獭应能自称身份（system 身份注入生效的行为证据）");

    // ── 断言面 B：架构不变量——用户消息不携带身份前缀 ──
    // S1 迁移后 user message 只含动态上下文（工作区/在场成员/对话历史）+ 用户输入，
    // 身份持久化进 user message 是 F20260810piab 之前的旧架构（会随 session 历史膨胀）。
    // 提问原文不含身份 token（断言面 A 同源设计），无回声需剔除——直接断言不含完整称谓。
    const sessionFile = getSessionFile(ctx.built.db, otterId);
    expect(sessionFile, "agent_sessions 应有 session_file").toBeTruthy();

    const firstRound = readSessionMessages(sessionFile!);
    const firstUser = firstRound.find((e) => e.isUser);
    expect(firstUser, "session 中应有用户消息").toBeTruthy();
    expect(extractUserText(firstUser!), "session 中应有可解析的用户文本").toBeTruthy();
    expect(extractUserText(firstUser!), "用户消息不应携带身份前缀（S1 后身份走 system role，注入 user message 是旧架构）").not.toContain(IDENTITY_MARKER);

    // 第二轮：身份仍可用（system role 每次 invoke 重建注入——不依赖 session 历史恢复）。
    // afterSeq 确保等到第二轮真实终态再读 session 文件（否则读到第一轮内容，恒真空转）。
    await sendUserMessage(ctx, convId, IDENTITY_PROMPTS[1]);
    const round2 = await waitForOtterMessage(ctx, convId, { timeoutMs: 120_000, afterSeq: round1.seq });
    expect(round2.status).toBe("completed");
    expectIdentitySelfClaim(round2.content, "第二轮：身份仍可用（system 每次重建注入）");

    // 第二轮用户消息同样不带身份前缀（架构不变量持续成立）。
    // 假设声明（检视獭-1192 建议 1）：assistant 自己的发言不进自己的未读注入批
    // （未读窗=「你上次发言后的消息」，dispatch-chain-engine.ts 未读批构造），
    // 故第一轮回答中的身份自称不会被回显进第二轮 user message；若该机制变更需同步本断言。
    const secondRound = readSessionMessages(sessionFile!);
    for (const e of secondRound.filter((x) => x.isUser)) {
      expect(extractUserText(e), "任何用户消息都不应携带身份前缀（S1 架构）").not.toContain(IDENTITY_MARKER);
    }
    /** 第二轮的用户消息确实已进入 session（证明第二轮 invoke 真实发生） */
    const userMsgCount = secondRound.filter((e) => e.isUser).length;
    expect(userMsgCount, "session 中应有至少两轮用户消息").toBeGreaterThanOrEqual(2);
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
