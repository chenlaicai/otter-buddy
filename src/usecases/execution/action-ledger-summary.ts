import type { ActionRecord } from "@entities/execution/action-record";
import type { RemoteActionRequest, RemoteActionStatus } from "@entities/execution/remote-action-request";

/**
 * PR-B：恢复摘要构造——把台账行折叠成恢复指令可内嵌的机器真相文本。
 *
 * 分层：pi-durable transcript 说「调用中断了」；台账说「磁盘上到底成了没」。
 * 摘要是两者的合成界面：succeeded 别重做 / interrupted 可安全重做 / unknown 禁止
 * 盲目重试先检查。只呈现事实，处置决策归獭。
 */

const STATUS_LABELS: Record<string, string> = {
  succeeded: "已完成（不要重做）",
  interrupted: "确认未完成（可安全重做）",
  unknown: "结果不明（禁止盲目重试，先检查现场再决定）",
  failed: "执行失败（可重做）",
  running: "仍在册（清扫漏网，按 unknown 对待——先检查）",
};

const MAX_ROWS = 20;

/** 按 status 严重度排序：unknown 最优先呈现（需人/獭检查），其余按时间序 */
const STATUS_ORDER: Array<ActionRecord["status"]> = ["unknown", "running", "interrupted", "failed", "succeeded"];

export function buildActionLedgerSummary(rows: ActionRecord[], maxRows = MAX_ROWS): string | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => {
    const rank = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    return rank !== 0 ? rank : a.startedAt.localeCompare(b.startedAt);
  });
  const shown = sorted.slice(0, maxRows);
  const lines = shown.map(row => {
    const label = STATUS_LABELS[row.status] ?? row.status;
    const target = row.target ?? "(无目标)";
    const detail = row.kind === "shell.exec" ? `命令 ${target}` : target;
    return `- [${row.status}] ${row.kind} ${detail} → ${label}`;
  });
  if (sorted.length > shown.length) {
    lines.push(`- ……另有 ${sorted.length - shown.length} 项动作（略）`);
  }
  const counts = STATUS_ORDER
    .map(status => `${status}×${sorted.filter(r => r.status === status).length}`)
    .filter(entry => !entry.endsWith("×0"))
    .join("、");
  return `机器台账（${counts}）：\n${lines.join("\n")}`;
}

// ─── F20261118remex（#1868 阶段 4 C2）：远程动作五态摘要（R2 闭环）───
// 数据源 remote_action_requests（中枢侧回执投影）：远程动作在恢复链可见可裁决，
// 不再因数据源断裂退化为旧文案。connector 台账仍是机器侧真相源（端上核对用）。

const REMOTE_STATUS_LABELS: Record<RemoteActionStatus, string> = {
  requested: "在途（回执未达——按 unknown 对待，先检查）",
  succeeded: "已完成（不要重做）",
  failed: "执行失败（可重做）",
  interrupted: "确认中断（可安全重做）",
  unknown: "结果不明（禁止盲目重试，先检查现场再决定）",
};

/** 严重度排序：unknown/requested 最优先（需检查），其余按时间序 */
const REMOTE_STATUS_ORDER: RemoteActionStatus[] = ["unknown", "requested", "interrupted", "failed", "succeeded"];

export function buildRemoteActionSummary(rows: RemoteActionRequest[], maxRows = MAX_ROWS): string | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => {
    const rank = REMOTE_STATUS_ORDER.indexOf(a.status) - REMOTE_STATUS_ORDER.indexOf(b.status);
    return rank !== 0 ? rank : a.createdAt.localeCompare(b.createdAt);
  });
  const shown = sorted.slice(0, maxRows);
  const lines = shown.map(row => {
    const label = REMOTE_STATUS_LABELS[row.status];
    const detail = row.error ? `（${row.error.slice(0, 80)}）` : "";
    return `- [${row.status}] ${row.actionType} @${row.deviceId} → ${label}${detail}`;
  });
  if (sorted.length > shown.length) {
    lines.push(`- ……另有 ${String(sorted.length - shown.length)} 项远程动作（略）`);
  }
  const counts = REMOTE_STATUS_ORDER
    .map(status => `${status}×${sorted.filter(r => r.status === status).length}`)
    .filter(entry => !entry.endsWith("×0"))
    .join("、");
  return `远程动作（${counts}）：\n${lines.join("\n")}`;
}
