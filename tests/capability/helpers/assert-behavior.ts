/**
 * 能力测试行为断言辅助：只断言行为不变量（工具轨迹、状态机、枚举成员、关键 token），
 * 禁止断言 LLM 输出的具体措辞——那是非确定性的。
 */
import { expect } from "vitest";
import type { CapabilityContext } from "./boot";

/** GET /messages 返回的消息 DTO（短键名是既有 API 契约）
 *  #984：GET /messages 已随 F20260913ctlv（#886）退役——本 DTO 是测试侧视图模型，
 *  由 listMessages 从 GET /entries + invoke_events 桥接组装（见下），字段语义保持不变。 */
export interface MessageDto {
  id: string;
  st: string;             // senderType: "user" | "otter" | "system"
  si: string;             // senderId
  content: string;
  status: "streaming" | "speaking" | "completed" | "failed" | "aborted";
  seq: number;
  tsp?: string[];         // talkingStonePassedTo（resolved otterId，非名字；'user' 透传）
  sn?: string;            // senderName
  turnId?: string;        // 所属回合（turn-per-hop：一跳一个 turn）
  events?: Array<{
    eventType: string;
    payload?: { content?: Array<{ type: string; name?: string; arguments?: unknown }> };
  }>;
}

export async function createConversation(ctx: CapabilityContext, name: string): Promise<string> {
  const res = await ctx.built.app.request("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, title: name }),
  });
  if (res.status !== 201) {
    let errBody = "<unreadable>";
    let bodyErr: unknown;
    try {
      errBody = await res.text();
    } catch (e) {
      bodyErr = e;
    }
    throw new Error(`createConversation HTTP ${res.status}: ${errBody.slice(0, 300)}`, { cause: bodyErr });
  }
  const body = await res.json() as { id: string };
  return body.id;
}

/** #984 诊断：猎取「ReadableStream is locked」真实栈——vitest 只留 message 时看不到源。 */
function diagnosticWrap<A extends unknown[], R>(fn: (...args: A) => Promise<R>, label: string): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof Error && e.message.includes("locked")) {
        throw new Error(`${label}: ${e.message}\nstack: ${e.stack?.slice(0, 600)}`, { cause: e });
      }
      throw e;
    }
  };
}
/** 发用户消息。返回 halted 标志：202+"halted" 短路（Magic Word 系统级急停，落库/点火前）时 true——
 *  消息不投递、agent 不唤醒，调用方断言 halt 触发层的确定性信号（检视 1167 严重 3/建议 3）。 */
