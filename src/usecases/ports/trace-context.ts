/**
 * TraceContext — 链级追踪上下文（F20260814mtrc）
 *
 * 基于 AsyncLocalStorage 的轻量 trace：一次用户消息触发的完整发言链（多 hop、多 otter、
 * 可能重试）共享同一 traceId，全链路日志自动携带，日志↔metrics 可按时间轴对齐。
 *
 * 设计要点：
 * - 放 ports 层：usecases（DispatchChainEngine/AgentInvoker）与 frameworks（PinoLogger）
 *   都要消费；frameworks→usecases 方向合法，反向不行。
 * - defined-only merge：子 scope 只覆盖显式传入的字段，父 scope 的 traceId 自动保留。
 * - 字段基数固定（traceId/messageId/source），不携带业务对象。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export interface TraceContext {
  /** 发言链级：一次用户消息 → 完整多 hop 链 */
  traceId?: string;
  /** invoke 级：当前 streaming 消息 */
  messageId?: string;
  /** 入口来源："chain"（DispatchChainEngine）| "direct"（scheduler/手动重试直连） */
  source?: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

/** 生成链级 traceId：t_ + 12 位随机 hex */
export function newTraceId(): string {
  return `t_${randomBytes(6).toString("hex")}`;
}

/** 在 trace scope 内执行 fn；patch 的已定义字段覆盖父 scope，未定义字段继承 */
export async function runWithTrace<T>(patch: TraceContext, fn: () => Promise<T>): Promise<T> {
  const parent = storage.getStore() ?? {};
  const merged: TraceContext = { ...parent };
  for (const key of Object.keys(patch) as Array<keyof TraceContext>) {
    const value = patch[key];
    if (value !== undefined) merged[key] = value;
  }
  return storage.run(merged, fn);
}

/** 读取当前 trace scope（无 scope 时返回空对象；字段可能部分存在） */
export function getTraceContext(): TraceContext {
  return storage.getStore() ?? {};
}

/** 仅取日志富化字段（PinoLogger 用；显式 context 优先于这些字段） */
export function traceLogFields(): Pick<TraceContext, "traceId" | "messageId"> {
  const ctx = storage.getStore();
  if (!ctx) return {};
  const fields: Pick<TraceContext, "traceId" | "messageId"> = {};
  if (ctx.traceId !== undefined) fields.traceId = ctx.traceId;
  if (ctx.messageId !== undefined) fields.messageId = ctx.messageId;
  return fields;
}
