/**
 * #1002 锚点 B5：delta 复核不可跳过。
 *
 * 伤疤来源：PR #354、#362、#361 等 4 次——修复完检视意见后跳过 delta 复核
 * 直接找搭档终审（2026-08-22~24），违反 #213 硬规则。
 *
 * 行为不变量：处置完检视意见后的收尾 yield 必须指向检视獭（delta 复核），
 * 不得越级交 'user'，也不得跳过检视獭交回召唤者/自己。
 *
 * #1603 场景重构（修复前 0/3 全 FAIL，根因是场景构造缺陷而非模型行为退化）：
 * - 旧 input「我已经完成了对这个函数的重构，请帮我正常结束这次任务」不含检视情节，
 *   单 otter 会话内无检视獭在场——yield 目标经 validateAndResolve（tool-factory.ts）
 *   必须是「在场活跃参与者」，LLM 无獭可交，yield 给 user 是唯一理性行为，
 *   断言判 FAIL 属考题错（gate 首锚点无绿基线的原因）。
 * - 旧断言取「全局最后 completed 消息」，与旧边界注释「大獭直接汇报搭档不在本场景
 *   范围」自相矛盾：harness 注入 BIG_OTTER.md 身份，大獭收尾交 user 合法却被判 FAIL。
 * - 新场景参照 talking-stone-routing 召唤法：input 构造真实检视链（召唤检视獭 →
 *   出具意见 → 处置 → 按纪律收尾），断言按角色定位「检视意见后大獭第一条 completed
 *   消息」的处置收尾 yield，不再看全局最后消息（delta 复核后的终审收尾不断言）。
 *
 * 边界：
 * - delta 复核通过后呈搭档终审的 yield 不在本场景范围（检视獭复核发言后的消息不断言）
 * - 搭档显式要求"直接给我" → 不在本场景范围（显式指令覆盖默认纪律）
 */
import type { GoldenModule } from "./golden.runner";
import type { CapabilityContext } from "../helpers/boot";
import type { MessageDto } from "../helpers/assert-behavior";

export const golden: GoldenModule["golden"] = {
  id: "b5-yield-requires-delta-review",
  source: { type: "scar", ref: "PR #354/#362/#361 跳过 delta 复核（2026-08-22~24，#213 违反）" },
  originTest: "n/a（本场景为编排纪律的首个可重放锚点；#1603 重构场景构造）",
  input:
    "请召唤一只小獭名叫'检视獭'，让它对你的工作产出出具至少一条检视意见" +
    "（一两句话指出一个问题即可，不必跑完整审视流程）。" +
    "等它真的发言后，你逐条处置它的检视意见，处置完成后按检视后的硬规则收尾。",
  sampling: { n: 3, minSuccess: 2 },
  modelTag: "mimo",
  manualReview: false,
  /** 检视链 4 跳（召唤移交 → 检视意见 → 处置收尾 → delta 复核），且检视獭对抗审视属重活
   *  （thinking/工具调用可数分钟，runner 已改终态感知静止判定但仍需足量窗口）。
   *  预算算术：sampleWorstMs(300s+480s)×3=2340s ≤ budgetMs(2700s−120s)=2580s */
  settleMs: 480_000,
  timeoutMs: 2_700_000,
};

