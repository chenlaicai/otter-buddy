#!/usr/bin/env node
/**
 * F20260923htax：Harness Tax 量化观测——invoke 数据成本聚合分析。
 *
 * 只读查询 data/otter-buddy.db 的 invokes 表，按「模型 × 任务类型」分组输出
 * token 消耗统计（均值/中位数/P90/样本数）与成本估算。
 * 灵感来源：HarnessTax（Arena/Berkeley 2026-09）——harness 差异可致 5 倍成本差；
 * 本脚本回答「咱们自己的税分布在哪」。
 *
 * 用法：
 *   node scripts/harness-tax-report.mjs [--db <path>] [--json <outPath>] [--days <N>]
 * 默认 --db data/otter-buddy.db（主仓根解析），--days 默认 30。
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

// ── 定价表（$/M token，2026-09 核实自各厂商公开定价页；未知=只报 token 量）──
// 注意：内部代理/会员价与公开 API 价可能不同，成本列是量级估算，不是账单。
const PRICING = {
  // alias: [input, output]
  "kimi": [4, 16],        // K3 公开 API 量级
  "kimi-256k": [2, 8],    // 官方说明：消耗约为 k3 一半
  "kimi-k28": [2, 8],
  "kimi-fast": [6, 24],   // 官方说明：3 倍消耗
  "glm": [1, 4],          // GLM 公开 API 量级
  "glm-flash": [0.5, 2],
  "mimo": [1, 4],
  "mimo-pro": [2, 8],
};

// ── 任务类型推断规则（宁可粗不可错：匹配不到归「其他」；定时任务单列前缀）──
// scheduler 触发的 invoke（trigger_entry_id 为 NULL）单独看对话标题。

function parseArgs(argv) {
  const args = { db: "data/otter-buddy.db", json: null, days: 30 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--db") args.db = argv[++i];
    else if (argv[i] === "--json") args.json = argv[++i];
    else if (argv[i] === "--days") args.days = Number(argv[++i]);
  }
  return args;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function main() {
  const args = parseArgs(process.argv);
  const dbPath = path.isAbsolute(args.db) ? args.db : path.resolve(process.cwd(), args.db);
  if (!fs.existsSync(dbPath)) {
    console.error(`DB 不存在: ${dbPath}`);
    process.exit(1);
  }
  const db = new Database(dbPath, { readonly: true });

  const since = new Date(Date.now() - args.days * 86400_000).toISOString();
  const rows = db.prepare(`
    SELECT i.id, i.status, i.ctx_window_used, i.token_usage_input, i.token_usage_output,
           i.tool_call_count, i.started_at, i.ended_at, i.trigger_entry_id,
           json_extract(i.metadata, '$.model') AS model,
           c.title AS conv_title,
           EXISTS(
             SELECT 1 FROM entries e
             WHERE e.conversation_id = i.conversation_id
               AND e.entry_type = 'system' AND e.sender_type = 'system'
               AND e.body LIKE '%扫描%请按以下清单执行%'
           ) AS is_scheduled
    FROM invokes i
    LEFT JOIN conversations c ON i.conversation_id = c.id
    WHERE i.status = 'completed' AND i.started_at >= ?
  `).all(since);

  const totalInWindow = rows.length;
  const withCtx = rows.filter(r => r.ctx_window_used != null).length;

  // 分组聚合（任务类型=关键词粗分，定时任务单列前缀）
  const groups = new Map(); // key = `${model}|${task}`
  for (const r of rows) {
    const model = r.model ?? "unknown";
    const isScheduled = r.is_scheduled === 1; // trigger_entry_id 实际恒 NULL，改用 scheduled_tasks 表判定
    const KIND_RULES = [
      [/雷达|radar/i, "雷达简报"],
      [/体检|health/i, "每日体检"],
      [/外部洞察|洞察/i, "洞察讨论"],
      [/审视|review|检视/i, "审视"],
      [/重启|restart/i, "运维"],
    ];
    let matched = "其他";
    for (const [re, label] of KIND_RULES) if (re.test(r.conv_title ?? "")) { matched = label; break; }
    const task = isScheduled ? `定时·${matched}` : `对话·${matched}`;
    const key = `${model}|${task}`;
    if (!groups.has(key)) groups.set(key, { model, task, ctx: [], input: [], output: [], tools: [], secs: [] });
    const g = groups.get(key);
    if (r.ctx_window_used != null) g.ctx.push(r.ctx_window_used);
    if (r.token_usage_input != null) g.input.push(r.token_usage_input);
    if (r.token_usage_output != null) g.output.push(r.token_usage_output);
    if (r.tool_call_count != null) g.tools.push(r.tool_call_count);
    if (r.started_at && r.ended_at) {
      const secs = (new Date(r.ended_at) - new Date(r.started_at)) / 1000;
      if (Number.isFinite(secs) && secs >= 0) g.secs.push(secs);
    }
  }

  const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const med = a => { const s = [...a].sort((x, y) => x - y); return percentile(s, 50); };
  const p90 = a => { const s = [...a].sort((x, y) => x - y); return percentile(s, 90); };
  const fmt = (v, d = 0) => (v == null ? "—" : Number(v.toFixed(d)).toLocaleString("en-US"));

  const report = [...groups.values()].map(g => {
    const avgIn = avg(g.input), avgOut = avg(g.output);
    const price = PRICING[g.model];
    const costPerInvoke = price && avgIn != null && avgOut != null
      ? (avgIn * price[0] + avgOut * price[1]) / 1e6
      : null;
    return {
      model: g.model,
      task: g.task,
      n: Math.max(g.ctx.length, g.input.length, g.secs.length),
      ctxAvg: avg(g.ctx), ctxMed: med(g.ctx), ctxP90: p90(g.ctx),
      inAvg: avgIn, outAvg: avgOut,
      toolsAvg: avg(g.tools),
      secAvg: avg(g.secs),
      costPerInvoke,
    };
  }).sort((a, b) => (b.ctxAvg ?? 0) - (a.ctxAvg ?? 0));

  // 终端表格
  console.log(`\n📊 Harness Tax 报告 · 近 ${args.days} 天（${since.slice(0, 10)} 起）`);
  console.log(`样本：${totalInWindow} 次 completed invoke，其中 ${withCtx} 次含 ctx_window_used（覆盖率 ${totalInWindow ? Math.round((withCtx / totalInWindow) * 100) : 0}%）`);
  console.log(`定价口径：2026-09 公开 API 量级估算（代理/会员价可能不同，成本列仅供相对比较）\n`);

  const header = ["模型", "任务类型", "样本", "ctx均值", "ctx中位", "ctxP90", "in均值", "out均值", "工具均", "时长s", "$/次"];
  const widths = [12, 12, 6, 10, 10, 10, 10, 9, 7, 7, 8];
  const line = (cols) => cols.map((c, i) => String(c).padEnd(widths[i]).slice(0, widths[i])).join(" ");
  console.log(line(header));
  console.log(widths.map(w => "─".repeat(w)).join(" "));
  for (const r of report) {
    console.log(line([
      r.model, r.task, r.n,
      fmt(r.ctxAvg), fmt(r.ctxMed), fmt(r.ctxP90),
      fmt(r.inAvg), fmt(r.outAvg),
      fmt(r.toolsAvg, 1), fmt(r.secAvg),
      r.costPerInvoke == null ? "—" : "$" + r.costPerInvoke.toFixed(4),
    ]));
  }

  // 汇总：总成本估算
  const totalCost = report.reduce((s, r) => s + (r.costPerInvoke ?? 0) * r.n, 0);
  const pricedN = report.reduce((s, r) => s + (r.costPerInvoke != null ? r.n : 0), 0);
  console.log(`\n合计（有定价的 ${pricedN} 次 invoke）：≈ $${totalCost.toFixed(2)}`);

  if (args.json) {
    const out = path.resolve(process.cwd(), args.json);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ since, days: args.days, totalInWindow, withCtx, groups: report }, null, 2));
    console.log(`JSON 已导出: ${out}`);
  }
  db.close();
}

main();
