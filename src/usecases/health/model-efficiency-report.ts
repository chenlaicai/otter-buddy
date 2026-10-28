/**
 * F20261027hwl1：模型效率报告——真实 provider+model × 日/周/月 token 总量 + KV cache 率。
 *
 * 数据源：health_snapshots 的 cost_output 行（日级原始量，provider 进 metadata）。
 * 周/月从日级原始量重汇总（SUM 四分量后算率），绝不平均每日百分比。
 * 每格：totalTokens 主数字；cacheHitRate = cacheRead / (input + cacheRead)——
 * 零分母返回 null（UI 显「—」而非 0%）。unknown provider/model 独立桶。
 * 日界：Asia/Shanghai（快照写入侧已换轨；本报告的周/月分组同口径）。
 */
import type { HealthSnapshotRepository } from "./health-snapshot-repository";

export interface ModelEfficiencyCell {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** cacheRead / (input + cacheRead)；零分母 = null（显「—」） */
  cacheHitRate: number | null;
  callCount: number;
  errorCalls: number;
}

export interface ModelEfficiencyRow {
  provider: string;
  model: string;
  day: ModelEfficiencyCell | null;
  week: ModelEfficiencyCell | null;
  month: ModelEfficiencyCell | null;
}

export interface ModelEfficiencyReport {
  /** 报表时区（固定 Asia/Shanghai——展示与分组口径一致） */
  timezone: "Asia/Shanghai";
  /** 三个窗口的起止日期（YYYY-MM-DD，Asia/Shanghai） */
  windows: { day: { start: string; end: string }; week: { start: string; end: string }; month: { start: string; end: string } };
  rows: ModelEfficiencyRow[];
  totals: { day: ModelEfficiencyCell | null; week: ModelEfficiencyCell | null; month: ModelEfficiencyCell | null };
  /** 数据缺口：窗口内有快照行的天数（0 = 无数据） */
  snapshotDays: number;
}

interface CellAcc {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  calls: number; errors: number;
}

function accToCell(acc: CellAcc): ModelEfficiencyCell | null {
  if (acc.calls === 0 && acc.input === 0 && acc.output === 0 && acc.cacheRead === 0 && acc.cacheWrite === 0) return null;
  const denom = acc.cacheRead + acc.input;
  return {
    totalTokens: acc.input + acc.output + acc.cacheRead + acc.cacheWrite,
    inputTokens: acc.input,
    outputTokens: acc.output,
    cacheReadTokens: acc.cacheRead,
    cacheWriteTokens: acc.cacheWrite,
    cacheHitRate: denom > 0 ? Number((acc.cacheRead / denom).toFixed(4)) : null,
    callCount: acc.calls,
    errorCalls: acc.errors,
  };
}

function applyMetric(acc: CellAcc, key: string, value: number): boolean {
  switch (key) {
    case "input_tokens": acc.input += value; return true;
    case "output_tokens": acc.output += value; return true;
    case "cache_read_tokens": acc.cacheRead += value; return true;
    case "cache_write_tokens": acc.cacheWrite += value; return true;
    case "llm_call_count": acc.calls += value; return true;
    case "error_call_count": acc.errors += value; return true;
    default: return false;
  }
}

/** Asia/Shanghai 日键 → 所属自然周的周一；→ 所属自然月（YYYY-MM）。窗口键统一本地时区。 */
function shanghaiWeekKey(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  // 构造 Shanghai 当地零点对应的 UTC 时刻（+08:00），再取星期一
  const local = new Date(Date.UTC(y!, (m! - 1), d!, -8));
  const dow = local.getUTCDay(); // 0=周日
  const back = dow === 0 ? 6 : dow - 1;
  local.setUTCDate(local.getUTCDate() - back);
  return local.toISOString().slice(0, 10);
}

/** Asia/Shanghai 日键 → 所属自然月的月首日键（YYYY-MM-01）。窗口统一本地时区。 */
function shanghaiMonthStart(dateKey: string): string {
  return `${dateKey.slice(0, 7)}-01`;
}

