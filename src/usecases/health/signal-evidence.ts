/**
 * 复发模式卡序列化（Issue #647 项 1：复发卡的数据消费层）
 *
 * 数据源 = bug_recurrence 信号的 evidence_detail（#650 落的全类型 commit 序列）。
 * 频次徽章从 commits.length 派生——严禁用 occurrences（那是扫描触发次数，
 * 随扫描频率漂移，合议明令；每扫一次 +1 而时间轴节点不增）。
 */

import type { SignalRecord } from "./signal-repository";

export interface RecurrenceCardDTO {
  signalId: number;
  signalType: string;
  signalTypeLabel: string;
  severity: string;
  filePath: string | null;
  featureId: string | null;
  evidence: string;
  suggestedAction: string | null;
  lastSeen: string;
  /** 复现 detail.commits（全类型序列，bug●→fix● 交替时间轴数据源） */
  commits: Array<{ sha: string; date: string; changeType: string | null; message: string }>;
  /** 频次徽章：从序列长度派生（非 occurrences——见文件头 Why） */
  commitCount: number;
  windowDays: number | null;
}

export function serializeRecurrenceCards(open: SignalRecord[], labelOf: (type: string) => string): RecurrenceCardDTO[] {
  const cards: RecurrenceCardDTO[] = [];
  for (const s of open) {
    if (s.signal_type !== "bug_recurrence") continue;
    const detail = parseDetail(s.evidence_detail);
    if (!detail) continue;
    cards.push({
      signalId: s.id,
      signalType: s.signal_type,
      signalTypeLabel: labelOf(s.signal_type),
      severity: s.severity,
      filePath: s.file_path,
      featureId: s.feature_id,
      evidence: s.evidence,
      suggestedAction: s.suggested_action,
      lastSeen: s.last_seen,
      commits: detail.commits,
      commitCount: detail.commits.length,
      windowDays: detail.windowDays ?? null,
    });
  }
  // 复发模式卡排序（观澜 3.1）：频次优先（修复密度高=最热），其次最近复发时间
  cards.sort((a, b) => b.commitCount - a.commitCount || b.lastSeen.localeCompare(a.lastSeen));
  return cards;
}

function parseDetail(raw: string | null): { commits: RecurrenceCardDTO["commits"]; windowDays: number | null } | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as { kind?: string; commits?: RecurrenceCardDTO["commits"]; windowDays?: number };
    if (d.kind !== "bug_recurrence_commits" || !Array.isArray(d.commits)) return null;
    return { commits: detailStaging(d.commits), windowDays: d.windowDays ?? null };
  } catch {
    return null;
  }
}

/** 同 rhi-controller.signals：按时间升序重排 + sha 去重（防窗口滑动残留重复节点致徽章虚高） */
function detailStaging(commits: RecurrenceCardDTO["commits"]): RecurrenceCardDTO["commits"] {
  const seen = new Set<string>();
  return commits
    .filter(c => (seen.has(c.sha) ? false : (seen.add(c.sha), true)))
    .sort((a, b) => a.date.localeCompare(b.date));
}
