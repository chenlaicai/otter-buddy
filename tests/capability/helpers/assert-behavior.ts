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
  tsp?: string[];         // talkingStonePassedTo（名字）
  sn?: string;            // senderName
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
export async function sendUserMessage(ctx: CapabilityContext, convId: string, text: string): Promise<void> {
  const res = await ctx.built.app.request(`/api/conversations/${convId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ senderId: "capability-tester", body: text }),
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
