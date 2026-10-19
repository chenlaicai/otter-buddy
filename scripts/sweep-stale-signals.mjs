#!/usr/bin/env node
/**
 * issue #1051：RHI 信号口径切换后的存量清扫（一次性运维脚本）。
 *
 * 背景：PR #1560 把 post_merge_fix_density 从「次数≥3 或 占比≥30%」的或门改为
 * 「次数≥3 且 占比≥15%」的双门，并给 hotspot 加了高扇入枢纽排除。合并前旧口径仍在
 * 主仓运行，会持续产出低于新阈值的 density 与指向枢纽文件的 hotspot——且
 * SignalRepository.upsert（src/usecases/health/signal-repository.ts）只匹配
 * status='open'，dismiss 掉的行会被下一轮扫描**新开一行**重新长回来（实测 20 分钟内
 * open 从 16 涨到 28；修复 9 条误 dismiss 时还挖出 9 条同键孪生行的犯罪现场）。
 * 所以合并后必须补跑一次清扫，#1051 的验收断言才能长期成立。
 *
 * 本脚本扫两类（delta 复核 C 项：两类都必须扫，否则断言打不到目标）：
 *  A. density：低于新双门阈值的退出。占比从 evidence 现取（格式由 detectPostMergeFixDensity
 *     生成且稳定），解析失败的行**不动并单独列出**（fail-loud，不静默跳过）。
 *  B. hotspot：**文件扇入 ≥ FAN_IN_THRESHOLD 的退出**。扇入用与线上同一口径重算——
 *     `git log --since='<window-days> days ago'` 数该文件被多少个不同 FID 触碰。
 *     这与 computeFanInExclusions 的判定一致（单一真相源），而不是无差别扫掉全部 hotspot：
 *     新口径下产出端已排除枢纽，合并后仍 open 的非枢纽 hotspot 是真信号，必须保留。
 *
 * 阈值镜像说明：--min-count / --min-ratio / --fan-in / --window-days 的默认值必须与
 * src/usecases/health/post-merge-fix-density.ts 的 FIX_COUNT_THRESHOLD / FIX_RATIO_THRESHOLD /
 * FAN_IN_THRESHOLD 一致，改那边的常量时同步改这里（或用参数覆盖）。
 *
 * 安全设计（沿用 scripts/cleanup-ghost-sessions-753.mjs）：
 *  - 默认 dry-run：只扫描报告，不写 DB
 *  - --apply 才执行；执行前自动备份 DB 文件到同目录
 *  - 全部写操作走单事务，失败整体回滚
 *  - 解析/扇入计算失败的行不动并单独列出
 *
 * 用法：
 *   node scripts/sweep-stale-signals.mjs                     # dry-run 报告
 *   node scripts/sweep-stale-signals.mjs --apply             # 执行清扫
 *   node scripts/sweep-stale-signals.mjs --min-ratio=20      # 覆盖阈值
 *   node scripts/sweep-stale-signals.mjs --db=/path/to.db
 */

import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");

