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

  /** 发现 2 修复：按 conversation_id 过滤（JOIN conversation_otters），避免多轮采样
   *  共享 DB 时命中前轮/历史残留子獭。源测试用 ottersBefore diff，golden 用会话隔离。 */
  const smallOtter = ctx.built.db
    .prepare(
      `SELECT o.id, o.name, o.type, o.parent_otter_id FROM otters o
       JOIN conversation_otters co ON co.otter_id = o.id
       WHERE co.conversation_id = ? AND o.type = 'small'
       ORDER BY o.rowid DESC LIMIT 1`,
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
