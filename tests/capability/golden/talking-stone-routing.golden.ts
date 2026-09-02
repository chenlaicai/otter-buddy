/**
 * F20260825evgl 伤疤4：talking-stone 路由。
 *
 * 源测试锚点：talking-stone-routing.capability.test.ts（断言复用该测试，分叉时以该测试为准）。
 *
 * 行为不变量：子獭（被大獭召唤的小獭）完成本职后，talkingStonePassedTo 传回召唤者（大獭），
 * 不传 'user'。修复前 8/8 检视獭首轮传 user（bug）。
 *
 * 注意：本场景需要大獭先召唤子獭——精简版用单条输入驱动完整链路，
 * 断言逻辑与源测试一致（tsp 含大獭 ID、不含 'user'）。
 */
import {
  toolCallNamesForExchange,
  latestUserSeq,
  type MessageDto,
} from "../helpers/assert-behavior";
import type { GoldenModule } from "./golden.runner";
import type { CapabilityContext } from "../helpers/boot";

export const golden: GoldenModule["golden"] = {
  id: "talking-stone-routing",
  source: { type: "scar", ref: "F20260810rout：修复前 8/8 检视獭首轮误传 user" },
  originTest: "talking-stone-routing.capability.test.ts",
  input: "召唤一只小獭名叫'报告獭'。召唤完后请你把发言权传给它，让它用一句话确认到岗后 speak 交付。",
  sampling: { n: 3, minSuccess: 2 },
  modelTag: "mimo",
  manualReview: false,
};

/** 找子獭（非大獭的 small 类型 otter）的最终 completed 发言（与源测试 findSmallOtterMessage 一致） */
function findSmallOtterMessage(messages: MessageDto[], smallOtterId: string): MessageDto | undefined {
  return messages
    .filter((m) => m.st === "otter" && m.si === smallOtterId && m.status === "completed")
    .sort((a, b) => b.seq - a.seq)[0];
}

export const assert: GoldenModule["assert"] = async ({ ctx, convId, messages }) => {
  const userSeq = latestUserSeq(messages.filter((m) => m.st === "user"));
  const tools = toolCallNamesForExchange(messages, userSeq);

  if (!tools.includes("create_otter")) {
    return { ok: false, detail: `大獭未召唤小獭 tools=${JSON.stringify(tools)}` };
  }

  /** 发现 2 修复（+2026-09-02 表路径修正）：按 conversation_participants 过滤。
   *  原查 conversation_otters（建会话初始名单）——但 create_otter 的 join 链路写
   *  conversation_participants（manage-participant.ts L69），生产路径永不命中旧表，
   *  采样 0/3 稳定 fail；selftest 自插旧表数据故绿灯——构造路径与生产路径分叉。 */
  const smallOtter = ctx.built.db
    .prepare(
      `SELECT o.id, o.name, o.type, o.parent_otter_id FROM otters o
       JOIN conversation_participants cp ON cp.otter_id = o.id
       WHERE cp.conversation_id = ? AND o.type = 'small' AND cp.status = 'active'
       ORDER BY cp.created_at DESC LIMIT 1`,
    )
    .get(convId) as Record<string, string> | undefined;
  if (!smallOtter) {
    return { ok: false, detail: "本会话中未找到 small 类型子獭" };
  }

  const smallMsg = findSmallOtterMessage(messages, smallOtter.id);
  if (!smallMsg) {
    return { ok: false, detail: `子獭 ${smallOtter.name} 未产出 completed 消息` };
  }

  const bigOtterId =
    (ctx.built.db.prepare("SELECT parent_otter_id FROM otters WHERE id = ?").get(smallOtter.id) as {
      parent_otter_id: string;
    }).parent_otter_id;

  // 核心断言：tsp 应包含大獭 ID，不应是 ['user']（DB 存 resolved ID）
  const tsp = smallMsg.tsp ?? [];
  const passedToUser = tsp.includes("user");
  const passedToBigOtter = tsp.includes(bigOtterId);

  return {
    ok: passedToBigOtter && !passedToUser,
    detail: `子獭=${smallOtter.name} tsp=${JSON.stringify(tsp)} match=${passedToBigOtter} body="${smallMsg.content.slice(0, 60)}"`,
  };
};

/**
 * F20260828gssf: selftest 参考序列（DB 依赖场景——factory 函数）。
 *
 * 本场景断言需要查 DB（conversation_participants JOIN otters），所以 selftest 是 factory 函数：
 * 先通过 API 创建会话，再往 DB 插入测试 otter 记录，然后构造带正确 senderId 的消息。
 *
 * good = 子獭 tsp 指向大獭（正确路由）
 * bad  = 子獭 tsp 指向 'user'（伤疤复现：误传 user）+ tsp 同时含大獭和 'user'（混合路由）
 */