function parseArgs(argv) {
  const args = {
    apply: false,
    db: path.join(rootDir, "data", "otter-buddy.db"),
    minCount: 3,       // 镜像 FIX_COUNT_THRESHOLD
    minRatio: 15,      // 镜像 FIX_RATIO_THRESHOLD * 100
    fanIn: 10,         // 镜像 FAN_IN_THRESHOLD
    windowDays: 60,    // computeFanInExclusions 的链构建窗（60 天）
  };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg.startsWith("--db=")) args.db = arg.slice(5);
    else if (arg.startsWith("--min-count=")) args.minCount = Number(arg.slice(12));
    else if (arg.startsWith("--min-ratio=")) args.minRatio = Number(arg.slice(12));
    else if (arg.startsWith("--fan-in=")) args.fanIn = Number(arg.slice(9));
    else if (arg.startsWith("--window-days=")) args.windowDays = Number(arg.slice(14));
    else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  for (const [k, v] of Object.entries({ minCount: args.minCount, minRatio: args.minRatio, fanIn: args.fanIn, windowDays: args.windowDays })) {
    if (!Number.isFinite(v) || v <= 0) {
      console.error(`--${k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)} 必须是正数`);
      process.exit(2);
    }
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

/** 文件扇入：近 <windowDays> 天被多少个不同 FID 触碰（与 computeFanInExclusions 同口径）。
 *  git 不可用或无历史 → 返回 null（调用方 fail-loud 列出，不动该行） */
function computeFanIn(repoDir, filePath, windowDays) {
  let out;
  try {
    out = execFileSync(
      "git",
      ["-C", repoDir, "log", `--since=${windowDays} days ago`, "--format=%s", "--", filePath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return null;
  }
  const fids = new Set(out.match(/\[F\d{8}[^\]\s]*\]/g) ?? []);
  return fids.size;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.db)) {
    console.error(`DB 不存在：${args.db}`);
    process.exit(2);
  }

  const db = new DatabaseSync(args.db);
  db.exec("PRAGMA foreign_keys = ON;");

  console.log(`阈值：density 次数 ≥${args.minCount} 且 占比 ≥${args.minRatio}%｜hotspot 文件扇入 ≥${args.fanIn}（${args.windowDays} 天窗）\n`);

  // ---------- A. density ----------
  const densityRows = db.prepare(`
    SELECT id, feature_id, evidence, occurrences, issue_number
    FROM signals
    WHERE status = 'open' AND signal_type = 'post_merge_fix_density'
    ORDER BY id
  `).all();

  const dKeep = [];
  const dSweep = [];
  const dUnparsed = [];
  for (const r of densityRows) {
    const p = parseRatio(r.evidence);
    if (!p) { dUnparsed.push(r); continue; }
    (p.count >= args.minCount && p.ratio >= args.minRatio ? dKeep : dSweep).push({ ...r, ...p });
  }

  console.log(`[density] open ${densityRows.length}｜保留（达双门）${dKeep.length}｜清扫 ${dSweep.length}｜解析失败不动 ${dUnparsed.length}`);
  for (const k of dKeep) console.log(`  保留 id=${k.id} ${k.feature_id} ${k.count}/${k.denom} = ${k.ratio}%`);
  for (const s of dSweep) console.log(`  清扫 id=${s.id} ${s.feature_id} ${s.count}/${s.denom} = ${s.ratio}%${s.issue_number ? ` (issue #${s.issue_number})` : ""}`);
  for (const u of dUnparsed) console.log(`  ⚠ evidence 解析失败（未触碰）id=${u.id} ${u.feature_id} ${String(u.evidence).slice(0, 100)}`);

  // ---------- B. hotspot ----------
  const hotspotRows = db.prepare(`
    SELECT id, file_path, evidence, occurrences, issue_number
    FROM signals
    WHERE status = 'open' AND signal_type = 'hotspot'
    ORDER BY id
  `).all();

  const hKeep = [];
  const hSweep = [];
  const hUnparsed = [];
  for (const r of hotspotRows) {
    if (!r.file_path) { hUnparsed.push(r); continue; }
    const fanIn = computeFanIn(rootDir, r.file_path, args.windowDays);
    if (fanIn === null) { hUnparsed.push(r); continue; }
    (fanIn >= args.fanIn ? hSweep : hKeep).push({ ...r, fanIn });
  }

  console.log(`\n[hotspot] open ${hotspotRows.length}｜保留（扇入 <${args.fanIn}，真热点）${hKeep.length}｜清扫（枢纽）${hSweep.length}｜扇入算不出不动 ${hUnparsed.length}`);
  for (const k of hKeep) console.log(`  保留 id=${k.id} ${k.file_path} fan-in=${k.fanIn}`);
  for (const s of hSweep) console.log(`  清扫 id=${s.id} ${s.file_path} fan-in=${s.fanIn}${s.issue_number ? ` (issue #${s.issue_number})` : ""}`);
  for (const u of hUnparsed) console.log(`  ⚠ 扇入计算失败（未触碰）id=${u.id} ${u.file_path}`);

  const totalSweep = dSweep.length + hSweep.length;
  console.log(`\n合计：保留 ${dKeep.length + hKeep.length}，清扫 ${totalSweep}，fail-loud 未触碰 ${dUnparsed.length + hUnparsed.length}`);

  if (!totalSweep) {
    console.log("\n无需清扫。");
    db.close();
    return;
  }

  if (!args.apply) {
    console.log("\n[dry-run] 未写 DB。加 --apply 执行。");
    db.close();
    return;
  }

  const backupPath = `${args.db}.bak-sweep-${Date.now()}`;
  fs.copyFileSync(args.db, backupPath);
  console.log(`\n已备份 DB → ${backupPath}`);

  const stmt = db.prepare(`
    UPDATE signals
    SET status = 'dismissed', triaged_at = ?, resolved_at = ?, triage_note = ?
    WHERE id = ? AND status = 'open'
  `);

  const now = new Date().toISOString();
  let done = 0;
  let failed = 0;

  db.exec("BEGIN");
  try {
    for (const s of dSweep) {
      const note = `产出口径已调整（#1051 方案 1，PR #1560）：post_merge_fix_density 已改为双门 AND` +
        `（次数≥${args.minCount} 且 占比≥${args.minRatio}%）。本条 ${s.count}/${s.denom} = ${s.ratio}% ——` +
        ` 未达新阈值，属旧或门口径的次数门单支误报（月产 200+ commit 的仓库里，任何合入 30 天内的` +
        ` 特性都会凑够 3 条 bugfix）。合并后清扫退出。` +
        (s.issue_number ? `（绑定 issue #${s.issue_number}）` : "");
      if (Number(stmt.run(now, now, note, Number(s.id)).changes) === 1) done++; else failed++;
    }
    for (const s of hSweep) {
      const note = `产出口径已调整（#1051 方案 1，PR #1560）：hotspot 已加高扇入枢纽排除` +
        `（FAN_IN_THRESHOLD=${args.fanIn}，与 density 复用 computeFanInExclusions 单一真相源）。` +
        `本条指向 ${s.file_path} —— 近 ${args.windowDays} 天扇入 ${s.fanIn}，枢纽被多特性高频触碰是架构使然、` +
        ` 非文件热点。合并后清扫退出（观测仍落 health_snapshots 的 distribution/file_hotspots，历史序列在）。` +
        (s.issue_number ? `（绑定 issue #${s.issue_number}）` : "");
      if (Number(stmt.run(now, now, note, Number(s.id)).changes) === 1) done++; else failed++;
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
