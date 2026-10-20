/**
 * 獭调度适配（方案模块三）——轮到獭时经 SdkInvokePort.invoke **直调**唤醒决策。
 * ⚠️ 不走 AgentInvoker 对话链（S1/S2 处置定死：对话链灌 entry 会污染牌局时间线）。
 *
 * 决策唤醒协议（方案口径）：快照（**不含他家手牌**）+ 合法操作集 → 要求回复
 * `{"action": <动作对象或合法集序号>, "speech": "一句桌上发言"}`（speech 必填，与 prompt 口径一致——空串/纯空白视同未提供，不进事件）。
 * - 解析容错：从回复中抽取第一个平衡 JSON 对象（含 ```json 围栏）；action 为序号或对象均可
 * - 非法/不可解析 → 携错误反馈重试 1 次；仍失败 → 规则代理兜底（fallbackReason 留痕）
 * - 端口异常/超时 → 同样走重试与兜底
 *
 * 锁与超时：invoke 前 acquireSessionLock（可选方法，缺省降级）串行化；超时默认 90s
 * （獭思考 3-10s 为目标，超时留给长尾；超时后交代理保证牌局不悬挂）。
 */

import type { SdkInvokePort } from "../../ports/sdk-invoke-port";
import type { Tile } from "../../../entities/mahjong/tile";
import { isTrivialDecision, proxyChooseAction } from "../engine/proxy";
import { notation, type SanmaEngine } from "../engine/engine";
import type { DecisionPoint, EngineAction, Seat } from "../engine/types";

/** 唤醒通道抽象（测试注入 mock；生产 = SdkOtterGateway） */
export interface OtterGateway {
  invoke(otterId: string, message: string): Promise<string>;
}

class WakeTimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WakeTimeoutError(`${label} timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** 生产网关：SDK 直调 + 超时。
 * 口径修正（方案 delta，实现期发现）：**不再外层调 acquireSessionLock**——
 * PiSessionFactory.invoke() 内部已取同键 per-otter 锁（pi-session-factory.ts:712/:690
 * 同 `session:${otterId}`），外层再取同键锁 = 嵌套同键等待 → 每次唤醒悬挂至超时。
 * 串行化由端口 invoke 自带锁保证；方案「Invoke前调 acquireSessionLock」系对端口
 * 签名的字面理解，与实现矛盾——此处以实现为准，留痕供审视。
 * conversationId 可选：缺省 = 不带 options（纯 session 直调，不落对话 entry——S1/S2 口径）。 */
export class SdkOtterGateway implements OtterGateway {
  constructor(
    private readonly port: SdkInvokePort,
    private readonly conversationId?: string,
    private readonly timeoutMs = 90_000,
  ) {}

  async invoke(otterId: string, message: string): Promise<string> {
    const options = this.conversationId ? { conversationId: this.conversationId } : undefined;
    const run = this.port.invoke(otterId, message, options);
    const res = await withTimeout(run, this.timeoutMs, otterId);
    return res.text;
  }
}

// ─────────────────────────── 唤醒 prompt ───────────────────────────

function fmtTileList(tiles: readonly Tile[]): string {
  return tiles.map(notation).join(" ");
}

function seatWindLabel(engine: SanmaEngine, seat: Seat): string {
  return engine.seatWind(seat);
}

/**
 * 构造决策唤醒 prompt：公开局面 + 自己手牌 + 合法操作集（序号索引）。
 * 快照**不含他家手牌**（仅公开面：河/副露/拔北/点数/立直状态）。
 */
// eslint-disable-next-line max-statements -- 唤醒 prompt 逐段拼接（场况/三家公开面/手牌/动作表/错误反馈），拆段需跨闭包传递拼接器状态，失可读
export function buildWakePrompt(engine: SanmaEngine, dp: DecisionPoint, feedback?: string): string {
  const r = engine.state.round;
  if (!r) throw new Error("round not active");
  const me = r.players[dp.seat];
  const lines: string[] = [];
  lines.push("# 三麻牌局决策请求（东风战）");
  lines.push(
    `场况：东${r.roundNo}局 本场${r.honba} 供托${r.sticks} 牌山余${r.wall.tiles.length - r.wall.drawIdx}枚 ` +
      `宝牌指示：${fmtTileList(r.wall.deadWall.slice(4, 4 + r.wall.doraRevealed))}`,
  );
  lines.push(`你是 ${dp.seat} 号位（${seatWindLabel(engine, dp.seat)}家），现有 ${me.points} 点。`);
  lines.push("三家公开信息：");
  for (const p of r.players) {
    const melds = p.melds.map((m) => `${m.type}[${m.tiles.map(notation).join(" ")}${p.discards.length && m.from ? ` 来源${m.from}` : ""}]`).join(" ");
    const riichi = p.riichi ? ` 立直(第${p.riichiTurn}打${p.ippatsu ? "，一发中" : ""})` : "";
    const kita = p.kitaTiles.length > 0 ? ` 拔北×${p.kitaTiles.length}` : "";
    lines.push(
      `  ${p.seat}号 ${p.name}（${p.points}点）${riichi}${kita} 河：${fmtTileList(p.discards)}` +
        (melds ? ` 副露：${melds}` : ""),
    );
  }
  lines.push(`你的手牌：${fmtTileList(me.hand)}${me.melds.length ? `（副露 ${me.melds.length} 组）` : ""}`);
  if (dp.kind === "turn") {
    lines.push(`轮到你打牌。${dp.drawn ? `刚摸到：${dp.drawn}。` : "（副露后直接打牌）"}`);
  } else if (dp.claim) {
    lines.push(`${dp.claim.discardSeat} 号位打出 ${dp.claim.discardTile}——请选择是否和/碰/杠（或过）。`);
  }
  lines.push("");
  lines.push("合法操作（只能选一个，action 必须逐字使用下列对象或其序号）：");
  dp.actions.forEach((a, i) => {
    lines.push(`  ${i}. ${JSON.stringify(a)}`);
  });
  if (feedback) {
    lines.push("");
    lines.push(`上次回复不可用：${feedback}`);
  }
  lines.push("");
  lines.push(
    '只回复一个 JSON 对象（可含 ```json 围栏），形如 {"action": 0, "speech": "一句桌上发言"}；' +
      "speech 必填——像牌桌上的真人一样带一句简短人味发言（吐槽/评牌/报听/情绪/垃圾话均可，≤30字，别报数字流水账）。",
  );
  return lines.join("\n");
}

// ─────────────────────────── 回复解析 ───────────────────────────

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1)) as unknown;
          // eslint-disable-next-line max-depth -- 单趟扫描内嵌容错解析：结构为扫描层→解析层→类型守卫层，拆出则需回传游标与片段状态
          if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function sameAction(a: EngineAction, b: EngineAction): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "discard" && b.type === "discard") {
    return a.tile === b.tile && (a.riichi === true) === (b.riichi === true);
  }
  if (a.type === "ankan" && b.type === "ankan") return a.kind === b.kind;
  if (a.type === "kakan" && b.type === "kakan") return a.tile === b.tile;
  return true;
}

export type ParseResult =
  | { ok: true; action: EngineAction; speech?: string }
  | { ok: false; error: string };

