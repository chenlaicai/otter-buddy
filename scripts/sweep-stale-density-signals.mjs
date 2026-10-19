#!/usr/bin/env node
/**
 * issue #1051：RHI post_merge_fix_density 口径切换后的存量清扫（一次性运维脚本）。
 *
 * 背景：PR #1560 把 post_merge_fix_density 从「次数≥3 或 占比≥30%」的或门改为
 * 「次数≥3 且 占比≥15%」的双门。合并前旧口径仍在主仓运行，会持续产出低于新阈值的
 * noise——且 SignalRepository.upsert（src/usecases/health/signal-repository.ts）只匹配
 * status='open'，dismiss 掉的行会被下一轮扫描**新开一行**重新长回来（实测 20 分钟内
 * open 从 16 涨到 28）。所以合并后必须补跑一次清扫，断言才能长期成立。
 *
 * 本脚本做什么：把 open 且**低于新双门阈值**的 density 信号逐条 dismiss，每条 note 写
 * 本条自己的占比（从 evidence 现取），不是统一戳。
 *
 * 为什么只扫 density、不扫 hotspot：hotspot 在新口径下靠 computeFanInExclusions 在**产出端**
 * 就排除了高扇入枢纽文件——合并后仍然 open 的 hotspot 必然是非枢纽文件，属真信号，不该扫。
 * 旧口径产生的枢纽类 hotspot 同样会被本脚本漏掉，但它们会被合并后首轮扫描自然覆盖：
 * 合并前那批已在 PR #1560 处置轮 dismiss 过（其中被回涨重新长出的行见下方 --include-hotspot）。
 *
 * 阈值镜像说明：--min-count / --min-ratio 的默认值必须与
 * src/usecases/health/post-merge-fix-density.ts 的 FIX_COUNT_THRESHOLD / FIX_RATIO_THRESHOLD 一致，
 * 改那边的常量时同步改这里（或用参数覆盖）。
 *
 * 安全设计（沿用 scripts/cleanup-ghost-sessions-753.mjs）：
 *  - 默认 dry-run：只扫描报告，不写 DB
 *  - --apply 才执行；执行前自动备份 DB 文件到同目录
 *  - 全部写操作走单事务，失败整体回滚
 *  - evidence 解析失败的行**不动并单独列出**（fail-loud，不静默跳过）
 *
 * 用法：
 *   node scripts/sweep-stale-density-signals.mjs                  # dry-run 报告
 *   node scripts/sweep-stale-density-signals.mjs --apply          # 执行清扫
 *   node scripts/sweep-stale-density-signals.mjs --min-ratio=20   # 覆盖阈值
 *   node scripts/sweep-stale-density-signals.mjs --db=/path/to.db
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");

function parseArgs(argv) {
  const args = {
    apply: false,
    db: path.join(rootDir, "data", "otter-buddy.db"),
    minCount: 3,   // 镜像 FIX_COUNT_THRESHOLD
    minRatio: 15,  // 镜像 FIX_RATIO_THRESHOLD * 100
  };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg.startsWith("--db=")) args.db = arg.slice(5);
    else if (arg.startsWith("--min-count=")) args.minCount = Number(arg.slice(12));
    else if (arg.startsWith("--min-ratio=")) args.minRatio = Number(arg.slice(12));
    else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(args.minCount) || !Number.isFinite(args.minRatio)) {
    console.error("--min-count / --min-ratio 必须是数字");
    process.exit(2);
  }
  return args;
}

/** 从 evidence 提取 bugfix 次数 / 窗口 commit 总数 / 占比。
 *  evidence 由 detectPostMergeFixDensity 生成，格式稳定：
 *  "…占窗口全部 commit 3/111 = 3%；链规模 8 文件…"
 *  解析不出 → 返回 null（调用方 fail-loud 列出，不静默跳过） */