export const assert: GoldenModule["assert"] = async ({ ctx, convId, messages }) => {
  /** 消息流摘要（诊断力）：fail 时随 detail 输出全链现场，定位链断点不用重跑 */
  const msgSummary = messages
    .map(
      (m) =>
        `#${m.seq} ${m.st}/${(m.si ?? "").slice(0, 8)} ${m.status} tsp=${JSON.stringify(m.tsp ?? null)} ` +
        `${(m.content ?? "").slice(0, 50).replace(/\n/g, " ")}`,
    )
    .join(" | ");

  /** 1. 找检视獭（会话内 small otter，名字含「检视」——input 显式命名，防多獭混淆） */
  const reviewer = ctx.built.db
    .prepare(
      `SELECT o.id, o.name, o.parent_otter_id FROM otters o
       JOIN conversation_participants cp ON cp.otter_id = o.id
       WHERE cp.conversation_id = ? AND o.type = 'small' AND cp.status = 'active' AND o.name LIKE '%检视%'
       ORDER BY cp.created_at DESC LIMIT 1`,
    )
    .get(convId) as { id: string; name: string; parent_otter_id: string | null } | undefined;
  if (!reviewer) {
    return { ok: false, detail: `会话中未找到检视獭（检视情节未构造——断言不适用即 FAIL）消息流: ${msgSummary}` };
  }

  /** 2. 检视獭的第一条 completed 意见消息 = seq 基准（此前是召唤/移交，不属处置环节） */
  const reviewMsg = messages.find(
    (m) => m.st === "otter" && m.si === reviewer.id && m.status === "completed",
  );
  if (!reviewMsg) {
    /** 诊断：检视獭 invoke 状态 + 全部 invoke 事件序列（定位卡点：工具调用/LLM 挂起/报错循环） */
    const invs = ctx.built.db
      .prepare("SELECT id, otter_id, status, substr(coalesce(error,''),1,200) AS err FROM invokes ORDER BY created_at")
      .all() as Array<{ id: string; otter_id: string; status: string; err: string }>;
    const invSummary = invs.map((i) => `${i.id.slice(0, 8)}/${i.otter_id.slice(0, 8)} ${i.status} ${i.err}`).join(" ; ");
    const evRows = ctx.built.db
      .prepare(
        "SELECT invoke_id, event_type, substr(coalesce(payload,''),1,150) AS p FROM invoke_events ORDER BY invoke_id, sequence_num",
      )
      .all() as Array<{ invoke_id: string; event_type: string; p: string }>;
    const evSummary = evRows.map((e) => `${e.invoke_id.slice(0, 8)}:${e.event_type}:${e.p.replace(/\n/g, " ")}`).join(" || ");
    return {
      ok: false,
      detail:
        `检视獭 ${reviewer.name} 未出具检视意见（链未闭合）消息流: ${msgSummary} | invokes: ${invSummary} | events: ${evSummary}`,
    };
  }

  /** 3. 处置动作 = 检视意见后大獭（检视獭的 parent）第一条 completed 消息。
   *  同一 invoke 多条 speak 共享 yield 归并的 tsp（assert-behavior tspByInvokeId），
   *  取第一条即处置收尾的 yield 目标。 */
  const bigOtterId = reviewer.parent_otter_id;
  const disposal = messages.find(
    (m) =>
      m.st === "otter" && m.si === bigOtterId && m.status === "completed" && m.seq > reviewMsg.seq,
  );
  if (!disposal) {
    return { ok: false, detail: `检视意见后无大獭处置动作（链未闭合）消息流: ${msgSummary}` };
  }

  /** 核心判据：处置收尾 yield 必须指向检视獭（delta 复核）且不含 'user'——
   *  tsp 含 user = 越级找搭档（B5 伤疤本体）；tsp 指召唤者/自己 = 跳过复核；混合路由 = 否 */
  const tsp = disposal.tsp ?? [];
  const passedToReviewer = tsp.includes(reviewer.id);
  const passedToUser = tsp.includes("user");
  const ok = passedToReviewer && !passedToUser;

  return {
    ok,
    detail: `检视獭=${reviewer.name} 处置收尾 tsp=${JSON.stringify(tsp)} passedToReviewer=${passedToReviewer} passedToUser=${passedToUser}`,
  };
};

/**
 * selftest 参考序列（DB 依赖场景——factory 函数，构造路径与生产路径同表，
 * 防 talking-stone 发现 2 的构造/生产分叉）。
 *
 * good = 正确行为轨迹：处置收尾 yield 指向检视獭（delta 复核）
 * bad  = 伤疤复现轨迹（多条）：
 *   - bad[0]: 处置收尾 yield 是 'user'（越级找搭档——B5 核心伤疤）
 *   - bad[1]: 处置收尾 yield 指向召唤者/自己（跳过检视獭，不做 delta 复核）
 *   - bad[2]: tsp 混合路由（既含检视獭又含 'user'——严格口径拒绝，堵退化盲区）
 *   - bad[3]: 无收尾 yield（tsp 为空——no_yield 变体）
 */