/** 解析獭回复 → 合法集内动作（序号/对象/裸动作对象三种形态，容错） */
// eslint-disable-next-line complexity -- 三种回复形态分派（序号/包装对象/裸动作）+ 越界与非法双校验，分支即回复契约条目
export function parseActionReply(text: string, legal: readonly EngineAction[]): ParseResult {
  const obj = extractJson(text);
  if (!obj) return { ok: false, error: "回复中未找到 JSON 对象" };
  // 空串/纯空白 speech 视同未提供（检视建议7：不携带空串进事件，防前端判空歧义）
  const rawSpeech = typeof obj.speech === "string" ? (obj.speech as string) : undefined;
  const speech = rawSpeech !== undefined && rawSpeech.trim() !== "" ? rawSpeech : undefined;
  let candidate: unknown = obj.action;
  if (typeof candidate === "number") {
    if (!Number.isInteger(candidate) || candidate < 0 || candidate >= legal.length) {
      return { ok: false, error: `action 序号越界：${candidate}（合法 0..${legal.length - 1}）` };
    }
    candidate = legal[candidate];
  } else if (candidate === undefined && typeof obj.type === "string") {
    candidate = obj; // 裸动作对象形态（省略 action 包装）
  }
  if (!candidate || typeof candidate !== "object" || !("type" in (candidate as object))) {
    return { ok: false, error: "缺少 action 字段（序号或动作对象）" };
  }
  const action = candidate as EngineAction;
  const hit = legal.find((a) => sameAction(a, action));
  if (!hit) return { ok: false, error: `动作不在合法集：${JSON.stringify(action)}` };
  return speech !== undefined ? { ok: true, action: hit, speech } : { ok: true, action: hit };
}

// ─────────────────────────── 唤醒主流程 ───────────────────────────

export interface WakeDeps {
  gateway: OtterGateway;
  engine: SanmaEngine;
  /** 兜底动作来源（默认规则代理） */
  fallback?: (engine: SanmaEngine, dp: DecisionPoint) => EngineAction;
}

export interface WakeResult {
  action: EngineAction;
  via: "otter" | "fallback";
  speech?: string;
  fallbackReason?: string;
  attempts: number;
}

/**
 * 唤醒獭决策：失败（解析/非法/超时/异常）重试 1 次，仍败走规则代理兜底。
 * 节流阀：无决策量回合（trivial）由 RoomService 判定后直接走代理，不进入本函数。
 */
export async function wakeOtterForDecision(
  deps: WakeDeps,
  dp: DecisionPoint,
  maxAttempts = 2,
): Promise<WakeResult> {
  const { gateway, engine } = deps;
  const fallback = deps.fallback ?? proxyChooseAction;
  const r = engine.state.round;
  if (!r) throw new Error("round not active");
  const otterId = r.players[dp.seat].otterId;
  if (!otterId) throw new Error(`seat ${dp.seat} is not an otter player`);

  let feedback: string | undefined;
  let attempts = 0;
  for (let i = 1; i <= maxAttempts; i++) {
    attempts = i;
    const prompt = buildWakePrompt(engine, dp, feedback);
    let text: string;
    try {
      text = await gateway.invoke(otterId, prompt);
    } catch (e) {
      feedback = e instanceof Error ? e.message : String(e);
      continue;
    }
    const parsed = parseActionReply(text, dp.actions);
    if (parsed.ok) {
      return parsed.speech !== undefined
        ? { action: parsed.action, via: "otter", speech: parsed.speech, attempts }
        : { action: parsed.action, via: "otter", attempts };
    }
    feedback = parsed.error;
  }
  return {
    action: fallback(engine, dp),
    via: "fallback",
    fallbackReason: feedback ?? "unknown",
    attempts,
  };
}

/** 节流阀直通：trivial 回合不唤醒（RoomService 在调唤醒前先问本函数） */
export function shouldSkipWake(engine: SanmaEngine, dp: DecisionPoint): boolean {
  return isTrivialDecision(engine, dp);
}

// ─────────────────── 真人回话注入 prompt（下局开局，独立 user 消息） ───────────────────

/** 围栏提示：注入消息只求一句自然回应，不要求动作/工具——回复文本不回传对局（仅入 session 上下文） */
export function buildChatInjectionPrompt(
  msgs: ReadonlyArray<{ seat: Seat; name: string; text: string }>,
  roundNo: number,
): string {
  const lines: string[] = [];
  lines.push(`# 牌桌聊天（东${roundNo}局开局注入）`);
  lines.push("上一局打牌期间，牌桌上有人对你说了：");
  for (const m of msgs) {
    lines.push(`  [${m.seat}号位 ${m.name}] ${m.text}`);
  }
  lines.push("");
  lines.push("请只回复一句话自然接话（不要调用工具、不要输出 JSON）。随后你会收到本局的牌局决策请求。");
  return lines.join("\n");
}