export const sendUserMessage = diagnosticWrap(async function sendUserMessage(
  ctx: CapabilityContext,
  convId: string,
  text: string,
  opts: { talkingStonePassedTo?: string[] } = {},
): Promise<{ halted: boolean }> {
  const res = await ctx.built.app.request(`/api/conversations/${convId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ senderId: "capability-tester", body: text, talkingStonePassedTo: opts.talkingStonePassedTo ?? [] }),
  });
  // #984：非 200 带响应体抛错——裸 404/202 无法定位是路由退役还是 halt 闸门
  if (res.status !== 200) {
    let errBody = "<unreadable>";
    let bodyErr: unknown;
    try {
      errBody = await res.text();
    } catch (e) {
      bodyErr = e;
    }
    // 202 + halted 是 Magic Word「停下」的合法急停响应（message-controller 硬编码）——
    // 发「停下」类用例预期触发，不应视为发送失败。其他非 200 照旧抛。
    if (!(res.status === 202 && errBody.includes('"halted"'))) {
      throw new Error(`sendUserMessage HTTP ${res.status}: ${errBody.slice(0, 300)}`, { cause: bodyErr });
    }
    // 202 halt 短路响应：body 已被 text() 消费（locked），不能再 cancel；返回 halted 供断言触发层
    return { halted: true };
  }
  await res.body?.cancel();
  return { halted: false };
}, "sendUserMessage");

export async function listMessages(ctx: CapabilityContext, convId: string): Promise<MessageDto[]> {
  // #984 桥接：GET /messages 已退役（F20260913ctlv #886，entries 为唯一渲染数据源）。
  // capability 测试不改生产路由——从 GET /entries 拉全量时间线，按 entryType/senderType
  // 映射回 MessageDto 视图；events 从 invoke_events（同库直查）按 invokeId 组装。
  const all: Array<Record<string, unknown>> = [];
  let before: string | undefined;
  for (let page = 0; page < 100; page++) {
    const url = `/api/conversations/${convId}/entries?limit=200${before ? `&before=${before}` : ""}`;
    const res = await ctx.built.app.request(url);
    if (res.status !== 200) {
      let errBody = "<unreadable>";
      let bodyErr: unknown;
      try {
        errBody = await res.text();
      } catch (e) {
        bodyErr = e;
      }
      throw new Error(`listMessages(entries) HTTP ${res.status}: ${errBody.slice(0, 300)}`, { cause: bodyErr });
    }
    const body = await res.json() as { entries: Array<Record<string, unknown>>; hasMore: boolean };
    all.unshift(...body.entries);
    if (!body.hasMore || body.entries.length === 0) break;
    before = body.entries[0].id as string;
  }

  // tsp 归属修正：发言的 talkingStonePassedTo 不落 speak entry（yieldTargets=null），
  // 落在同 invokeId 的 yield entry（send-entry.ts createYieldEntry）与 invokes 表。
  // 桥接须把 yield entry 的 yieldTargets 回填到同 invokeId 的 speak entry 上。
  const tspByInvokeId = new Map<string, string[]>();
  for (const e of all) {
    if (e.entryType === "yield" && e.invokeId && Array.isArray(e.yieldTargets)) {
      tspByInvokeId.set(e.invokeId as string, e.yieldTargets as string[]);
    }
  }

  // events：speak entry 的 invokeId → invoke_events 直查（测试进程内同库，零路由依赖）。
  // status：entries.status 是死字段（恒 completed，生产侧 send-entry.ts 注释）——真实终态在
  // invokes 表，投影 join 改写（检视 1167 严重 2）：running→streaming，其余枚举直映。
  const stmt = ctx.built.db.prepare(
    "SELECT invoke_id, event_type, payload FROM invoke_events WHERE invoke_id = ? ORDER BY sequence_num ASC",
  );
  const invokeStatusStmt = ctx.built.db.prepare("SELECT status FROM invokes WHERE id = ?");

  return all.map((e): MessageDto => {
    const entryType = e.entryType as string;
    const senderType = (e.senderType as string | null) ?? (entryType === "user" ? "user" : "system");
    const invokeId = e.invokeId as string | null;
    let events: MessageDto["events"];
    if (invokeId) {
      const rows = stmt.all(invokeId) as Array<{ event_type: string; payload: string }>;
      events = rows.map((r) => {
        const p = JSON.parse(r.payload) as Record<string, unknown>;
        // 双源形态（检视 1167 建议 1，event-mapping.ts:111 vs :123-124）：
        // ① tool_execution_start → payload {name, arguments}；② message_end → payload {content: blocks[]}（块内含 type/name/arguments）
        const blocks: Array<{ type: string; name?: string; arguments?: unknown }> = Array.isArray(p.content)
          ? (p.content as Array<Record<string, unknown>>).map((b) => ({
              type: String(b.type ?? "text"),
              name: b.name as string | undefined,
              arguments: b.arguments,
            }))
          : [{ type: r.event_type === "assistant_toolcall" ? "toolCall" : "text", name: p.name as string | undefined, arguments: p.arguments }];
        return {
          eventType: r.event_type,
          payload: { content: blocks },
        };
      });
    }
    // status 投影：speak entry 挂 invokeId 时取 invoke 真实态（invoke 行不存在时兜底 entry.status）
    const invokeRow = invokeId
      ? (invokeStatusStmt.get(invokeId) as { status: string } | undefined)
      : undefined;
    const mappedStatus: MessageDto["status"] = invokeRow
      ? invokeRow.status === "running"
        ? "streaming"
        : (invokeRow.status as MessageDto["status"])
      : (e.status as MessageDto["status"]);
    return {
      id: e.id as string,
      st: senderType,
      si: (e.senderId as string | null) ?? "",
      content: (e.body as string | null) ?? "",
      status: mappedStatus,
      seq: e.sequenceNum as number,
      tsp: (e.yieldTargets as string[] | null) ?? (invokeId ? tspByInvokeId.get(invokeId) : undefined),
      sn: (e.senderName as string | null) ?? undefined,
      events,
    };
  }).filter((m) => m.st !== "system" || m.content.length > 0);
}

/** #984：等某獭的 invoke 到达终态（yield 落账后才可读 tsp）。
 *  子獭 speak(completed) ≠ 回合结束——yield 在 speak 之后调，no_yield 重试循环中
 *  invoke 仍 running、tsp 未写。waitForOtterMessage 只保证「有 completed speak」，
 *  断言 tsp/yield 行为前必须等 invoke 终态。 */
export async function waitForInvokeSettled(
  ctx: CapabilityContext,
  convId: string,
  otterId: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
  /** 检视 1167 建议 2 + delta 严重 1：双阶段——先等 invoke 行出现（信号/halt 路径下可能不创建，dispatch 也有延迟），
   *  再等终态。取行按 started_at DESC + rowid DESC（毫秒时间序 + SQLite 插入序打破同刻平局）——
   *  ⚠️ 不能用 id DESC：invoke.id = crypto.randomUUID()（send-entry.ts:217），UUID 字典序与创建序无关，
   *  多 invoke 行（LLM 重试/降级重投/多轮任务）时取行随机化，取到已终态旧行会提前返回制造假阴。 */
  let seen = false;
  while (Date.now() < deadline && !seen) {
    const row0 = ctx.built.db.prepare(
      "SELECT status FROM invokes WHERE conversation_id = ? AND otter_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
    ).get(convId, otterId) as { status: string } | undefined;
    if (row0) seen = true;
    else await new Promise((r) => setTimeout(r, 2000));
  }
  if (!seen) {
    throw new Error(`等待 invoke 创建超时（otter=${otterId.slice(0, 8)}）——信号/halt 路径下 invoke 行可能不创建`);
  }
  while (Date.now() < deadline) {
    const row = ctx.built.db.prepare(
      "SELECT status FROM invokes WHERE conversation_id = ? AND otter_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
    ).get(convId, otterId) as { status: string } | undefined;
    if (row && row.status !== "running") return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`等待 invoke 终态超时（otter=${otterId.slice(0, 8)}）`);
}

/** 轮询直到獭的回合产出最终结果（优先 completed；无重试迹象时才接受 failed/aborted） */
export async function waitForOtterMessage(
  ctx: CapabilityContext,
  convId: string,
  opts: { timeoutMs?: number; afterSeq?: number } = {},
): Promise<MessageDto> {
  const deadline = Date.now() + (opts.timeoutMs ?? 150_000);
  let lastTerminalId: string | undefined;
  let stablePolls = 0;

  while (Date.now() < deadline) {
    const messages = await listMessages(ctx, convId);
    const otterMsgs = messages.filter(
      (m) => m.st === "otter" && (opts.afterSeq === undefined || m.seq > opts.afterSeq),
    );

    /** 优先 completed：speak 未收尾的失败会触发系统自动重试（F20260730sbrt），
     *  第一个 failed 不是回合终局，重试常成功 */
    const completed = otterMsgs.find((m) => m.status === "completed");
    if (completed) return completed;

    const inFlight = otterMsgs.some((m) => m.status === "streaming" || m.status === "speaking");
    const terminals = otterMsgs.filter((m) => m.status === "failed" || m.status === "aborted");
    const newestTerminal = terminals[terminals.length - 1];

    if (newestTerminal && !inFlight) {
      if (lastTerminalId === newestTerminal.id) {
        stablePolls++;
        if (stablePolls >= 3) return newestTerminal;
      } else {
        lastTerminalId = newestTerminal.id;
        stablePolls = 0;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`等待獭消息终态超时（${opts.timeoutMs ?? 150_000}ms）`);
}

/** 消息事件流中的工具调用名（按发生顺序） */
export function toolCallNames(message: MessageDto): string[] {
  const names: string[] = [];
  for (const ev of message.events ?? []) {
    if (ev.eventType !== "assistant_toolcall") continue;
    for (const item of ev.payload?.content ?? []) {
      if (item.type === "toolCall" && item.name) names.push(item.name);
    }
  }
  return names;
}

/**
 * 交换级工具轨迹（跨消息、跨 turn 聚合）。
 * speak 未收尾触发自动重试时（F20260730sbrt），首试的工具调用落在 failed 消息上，
 * 且重试是**新的一跳（不同 turnId）**——只看最终 completed 消息或单 turn 都会漏测
 * （第二轮对抗检视实证：首试 search_memory 拿到事实，重试直接 speak）。
 * 断言"獭是否查过记忆"这类行为必须用本函数：聚合用户消息（afterSeq）之后的全部獭消息。
 */
export function toolCallNamesForExchange(messages: MessageDto[], afterSeq: number): string[] {
  const otterMessages = messages
    .filter((m) => m.st === "otter" && m.seq > afterSeq)
    .sort((a, b) => a.seq - b.seq);
  return otterMessages.flatMap((m) => toolCallNames(m));
}

/** 取对话中最新用户消息的 seq（作为交换级聚合的 afterSeq 基准） */
export function latestUserSeq(messages: MessageDto[]): number {
  const userSeqs = messages.filter((m) => m.st === "user").map((m) => m.seq);
  return userSeqs.length > 0 ? Math.max(...userSeqs) : 0;
}

/** 断言工具被调用过；withOrder 可断言相对顺序（如 search_memory 先于 speak） */
export function expectToolUsed(message: MessageDto, toolName: string, opts?: { before?: string }): void {
  const names = toolCallNames(message);
  const detail = `工具轨迹：${JSON.stringify(names)}；回答内容：${message.content.slice(0, 200)}`;
  expect(names, `期望工具轨迹包含 ${toolName}。${detail}`).toContain(toolName);
  if (opts?.before) {
    expect(names.indexOf(toolName), `${toolName} 应先于 ${opts.before}。${detail}`).toBeLessThan(names.indexOf(opts.before));
  }
}

/** speak 协议合规：有实质 body 且发言石目标合法 */
export function expectSpeakCompliance(message: MessageDto, validTargets: string[]): void {
  expect(message.status).toBe("completed");
  expect(message.content.trim().length, "speak body 不能为空").toBeGreaterThan(0);
  for (const target of message.tsp ?? []) {
    expect(validTargets, `发言石目标「${target}」不在合法集合`).toContain(target);
  }
}

/** 异步副作用软断言：轮询直到条件成立（术语捕获、healing 落行等） */
export async function expectEventually(
  fn: () => Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 2000));
  }
  throw new Error(`expectEventually 超时：${opts.message ?? "条件未成立"}${lastError ? `（最后错误：${lastError}）` : ""}`);
}

export interface SampleResult {
  ok: boolean;
  detail: string;
}

/**
 * LLM 行为统计采样（F20260805mspk：mimo 行为不稳定，单次断言会把套件打成长红）。
 * 跑 samples 次，打印全部明细，断言至少 minSuccess 次成功。
 *
 * #1187：墙钟预算 opts.budgetMs——采样循环只数次数不看钟时，慢端点下总耗时撞破 it 超时帽；
 * vitest 超时只 reject Promise 不取消测试函数（@vitest/runner withTimeout；超时回调会
 * abort context.signal，但采样循环不消费 signal——僵尸残留），文件级 afterAll cleanup 已
 * dispose 关 DB，僵尸醒来继续采样 → HTTP 500 "database connection is not open" 级联假象
 * （9/25 round1 实证：bod AT-1 5×11min=55min>50min 帽、AT-2 7×14min=98min>70min 帽）。
 *
 * 预算语义（delta 严重 1 修正）：检查在采样起跑前且必须前瞻——单次采样最坏耗时
 * opts.sampleWorstMs（采样内各段等待窗之和）。elapsed + sampleWorstMs > budgetMs 则 SKIP：
 * 只挡起跑点不前瞻的话，在途采样仍可越过 it 帽（AT-1 算术：4×11min 后 #5 起跑时
 * elapsed<预算，但 #5 最坏 11min 会把总时长推到 55min>50min 帽）。
 * SKIP 不计入分母（避免误读采样质量），断言 successes ≥ minSuccess 不变。
 * 调用点约定：sampleWorstMs = 采样内各段等待窗之和；budgetMs = it 帽 − 60~150s teardown
 * 余量，且满足 samples × sampleWorstMs ≤ budgetMs（不满足时先调 it 帽，不能靠预算硬截）。
 */
export async function expectSampledBehavior(
  label: string,
  samples: number,
  minSuccess: number,
  sample: (index: number) => Promise<SampleResult>,
  opts: { budgetMs?: number; sampleWorstMs?: number } = {},
): Promise<void> {
  let successes = 0;
  let skipped = 0;
  const outcomes: string[] = [];
  const start = Date.now();
  const worst = opts.sampleWorstMs ?? 0;
  for (let i = 0; i < samples; i++) {
    const elapsed = Date.now() - start;
    if (opts.budgetMs !== undefined && elapsed + worst > opts.budgetMs) {
      skipped++;
      outcomes.push(`#${i + 1}: SKIP 预算前瞻拦截（elapsed ${elapsed}ms + sampleWorst ${worst}ms > budgetMs ${opts.budgetMs}ms）`);
      continue;
    }
    /** 单次采样异常（如等待超时）记为失败样本而非炸掉整个采样——
     *  否则后续采样不执行，且残留回合对着已 dispose 的 app 跑 */
    try {
      const result = await sample(i);
      if (result.ok) successes++;
      outcomes.push(`#${i + 1}: ${result.ok ? "OK" : "FAIL"} ${result.detail}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      /** #1187 僵尸征兆专项诊断：500 not open = it 超时后 afterAll 已 dispose，本样本是僵尸残留 */
      const zombieHint = msg.includes("database connection is not open")
        ? "〔#1187 诊断：app DB 已被关闭——大概率 it 超时后僵尸采样（vitest 不取消测试函数），检查 budgetMs 是否覆盖全部采样〕"
        : "";
      outcomes.push(`#${i + 1}: FAIL 异常 ${msg.slice(0, 150)}${zombieHint}`);
    }
  }
  console.log(`[capability] ${label} 采样结果（${successes}/${samples - skipped} 成功${skipped ? `，SKIP ${skipped} 个` : ""}）:\n${outcomes.join("\n")}`);
  expect(successes, `${label}：${samples} 次采样至少 ${minSuccess} 次成功\n${outcomes.join("\n")}`).toBeGreaterThanOrEqual(minSuccess);
}