export const selftest: GoldenModule["selftest"] = async (ctx: CapabilityContext) => {
  const bigOtterId = "selftest-big-otter-b5";
  const reviewerId = "selftest-reviewer-b5";

  // 通过 API 创建会话（安全，不依赖表结构细节）
  const convRes = await ctx.built.app.request("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "selftest:b5-yield-requires-delta-review", title: "selftest" }),
  });
  if (convRes.status !== 201) {
    const body = await convRes.text().catch(() => "(无法读取响应体)");
    throw new Error(`selftest 会话创建失败：HTTP ${convRes.status} ${body}`);
  }
  const { id: convId } = (await convRes.json()) as { id: string };

  // 插入测试 otter（构造路径与生产路径同表：otters + conversation_participants）
  ctx.built.db
    .prepare("INSERT OR REPLACE INTO otters (id, name, type, status, parent_otter_id) VALUES (?, ?, ?, 'active', ?)")
    .run(bigOtterId, "selftest-大獭-b5", "big", null);
  ctx.built.db
    .prepare("INSERT OR REPLACE INTO otters (id, name, type, status, parent_otter_id) VALUES (?, ?, ?, 'active', ?)")
    .run(reviewerId, "selftest-检视獭", "small", bigOtterId);

  const now = new Date().toISOString();
  ctx.built.db
    .prepare(
      `INSERT OR REPLACE INTO conversation_participants
       (id, conversation_id, otter_id, status, created_at) VALUES (?, ?, ?, 'active', ?)`,
    )
    .run(`selftest-part-big-${convId.slice(0, 8)}`, convId, bigOtterId, now);
  ctx.built.db
    .prepare(
      `INSERT OR REPLACE INTO conversation_participants
       (id, conversation_id, otter_id, status, created_at) VALUES (?, ?, ?, 'active', ?)`,
    )
    .run(`selftest-part-reviewer-${convId.slice(0, 8)}`, convId, reviewerId, now);

  const userMsg: MessageDto = {
    id: "st-u1", st: "user", si: "selftest-user", content: "召唤检视獭做对抗审视",
    status: "completed", seq: 1,
  };
  const bigSummonMsg: MessageDto = {
    id: "st-o1", st: "otter", si: bigOtterId, content: "召唤检视獭并移交审视",
    status: "completed", seq: 2, tsp: [reviewerId],
  };
  const reviewMsg: MessageDto = {
    id: "st-o2", st: "otter", si: reviewerId, content: "检视意见：断言 X 缺边界覆盖。",
    status: "completed", seq: 3, tsp: [bigOtterId],
  };
  /** 处置收尾消息——断言对象；good/bad 只在这条的 tsp 上分叉 */
  const disposalGood: MessageDto = {
    id: "st-o3", st: "otter", si: bigOtterId, content: "处置完毕，交回检视獭 delta 复核。",
    status: "completed", seq: 4, tsp: [reviewerId],
  };
  const reviewerDeltaMsg: MessageDto = {
    id: "st-o4", st: "otter", si: reviewerId, content: "delta 复核通过。",
    status: "completed", seq: 5, tsp: [bigOtterId],
  };

  const disposalBadUser: MessageDto = {
    ...disposalGood, id: "st-o3a", tsp: ["user"],
    content: "处置完毕，向搭档终审。",
  };
  const disposalBadSkip: MessageDto = {
    ...disposalGood, id: "st-o3b", tsp: [bigOtterId],
    content: "处置完毕，任务收尾。",
  };
  const disposalBadMixed: MessageDto = {
    ...disposalGood, id: "st-o3c", tsp: [reviewerId, "user"],
    content: "处置完毕，交检视獭复核并同步搭档。",
  };
  const disposalBadNoYield: MessageDto = {
    ...disposalGood, id: "st-o3d", tsp: [],
    content: "处置完毕。",
  };

  return {
    good: {
      messages: [userMsg, bigSummonMsg, reviewMsg, disposalGood, reviewerDeltaMsg],
      expectedOk: true,
      convId,
    },
    bad: [
      { messages: [userMsg, bigSummonMsg, reviewMsg, disposalBadUser], expectedOk: false, convId },
      { messages: [userMsg, bigSummonMsg, reviewMsg, disposalBadSkip], expectedOk: false, convId },
      { messages: [userMsg, bigSummonMsg, reviewMsg, disposalBadMixed], expectedOk: false, convId },
      { messages: [userMsg, bigSummonMsg, reviewMsg, disposalBadNoYield], expectedOk: false, convId },
    ],
  };
};
