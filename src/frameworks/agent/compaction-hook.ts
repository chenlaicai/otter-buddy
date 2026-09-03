/**
 * F20260903cmpk：session_before_compact 钩子——用七段叙事替换 Pi 默认压缩摘要。
 *
 * 架构定位（supersedes F20260825hndf 双机制设计）：
 * - 时机归 Pi：threshold/overflow 检查（每次 LLM 响应前）不变
 * - 算法归咱们：钩子返回自定义 CompactionResult（七段合成 + 四件套拼入）
 * - 降级：合成失败/超时 → 返回 undefined → Pi 默认算法兜底，压缩链路不断
 *
 * 分流策略（搭档拍板）：
 * - threshold：替换（87% 触发的就是咱们的七段，不再有"通用 8 段式抢跑"）
 * - overflow：放行 Pi 默认（真溢出救急，走 SDK 内置 retry 链路，不在钩子里赌合成速度）
 * - manual：放行 Pi 默认（人为 /compact 尊重默认行为）
 */

/** 合成超时：压缩期间主循环在等，超时后放 Pi 默认兜底（#767 同款防线思想） */
export const COMPACTION_SYNTHESIS_TIMEOUT_MS = 60_000;

/** CompactionPreparation 最小形状（SDK 未导出该类型，用结构兼容替代） */
export interface CompactionPreparationLike {
  firstKeptEntryId: string;
  messagesToSummarize: Array<{ role: string; content?: unknown }>;
  turnPrefixMessages: Array<{ role: string; content?: unknown }>;
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
}

/** 钩子依赖（由 pi-session-factory 在创建 session 时注入，避免 registry 反向依赖高层模块） */
export interface CompactionHookDeps {
  /** 七段叙事合成（readOnly LLM invocation；同 handoff 的 synthesize） */
  synthesize: (prompt: string) => Promise<string>;
  /** 拿不到合成函数（如 registry 未注入 deps）时仅记录 */
  logger?: { info(msg: string, ctx?: unknown): void; warn(msg: string, ctx?: unknown): void };
}

/** 七段合成 prompt 构建（最小依赖：只有 preparation 摘要源 + 上一代摘要） */
export function buildCompactionSynthesisPrompt(
  preparation: CompactionPreparationLike,
  otterName: string,
): string {
  const lines: string[] = [];

  lines.push('## 会话摘要（LLM 叙事合成——由 Pi 压缩钩子触发，七段模板）');
  lines.push('');
  lines.push(`meta: ${otterName} | 触发: Pi compaction (${preparation.tokensBefore} tokens)`);
  lines.push('');
  lines.push('以下是即将被压缩丢弃的对话历史。请按七段模板写摘要：');
  lines.push('');

  if (preparation.previousSummary) {
    lines.push('<previous-summary>');
    lines.push(preparation.previousSummary);
    lines.push('</previous-summary>');
    lines.push('');
    lines.push('上一代摘要在上方——保留其中仍有效的信息（谱系行必须逐代追加，不得重置），合并本次新进展。');
    lines.push('');
  }

  appendSerializedConversation(lines, preparation);
  lines.push('');
  appendTemplateRules(lines);

  return lines.join('\n');
}

/** 历史序列化（拆出以控 max-statements）：主历史全量 + split-turn 前缀 */
function appendSerializedConversation(lines: string[], preparation: CompactionPreparationLike): void {
  lines.push('<conversation-to-summarize>');
  for (const msg of preparation.messagesToSummarize) {
    const r = role(msg);
    const text = extractText(msg);
    if (text) lines.push(`[${r}] ${text.slice(0, 2000)}`);
  }
  for (const msg of preparation.turnPrefixMessages) {
    const text = extractText(msg);
    if (text) lines.push(`[本轮前缀/${role(msg)}] ${text.slice(0, 1000)}`);
  }
  lines.push('</conversation-to-summarize>');
}

/** 七段模板规则段（拆出以控 max-statements） */
function appendTemplateRules(lines: string[]): void {
  lines.push('七段模板：①下一步（立即动作+阻塞于）②当前任务与完成标准（引搭档原话）③关键决策与理由（含已排除路径）④产物与锚点（PR#/F文档ID/memory entry）⑤协作状态（在场成员/悬置yield/进行中小獭）⑥搭档上下文（最近指令原话引用）⑦交接谱系（每代一行追加）。');
  lines.push('硬约束：预算≤1200 token；锚点优于复制；「为什么这么定」和「什么试过不行」必须保留。');
}

function role(msg: { role: string }): string {
  return msg.role === "assistant" ? "海獭" : "搭档";
}

function extractText(msg: { role: string; content?: unknown }): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b): b is { type: string; text?: string } => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
      .map(b => b.text ?? '')
      .join('\n');
  }
  return '';
}

/**
 * session_before_compact handler 本体（纯函数，可独立测试）。
 *
 * 返回 undefined = 放行 Pi 默认算法（overflow/manual 分流 + 合成失败/超时降级都走这里）。
 */
export async function handleSessionBeforeCompact(
  event: { reason: "manual" | "threshold" | "overflow"; preparation: CompactionPreparationLike },
  deps: CompactionHookDeps | null,
  otterName: string,
  timeoutMs: number = COMPACTION_SYNTHESIS_TIMEOUT_MS,
): Promise<{ compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number } } | undefined> {
  // 分流：threshold 才替换，overflow/manual 放行 Pi 默认
  if (event.reason !== "threshold") return undefined;
  if (!deps) return undefined;

  const { synthesize, logger } = deps;
  const prompt = buildCompactionSynthesisPrompt(event.preparation, otterName);

  try {
    const summary = await Promise.race([
      synthesize(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Compaction synthesis timeout")), timeoutMs),
      ),
    ]);

    if (!summary || summary.trim().length === 0) {
      logger?.warn("[compaction-hook] synthesis returned empty, falling back to Pi default", {});
      return undefined;
    }

    logger?.info("[compaction-hook] custom synthesis adopted", { tokensBefore: event.preparation.tokensBefore, length: summary.length });
    return {
      compaction: {
        summary: summary.trim(),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  } catch (err) {
    logger?.warn("[compaction-hook] synthesis failed, falling back to Pi default", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
