/**
 * 能力测试行为断言辅助：只断言行为不变量（工具轨迹、状态机、枚举成员、关键 token），
 * 禁止断言 LLM 输出的具体措辞——那是非确定性的。
 */
import { expect } from "vitest";
import type { CapabilityContext } from "./boot";

/** GET /messages 返回的消息 DTO（短键名是既有 API 契约） */
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
  expect(res.status).toBe(201);
  const body = await res.json() as { id: string };
  return body.id;
}

/** 发用户消息。响应是 SSE 流（agent 异步跑），取消流后走轮询断言终态。 */
export async function sendUserMessage(
  ctx: CapabilityContext,
  convId: string,
  text: string,
  opts: { talkingStonePassedTo?: string[] } = {},
): Promise<void> {
  const res = await ctx.built.app.request(`/api/conversations/${convId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ senderId: "capability-tester", body: text, talkingStonePassedTo: opts.talkingStonePassedTo ?? [] }),
  });
  expect(res.status).toBe(200);
  await res.body?.cancel();
}

export async function listMessages(ctx: CapabilityContext, convId: string): Promise<MessageDto[]> {
  const res = await ctx.built.app.request(`/api/conversations/${convId}/messages`);
  expect(res.status).toBe(200);
  const body = await res.json() as { messages: MessageDto[] };
  return body.messages;
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
 */
export async function expectSampledBehavior(
  label: string,
  samples: number,
  minSuccess: number,
  sample: (index: number) => Promise<SampleResult>,
): Promise<void> {
  let successes = 0;
  const outcomes: string[] = [];
  for (let i = 0; i < samples; i++) {
    /** 单次采样异常（如等待超时）记为失败样本而非炸掉整个采样——
     *  否则后续采样不执行，且残留回合对着已 dispose 的 app 跑 */
    try {
      const result = await sample(i);
      if (result.ok) successes++;
      outcomes.push(`#${i + 1}: ${result.ok ? "OK" : "FAIL"} ${result.detail}`);
    } catch (err) {
      outcomes.push(`#${i + 1}: FAIL 异常 ${err instanceof Error ? err.message.slice(0, 150) : String(err)}`);
    }
  }
  console.log(`[capability] ${label} 采样结果（${successes}/${samples} 成功）:\n${outcomes.join("\n")}`);
  expect(successes, `${label}：${samples} 次采样至少 ${minSuccess} 次成功\n${outcomes.join("\n")}`).toBeGreaterThanOrEqual(minSuccess);
}
