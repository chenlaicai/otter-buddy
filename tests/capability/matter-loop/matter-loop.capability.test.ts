/**
 * 能力测试：matter loop 闭环链路（F20261006mtlp P1）。
 *
 * 方案验证节锁定三条能力测试场景：
 * ①yield to user 的 L2 自动登记 matter（准入路径 1——獭打标 expects_partner_decision）
 * ②restart 后新世獭档案含 open matters 清单字段（机械供料 handoff_open_matters）
 * ③板上按钮批准回执 → 路由 owner 獭代执行迁移（matters 表状态迁移 + resolution 留痕——P2 补上，F20261006mlp2）
 * ④板上「+」登记回执 → 獭用 register_matter 工具登记（matters 表新增 OPEN 行——P2 严重1 死链修复的验证面，F20261006mlp2）
 *
 * 断言策略：LLM 行为（獭是否会按指令打标）用统计采样；DB 登记与档案供料是
 * 确定性断言（严格）——登记发生在工具层，只要獭调 yield 带标就必然落库。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootCapabilityApp, type CapabilityContext } from "../helpers/boot";
import {
  createConversation,
  sendUserMessage,
  waitForOtterMessage,
  expectSampledBehavior,
} from "../helpers/assert-behavior";

/** 提取「本对话未闭环事情」机械供料段全文（档案段存在性 + 内容锚断言用） */
function extractOpenMattersSection(archive: string): string | null {
  const marker = "### ④ 机械供料：本对话未闭环事情（matters）";
  const idx = archive.indexOf(marker);
  if (idx < 0) return null;
  const rest = archive.slice(idx + marker.length);
  // 段落截止到下一个 ### 或文末
  const next = rest.indexOf("\n### ");
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

describe("matter loop：L2 拍板登记 + 重启机械供料（真系统 + 真 LLM）", () => {
  let ctx: CapabilityContext;

  beforeAll(async () => {
    ctx = await bootCapabilityApp();
  });

  afterAll(() => {
    ctx?.cleanup();
  });

  it(
    "① yield to user 打标 expects_partner_decision → matters 表自动登记 WAITING_PARTNER（3 采样 ≥2）",
    async (t) => {
      if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

      await expectSampledBehavior("matter-loop-yield-registration", 3, 2, async (i) => {
        const convId = await createConversation(ctx, `matter登记采样${i + 1}`);

        /** 指令设计：让大獭以「需要拍板」形态 yield to user 并打标。
         *  极简决策项（二选一）降低 LLM 任务复杂度，聚焦打标行为本身。 */
        await sendUserMessage(
          ctx,
          convId,
          "你现在需要我做一个二选一决定：回复主题的配色用「薄荷绿」还是「琥珀橙」？。" +
          "请用 yield 把行动权交给我（to=[\"user\"]），reason 写清楚在等什么决定，" +
          "并且 expects_partner_decision 参数传 true（这是必须等我拍板的 L2 项）。" +
          "交棒前先 speak 一句话说明你在等我拍板。",
        );

        try {
          await waitForOtterMessage(ctx, convId, { timeoutMs: 300_000 });
        } catch {
          return { ok: false, detail: "大獭未在超时内交棒（可能 yield 失败或 LLM 未按指令打标）" };
        }

        /** 确定性断言：matters 表是否登记（打标与否是机械行为——登记只在参数为 true 时发生） */
        const matters = ctx.built.db.prepare(
          "SELECT id, title, state, level, waiting_on, owner_otter_id FROM matters WHERE conversation_id = ?",
        ).all(convId) as Array<Record<string, string>>;
        if (matters.length === 0) {
          return { ok: false, detail: "matters 表无登记——獭未打标 expects_partner_decision（LLM 行为偏差）" };
        }
        const m = matters[0];
        if (m.state !== "WAITING_PARTNER" || m.level !== "L2" || m.waiting_on !== "partner") {
          return { ok: false, detail: `登记字段错位：state=${m.state} level=${m.level} waiting_on=${m.waiting_on}` };
        }
        return { ok: true, detail: `登记 ${m.id.slice(0, 8)}（${m.title.slice(0, 40)}）` };
      });
    },
    900_000,
  );

  it(
    "② restart 后新世档案含 open matters 机械供料段（确定性断言）",
    async (t) => {
      if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

      const convId = await createConversation(ctx, "matter机械供料验证");

      // 1. 真实对话一轮（建立 session 与上下文）
      await sendUserMessage(ctx, convId, "你好，随便回应一句");
      const firstRound = await waitForOtterMessage(ctx, convId, { timeoutMs: 120_000 });
      const otterId = firstRound.si;

      // 2. 直接经仓库登记一件 open matter（确定性前置——不依赖 LLM 打标，
      //    本用例的鉴别面是「档案含供料段」，登记路径由场景①覆盖）
      const now = new Date().toISOString();
      ctx.built.db.prepare(`
        INSERT INTO matters (id, conversation_id, title, origin_message_id, owner_otter_id, level, state, waiting_on, waiting_for, payload, resolution, resolved_by, created_at, updated_at, closed_at)
        VALUES (?, ?, ?, NULL, ?, 'L2', 'WAITING_PARTNER', 'partner', ?, NULL, NULL, NULL, ?, ?, NULL)
      `).run(
        crypto.randomUUID(),
        convId,
        "能力测试种子：配色拍板事项",
        otterId,
        "选薄荷绿还是琥珀橙",
        now,
        now,
      );

      // 3. 重启獭生（统一交接管线——机械供料注入档案）
      const restartRes = await ctx.built.app.request(`/api/otters/${otterId}/restart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "matter 供料验证：重启前有一件待拍板事项" }),
      });
      expect(restartRes.status).toBe(201);

      // 4. 档案断言（确定性，严格）：旧行 summary 含「本对话未闭环事情」供料段 + 种子事项标题
      const history = await ctx.built.repos.otter.getSessionHistory(otterId);
      const oldRow = history.find((s) => s.summary?.includes("### ① 交接意图书"));
      expect(oldRow, "统一交接管线应写入叠加式档案").toBeDefined();
      const section = extractOpenMattersSection(oldRow!.summary!);
      expect(section, "档案应含「本对话未闭环事情（matters）」机械供料段").not.toBeNull();
      expect(section!).toContain("配色拍板事项");
      expect(section!).toMatch(/M-[0-9a-f]{8}/);
      expect(section!).toContain("待搭档裁决");
    },
    600_000,
  );

  it(
    "③ 板上按钮批准回执 → 路由 owner 獭代执行迁移（matters 表状态迁移 + resolution 留痕，3 采样 ≥2）",
    async (t) => {
      if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

      await expectSampledBehavior("matter-loop-board-verdict", 3, 2, async (i) => {
        const convId = await createConversation(ctx, `matter板上裁决采样${i + 1}`);

        // 1. 真实对话一轮拿到大獭 id（owner 路由目标）
        await sendUserMessage(ctx, convId, "你好，随便回应一句");
        const firstRound = await waitForOtterMessage(ctx, convId, { timeoutMs: 120_000 });
        const ownerId = firstRound.si;

        // 2. 确定性前置：登记一件 WAITING_PARTNER matter（owner=大獭）——
        //    板上按钮的数据源，不依赖 LLM 打标（登记路径由场景①覆盖）
        const matterId = crypto.randomUUID();
        const now = new Date().toISOString();
        ctx.built.db.prepare(`
          INSERT INTO matters (id, conversation_id, title, origin_message_id, owner_otter_id, level, state, waiting_on, waiting_for, payload, resolution, resolved_by, created_at, updated_at, closed_at)
          VALUES (?, ?, ?, NULL, ?, 'L2', 'WAITING_PARTNER', 'partner', ?, NULL, NULL, NULL, ?, ?, NULL)
        `).run(matterId, convId, "配色拍板事项", ownerId, "选薄荷绿还是琥珀橙", now, now);
        const anchor = `M-${matterId.slice(0, 8)}`;

        // 3. 模拟板上「批准」按钮的合成回执（F20261006mlp2 回执代执行通道 B），
        //    显式路由 owner 獭——断言獭读懂 html-matter-action 意图并代执行迁移
        await sendUserMessage(
          ctx,
          convId,
          `【待办·板上批准】${anchor}「配色拍板事项」—— 请代我执行板上迁移：WAITING_PARTNER → DONE_PENDING_CONFIRM。\n\n` +
          `\`\`\`html-matter-action matter="${anchor}" to="DONE_PENDING_CONFIRM" on_behalf_of="partner"\n` +
          `{"matter":"${matterId}","to":"DONE_PENDING_CONFIRM","on_behalf_of":"partner","partner_intent":"批准"}\n` +
          `\`\`\``,
          { talkingStonePassedTo: [ownerId] },
        );

        try {
          await waitForOtterMessage(ctx, convId, { timeoutMs: 300_000 });
        } catch {
          return { ok: false, detail: "owner 獭未在超时内响应回执" };
        }

        // 4. 确定性断言：matters 表已迁移 + resolution 留痕（代执行是机械行为——
        //    獭只要 transition_matter 带 on_behalf_of='partner' 就必然落库）
        const row = ctx.built.db.prepare(
          "SELECT state, resolution, resolved_by FROM matters WHERE id = ?",
        ).get(matterId) as { state: string; resolution: string | null; resolved_by: string | null } | undefined;
        if (!row) return { ok: false, detail: "matter 行消失" };
        if (row.state !== 'DONE_PENDING_CONFIRM') {
          return { ok: false, detail: `板上批准后状态未迁移：state=${row.state}（獭未代执行或迁移被拒）` };
        }
        if (!row.resolution) {
          return { ok: false, detail: "迁移缺 resolution 留痕（宣告权审计面）" };
        }
        return { ok: true, detail: `${anchor} → DONE_PENDING_CONFIRM（resolution 留痕）` };
      });
    },
    900_000,
  );

  it(
    "④ 板上「+」登记回执 → 獭用 register_matter 工具登记（matters 表新增 OPEN 行，3 采样 ≥2）",
    async (t) => {
      if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

      await expectSampledBehavior("matter-loop-board-register", 3, 2, async (i) => {
        const convId = await createConversation(ctx, `matter板上登记采样${i + 1}`);

        // 1. 真实对话一轮拿到大獭 id（登记回执走默认派发——退派兜底在场大獭）
        await sendUserMessage(ctx, convId, "你好，随便回应一句");
        await waitForOtterMessage(ctx, convId, { timeoutMs: 120_000 });

        // 2. 模拟板上「+」登记的合成回执（准入路径 2：搭档手动登记 initialState=OPEN）——
        //    F20261006mlp2 严重1 修复的验证面：P1 工具面没注册登记工具=登记必丢，本场景锁死后链路。
        await sendUserMessage(
          ctx,
          convId,
          `【待办·登记一件事】回头再看的重构项 —— 请登记到本对话待办板（initialState=OPEN，准入路径 2：搭档手动登记）。\n\n` +
          `\`\`\`html-matter-action register="true" initial_state="OPEN"\n` +
          `{"title":"回头再看的重构项","initial_state":"OPEN","origin":"partner-manual"}\n` +
          `\`\`\``,
        );

        try {
          await waitForOtterMessage(ctx, convId, { timeoutMs: 300_000 });
        } catch {
          return { ok: false, detail: "獭未在超时内响应登记回执" };
        }

        // 3. 确定性断言：matters 表新增一件 OPEN 状态、标题匹配（登记是机械行为——
        //    獭只要 register_matter 就必然落库；P1 无此工具则必然失败，正是死链的反面）
        const row = ctx.built.db.prepare(
          "SELECT id, title, state, owner_otter_id FROM matters WHERE conversation_id = ? AND title = ?",
        ).get(convId, "回头再看的重构项") as { id: string; state: string; owner_otter_id: string | null } | undefined;
        if (!row) return { ok: false, detail: "登记回执后 matters 表无新增行——登记死链（register_matter 工具未生效）" };
        if (row.state !== 'OPEN') {
          return { ok: false, detail: `登记后状态非 OPEN：state=${row.state}` };
        }
        return { ok: true, detail: `已登记 M-${row.id.slice(0, 8)}（OPEN，owner=${(row.owner_otter_id ?? '').slice(0, 8) || '未指派'}）` };
      });
    },
    900_000,
  );
});