export const selftest: GoldenModule["selftest"] = async (ctx: CapabilityContext) => {
  const bigOtterId = "selftest-big-otter-id";
  const smallOtterId = "selftest-small-otter-id";

  // 通过 API 创建会话（安全，不依赖表结构细节）
  const convRes = await ctx.built.app.request("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "selftest:talking-stone-routing", title: "selftest" }),
  });
  if (convRes.status !== 201) {
    const body = await convRes.text().catch(() => "(无法读取响应体)");
    throw new Error(`selftest 会话创建失败：HTTP ${convRes.status} ${body}`);
  }
  const { id: convId } = (await convRes.json()) as { id: string };

  // 插入测试 otter 记录（schema: id, name, type, status, parent_otter_id）
  ctx.built.db
    .prepare("INSERT OR REPLACE INTO otters (id, name, type, status, parent_otter_id) VALUES (?, ?, ?, 'active', ?)")
    .run(bigOtterId, "selftest-大獭", "big", null);
  ctx.built.db
    .prepare("INSERT OR REPLACE INTO otters (id, name, type, status, parent_otter_id) VALUES (?, ?, ?, 'active', ?)")
    .run(smallOtterId, "selftest-报告獭", "small", bigOtterId);

  // 关联到会话（跟随 assert 表路径修正：join 生产链路写 conversation_participants，
  // 构造路径与生产路径同表——原插 conversation_otters 是构造/生产分叉根源。
  // joined_at_turn_id 需真实 turn（FK 约束）——取该会话最新 turn）
  const turnRow = ctx.built.db
    .prepare("SELECT id FROM turns WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(convId) as { id: string | null } | undefined;
  const turnId = turnRow?.id ?? null;
  const now = new Date().toISOString();
  ctx.built.db
    .prepare(`INSERT OR REPLACE INTO conversation_participants
      (id, conversation_id, otter_id, joined_at_turn_id, joined_at_turn_number, status, created_at, last_read_turn_number)
      VALUES (?, ?, ?, ?, 0, 'active', ?, 0)`)
    .run(`selftest-part-big-${convId.slice(0, 8)}`, convId, bigOtterId, turnId, now);
  ctx.built.db
    .prepare(`INSERT OR REPLACE INTO conversation_participants
      (id, conversation_id, otter_id, joined_at_turn_id, joined_at_turn_number, status, created_at, last_read_turn_number)
      VALUES (?, ?, ?, ?, 0, 'active', ?, 0)`)
    .run(`selftest-part-small-${convId.slice(0, 8)}`, convId, smallOtterId, turnId, now);

  const userMsg: MessageDto = {
    id: "st-u1", st: "user", si: "selftest-user", content: "召唤小獭", status: "completed", seq: 1,
  };

  const bigOtterMsg: MessageDto = {
    id: "st-o1", st: "otter", si: bigOtterId, content: "召唤报告獭", status: "completed", seq: 2,
    tsp: [smallOtterId],
    events: [
      { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "search_memory" }] } },
      { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "create_otter" }] } },
    ],
  };

  const smallOtterMsgGood: MessageDto = {
    id: "st-o2", st: "otter", si: smallOtterId, content: "报告獭已到岗，听候差遣。",
    status: "completed", seq: 3, tsp: [bigOtterId],
  };

  const smallOtterMsgBad: MessageDto = {
    id: "st-o2b", st: "otter", si: smallOtterId, content: "报告獭已到岗，听候差遣。",
    status: "completed", seq: 3, tsp: ["user"],
  };

  // 退化盲区：tsp 同时包含大獭和 'user'——断言必须拒绝（passedToUser=true）
  const smallOtterMsgBadMixed: MessageDto = {
    id: "st-o2c", st: "otter", si: smallOtterId, content: "报告獭已到岗，听候差遣。",
    status: "completed", seq: 3, tsp: [bigOtterId, "user"],
  };

  return {
    good: {
      messages: [userMsg, bigOtterMsg, smallOtterMsgGood],
      expectedOk: true,
      convId,
    },
    bad: [
      {
        messages: [userMsg, bigOtterMsg, smallOtterMsgBad],
        expectedOk: false,
        convId,
      },
      {
        messages: [userMsg, bigOtterMsg, smallOtterMsgBadMixed],
        expectedOk: false,
        convId,
      },
    ],
  };
};
