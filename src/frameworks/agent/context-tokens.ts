/**
 * 上下文窗口占用计算（F20260808ctxw）。
 *
 * 口径：末次有效 assistant 消息的 usage（input+output+cacheRead+cacheWrite），
 * 与 SDK compaction 判定（calculateContextTokens）同公式。
 *
 * compaction 边界与 SDK getContextUsage() 同语义：threshold compaction 触发当轮，
 * branch 里末条 assistant usage 仍是压缩前的值，此时真实窗口已被压缩——
 * 压缩后无有效 assistant usage 时返回 undefined（该轮不落 ctx），不显示过期峰值。
 */

import { calculateContextTokens, getLastAssistantUsage, getLatestCompactionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** 与 SDK getAssistantUsage 同规则：跳过 aborted/error/全零 usage */
function validAssistantUsage(entry: SessionEntry): number | undefined {
  if (entry.type !== "message") return undefined;
  const msg = entry.message;
  if (msg.role !== "assistant") return undefined;
  const assistant = msg as { stopReason?: string; usage?: Parameters<typeof calculateContextTokens>[0] };
  if (assistant.stopReason === "aborted" || assistant.stopReason === "error" || !assistant.usage) return undefined;
  const tokens = calculateContextTokens(assistant.usage);
  return tokens > 0 ? tokens : undefined;
}

/** 窗口占用 token 数；未知（无有效 usage / compaction 后无新 usage）时返回 undefined */
export function getContextWindowTokens(entries: SessionEntry[]): number | undefined {
  const latestCompaction = getLatestCompactionEntry(entries);
  if (latestCompaction) {
    /** 只信压缩点之后的 usage；压缩点之前的反映的是压缩前窗口 */
    const compactionIndex = entries.lastIndexOf(latestCompaction);
    for (let i = entries.length - 1; i > compactionIndex; i--) {
      const tokens = validAssistantUsage(entries[i]);
      if (tokens !== undefined) return tokens;
    }
    return undefined;
  }
  const lastUsage = getLastAssistantUsage(entries);
  return lastUsage ? calculateContextTokens(lastUsage) : undefined;
}

/**
 * 末条 assistant 消息的 stopReason（F20260903lngth）。
 * 与 validAssistantUsage 的过滤规则互补：validAssistantUsage 跳过 aborted/error，
 * 本函数不过滤——截断（length）信号恰恰需要从"看起来成功"的响应里暴露出来。
 * 取自最后一条含 stopReason 的 assistant 消息（含 usage 为零的边缘情形）。
 */
export function getLastStopReason(entries: SessionEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "assistant") continue;
    const assistant = msg as { stopReason?: string };
    if (typeof assistant.stopReason === "string") return assistant.stopReason;
  }
  return undefined;
}