function parseRatio(evidence) {
  const m = /占窗口全部 commit\s+(\d+)\/(\d+)\s*=\s*(\d+)%/.exec(evidence ?? "");
  if (!m) return null;
  return { count: Number(m[1]), denom: Number(m[2]), ratio: Number(m[3]) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.db)) {
    console.error(`DB 不存在：${args.db}`);
    process.exit(2);
  }

  const db = new DatabaseSync(args.db);
  db.exec("PRAGMA foreign_keys = ON;");

  const rows = db.prepare(`
    SELECT id, feature_id, evidence, occurrences, issue_number, first_seen
    FROM signals
    WHERE status = 'open' AND signal_type = 'post_merge_fix_density'
    ORDER BY id
  `).all();

  const keep = [];
  const sweep = [];
  const unparsed = [];

  for (const r of rows) {
    const p = parseRatio(r.evidence);
    if (!p) { unparsed.push(r); continue; }
    const passesCount = p.count >= args.minCount;
    const passesRatio = p.ratio >= args.minRatio;
    (passesCount && passesRatio ? keep : sweep).push({ ...r, ...p });
  }

  console.log(`阈值：次数 ≥${args.minCount} 且 占比 ≥${args.minRatio}%`);
  console.log(`open density 信号：${rows.length}`);
  console.log(`  达双门阈值（保留，真信号）：${keep.length}`);
  console.log(`  低于阈值（清扫对象）：${sweep.length}`);
  console.log(`  evidence 解析失败（不动，需人工看）：${unparsed.length}`);
  if (keep.length) {
    console.log("\n—— 保留的真信号 ——");
    for (const k of keep) console.log(`  id=${k.id} ${k.feature_id} ${k.count}/${k.denom} = ${k.ratio}%`);
  }
  if (unparsed.length) {
    console.log("\n⚠ evidence 解析失败（未触碰，建议人工核对格式是否被改动）：");
    for (const u of unparsed) console.log(`  id=${u.id} ${u.feature_id} ${String(u.evidence).slice(0, 120)}`);
  }
  if (!sweep.length) {
    console.log("\n无需清扫。");
    db.close();
    return;
  }
  console.log(`\n—— 将清扫 ${sweep.length} 条 ——`);
  for (const s of sweep) {
    console.log(`  id=${s.id} ${s.feature_id} ${s.count}/${s.denom} = ${s.ratio}%${s.issue_number ? ` (issue #${s.issue_number})` : ""}`);
  }

  if (!args.apply) {
    console.log("\n[dry-run] 未写 DB。加 --apply 执行。");
    db.close();
    return;
  }

  // 执行前备份 DB 文件到同目录
  const backupPath = `${args.db}.bak-sweep-${Date.now()}`;
  fs.copyFileSync(args.db, backupPath);
  console.log(`\n已备份 DB → ${backupPath}`);

  const noteStmt = db.prepare(`
    UPDATE signals
    SET status = 'dismissed',
        triaged_at = ?,
        resolved_at = ?,
        triage_note = ?
    WHERE id = ? AND status = 'open'
  `);

  const now = new Date().toISOString();
  let done = 0;
  let failed = 0;

  db.exec("BEGIN");
  try {
    for (const s of sweep) {
      const note = `产出口径已调整（#1051 方案 1，PR #1560）：post_merge_fix_density 已改为双门 ` +
        `AND（次数≥${args.minCount} 且 占比≥${args.minRatio}%）。本条 ${s.count}/${s.denom} = ${s.ratio}% —— ` +
        `未达新阈值，属旧或门口径的次数门单支误报（月产 200+ commit 的仓库里，任何合入 30 天内 ` +
        `的特性都会凑够 3 条 bugfix）。合并后清扫退出。` +
        (s.issue_number ? `（绑定 issue #${s.issue_number}）` : "");
      const res = noteStmt.run(now, now, note, Number(s.id));
      if (Number(res.changes) === 1) done++; else failed++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    console.error(`\n事务失败已回滚：${err instanceof Error ? err.message : String(err)}`);
    db.close();
    process.exit(1);
  }

  db.close();
  console.log(`\n完成：清扫 ${done} 条，失败 ${failed} 条。`);
  if (failed > 0) {
    console.error("存在失败行（status 可能已被并发修改），请复查备份文件。");
    process.exit(1);
  }
}

main();
