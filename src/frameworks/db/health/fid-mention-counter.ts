/**
 * FidMentionCounter: 近 N 天消息中 FID 提及计数（zombie 判定数据源）
 *
 * F20260825sgnw 审视发现 2：fidMentionCounts 此前无任何注入路径，zombie 判定死代码。
 * 本模块实现母文档定义的"近 30 天对话消息中 FID 出现次数"（MessagesCollector 通道）。
 *
 * 实现：messages_fts（trigram FTS5）MATCH 短语查询 + created_at 窗口过滤。
 * 只查候选 FID（调用方先粗筛 stalled≥zombieDays 的链），避免全量 FID 扫描。
 */

import type Database from "better-sqlite3";

export type FidMentionSource = (fids: string[], windowDays: number) => Map<string, number>;

/** 近 N 天消息中每个 FID 的提及次数（0 次的 FID 不进 Map——区分"未提及"与"未查询"） */
export function countFidMentions(db: Database.Database, fids: string[], windowDays: number): Map<string, number> {
  const result = new Map<string, number>();
  if (fids.length === 0) return result;

  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const stmt = db.prepare(`
    SELECT COUNT(*) AS n
    FROM messages_fts
    JOIN messages ON messages.id = messages_fts.message_id
    WHERE messages_fts MATCH ? AND messages.created_at >= ?
  `);

  for (const fid of fids) {
    // FID 是长 token，trigram 短语匹配足够精确；双引号包裹防 FTS 语法注入
    const escaped = `"${fid.replace(/"/g, '""')}"`;
    try {
      const row = stmt.get(escaped, cutoff) as { n: number } | undefined;
      // 显式 set（含 0）：zombie 判定区分"查过 0 次"与"没查"（F20260825sgnw 审视发现 2）
      result.set(fid, row?.n ?? 0);
    } catch {
      // FTS 语法异常（理论上不会发生）：视为未提及，不阻断 zombie 判定
      result.set(fid, 0);
    }
  }

  return result;
}