/** 从快照行提取 (provider, model, window) 并累加到对应桶 */
function accumulateSnapshot(
  rows: Array<{ snapshot_date: string; metric_type: string; metric_key: string; metric_value: number; metadata: string | null }>,
  windows: { dayStart: string; weekStart: string; monthStart: string },
): { byModel: Map<string, { day: CellAcc; week: CellAcc; month: CellAcc }>; totals: { day: CellAcc; week: CellAcc; month: CellAcc }; snapshotDays: Set<string> } {
  const byModel = new Map<string, { day: CellAcc; week: CellAcc; month: CellAcc }>();
  const totals = { day: emptyAcc(), week: emptyAcc(), month: emptyAcc() };
  const snapshotDays = new Set<string>();
  const usageKeys = new Set(["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "llm_call_count", "error_call_count"]);

  for (const row of rows) {
    if (row.metric_type !== "cost_output" || !usageKeys.has(row.metric_key)) continue;
    snapshotDays.add(row.snapshot_date);
    accumulateRow(row, byModel, totals, windows);
  }
  return { byModel, totals, snapshotDays };
}

/** 单行入桶：解析 metadata 并按三个窗口累加（day/week/month 各自判断） */
function accumulateRow(
  row: { snapshot_date: string; metric_key: string; metric_value: number; metadata: string | null },
  byModel: Map<string, { day: CellAcc; week: CellAcc; month: CellAcc }>,
  totals: { day: CellAcc; week: CellAcc; month: CellAcc },
  windows: { dayStart: string; weekStart: string; monthStart: string },
): void {
  let meta: { model?: string; provider?: string } = {};
  try { meta = row.metadata ? JSON.parse(row.metadata) as { model?: string; provider?: string } : {}; } catch { /* 脏 metadata 归 unknown */ }
  const key = `${meta.provider?.trim() || "unknown"}|${meta.model?.trim() || "unknown"}`;
  let entry = byModel.get(key);
  if (!entry) {
    entry = { day: emptyAcc(), week: emptyAcc(), month: emptyAcc() };
    byModel.set(key, entry);
  }
  const value = Number(row.metric_value) || 0;
  if (row.snapshot_date === windows.dayStart) {
    applyMetric(entry.day, row.metric_key, value);
    applyMetric(totals.day, row.metric_key, value);
  }
  if (row.snapshot_date >= windows.weekStart) {
    applyMetric(entry.week, row.metric_key, value);
    applyMetric(totals.week, row.metric_key, value);
  }
  if (row.snapshot_date >= windows.monthStart) {
    applyMetric(entry.month, row.metric_key, value);
    applyMetric(totals.month, row.metric_key, value);
  }
}

export class ModelEfficiencyReportBuilder {
  constructor(
    private readonly snapshotRepo: Pick<HealthSnapshotRepository, "findByDateRange">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async build(): Promise<ModelEfficiencyReport> {
    const now = this.now();
    // 窗口边界（Asia/Shanghai 日键）
    const todayKey = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
    const dayStart = todayKey;
    const weekStartKey = shanghaiWeekKey(todayKey);
    const monthStartKey = shanghaiMonthStart(todayKey);

    // 拉取窗口数据：从最早窗口起（月首）
    const fetchStart = [dayStart, weekStartKey, monthStartKey].sort()[0]!;
    const rows = this.snapshotRepo.findByDateRange(fetchStart, todayKey);
    const { byModel, totals, snapshotDays } = accumulateSnapshot(rows, { dayStart, weekStart: weekStartKey, monthStart: monthStartKey });

    const modelRows: ModelEfficiencyRow[] = [...byModel.entries()]
      .map(([key, acc]) => {
        const [provider, model] = key.split("|");
        return {
          provider: provider ?? "unknown",
          model: model ?? "unknown",
          day: accToCell(acc.day),
          week: accToCell(acc.week),
          month: accToCell(acc.month),
        };
      })
      .sort((a, b) => (b.month?.totalTokens ?? b.week?.totalTokens ?? 0) - (a.month?.totalTokens ?? a.week?.totalTokens ?? 0));

    return {
      timezone: "Asia/Shanghai",
      windows: {
        day: { start: dayStart, end: dayStart },
        week: { start: weekStartKey, end: todayKey },
        month: { start: monthStartKey, end: todayKey },
      },
      rows: modelRows,
      totals: {
        day: accToCell(totals.day),
        week: accToCell(totals.week),
        month: accToCell(totals.month),
      },
      snapshotDays: snapshotDays.size,
    };
  }
}

function emptyAcc(): CellAcc {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, errors: 0 };
}
