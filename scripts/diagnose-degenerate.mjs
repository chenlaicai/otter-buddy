/**
 * 退化检测离线诊断（issue #424）。chunk 参数是灵敏度参数而非真实模拟（#439）：
 * 影响触发点数值，不影响是否触发的判定；需要数值对照时用 --chunk 扫多个值。
 *
 * 把被拦消息的完整流式输出重放经过 DegenerateDetector，输出实际触发机制、
 * 窗口计数、distinct-ratio 与阈值差距——用于事后判定某次拦截是误报还是真实退化。
 *
 * 两种数据源：
 *   1. --session <jsonl> --ts <timestamp-prefix>（推荐）
 *      定位该时间戳的 assistant 消息，提取 thinking/text 各 block，模拟
 *      OutputGuard 真实行为（text_start/thinking_start 时 reset + 分块流式喂入）。
 *      pi session jsonl 是唯一保存完整输出的地方——message_segments 只落库
 *      speak 的 body，不含 speak 之后继续生成的裸文本（#424 教训：落库文本
 *      ≠ 检测器累积文本，两者长度可差 20 倍+）。
 *   2. --db <sqlite-path> --message <messageId>
 *      从 message_segments 拉正文重放。注意这只覆盖已落库部分，仅当消息
 *      正常完成（无未落库尾部）时结果才代表运行时判定。
 *
 * 用法示例（#424 事件重放，需先 npm run build 产出 dist）：
 *   node scripts/diagnose-degenerate.mjs \
 *     --session data/sessions/2026-08-24T07-36-50-802Z_*.jsonl \
 *     --ts 2026-08-24T11:54:03.763
 *
 * 输出（退出码 0=未触发 / 1=触发退化 / 2=参数或数据错误）：
 *   每个 text/thinking block：机制 A 最大窗口计数 vs 阈值、机制 B
 *   distinct-ratio vs 阈值、若触发则给出 mechanism/detail/触发点
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const args = { chunk: 37 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--session": args.session = argv[++i]; break;
      case "--ts": args.ts = argv[++i]; break;
      case "--db": args.db = argv[++i]; break;
      case "--message": args.message = argv[++i]; break;
      case "--chunk": args.chunk = Number(argv[++i]); break;
      case "--help": case "-h": args.help = true; break;
      default: console.error(`未知参数: ${a}`); args.help = true;
    }
  }
  return args;
}

/** djb2（与 DegenerateDetector 实现同源，供脚本侧统计机制 A/B 峰值） */
function djb2(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return h >>> 0;
}

/**
 * 分块流式喂入（模拟 OutputGuard 的 delta 到达），返回首个触发 verdict
 * 及脚本侧统计的机制 A 窗口计数峰值 / 机制 B distinct-ratio。
 * 侧算与重放使用同一套参数（DEFAULT_DEGENERATE_CONFIG），结论以重放为准。
 */
function replay(detectorModule, text, chunkSize) {
  const cfg = detectorModule.DEFAULT_DEGENERATE_CONFIG;
  const w = cfg.windowLength;
  // 机制 A 侧算：stride-1 滑窗计数峰值（与实现同参数）
  const counts = new Map();
  let peakWindowCount = 0;
  for (let i = w; i <= text.length; i++) {
    const h = djb2(text.slice(i - w, i));
    const c = (counts.get(h) ?? 0) + 1;
    counts.set(h, c);
    if (c > peakWindowCount) peakWindowCount = c;
  }
  // 机制 B 侧算：非重叠分段 distinct-ratio
  const segs = new Set();
  let total = 0;
  for (let i = 0; i + w <= text.length; i += w) { segs.add(djb2(text.slice(i, i + w))); total++; }
  const ratioAtEnd = total === 0 ? null : segs.size / total;
  // 实际重放（分块喂入，等价于 OutputGuard 的 delta 序列）
  const detector = new detectorModule.DegenerateDetector();
  let verdict = null;
  for (let i = 0; i < text.length; i += chunkSize) {
    const v = detector.add(text.slice(i, i + chunkSize));
    if (v.degenerate && !verdict) verdict = v;
  }
  return { verdict, peakWindowCount, ratioAtEnd, segments: total, distinctSegments: segs.size, config: cfg };
}

// ---------- 数据源 1：session jsonl ----------
function fromSession(sessionPath, tsPrefix) {
  const lines = readFileSync(sessionPath, "utf8").split("\n").filter(Boolean);
  const matched = [];
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "message" && typeof e.timestamp === "string" && e.timestamp.startsWith(tsPrefix)
      && e.message?.role === "assistant") {
      matched.push(e);
    }
  }
  if (matched.length === 0) {
    console.error(`[错误] 未在 ${sessionPath} 找到 timestamp 以 "${tsPrefix}" 开头的 assistant 消息`);
    process.exit(2);
  }
  const blocks = [];
  for (const e of matched) {
    for (const c of e.message.content ?? []) {
      if (c.type === "thinking") blocks.push({ kind: "thinking", text: c.thinking ?? "" });
      if (c.type === "text") blocks.push({ kind: "text", text: c.text ?? "" });
    }
  }
  return blocks;
}

// ---------- 数据源 2：message_segments ----------
async function fromDb(dbPath, messageId) {
  let Database;
  try { ({ default: Database } = await import("better-sqlite3")); }
  catch { console.error("[错误] better-sqlite3 不可用（需在仓库 node_modules 内运行）"); process.exit(2); }
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare("SELECT sequence_num, body FROM message_segments WHERE message_id = ? ORDER BY sequence_num").all(messageId);
  db.close();
  if (rows.length === 0) { console.error(`[错误] message_segments 无 ${messageId}`); process.exit(2); }
  return rows.map((r) => ({ kind: `segment#${r.sequence_num}`, text: r.body }));
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !(args.session ? args.ts : args.db && args.message)) {
    console.log(`用法：
  node scripts/diagnose-degenerate.mjs --session <pi-session.jsonl> --ts <timestamp-prefix> [--chunk N]
  node scripts/diagnose-degenerate.mjs --db <sqlite> --message <messageId> [--chunk N]
  --chunk N 为灵敏度参数（默认 37）：影响触发点数值，不影响是否触发的判定；
  需要数值对照时扫 1/37/100/500 对比触发点区间。
示例（#424）：
  node scripts/diagnose-degenerate.mjs --session data/sessions/2026-08-24T07-36-50-802Z_xxx.jsonl --ts 2026-08-24T11:54:03.763`);
    process.exit(args.help ? 0 : 2);
  }
  // 与运行时同一份编译产物（需先 npm run build）
  const dist = path.resolve(import.meta.dirname, "../dist/src/frameworks/agent/degenerate-detector.js");
  if (!existsSync(dist)) {
    console.error(`[错误] 未找到 ${dist}\n请先在仓库根目录执行 npm run build`);
    process.exit(2);
  }
  const detectorModule = await import(pathToFileURL(dist).href);
  const blocks = args.session
    ? fromSession(args.session, args.ts)
    : await fromDb(args.db, args.message);
  console.log(`数据源: ${args.session ? `session ${path.basename(args.session)} @ ${args.ts}` : `db ${args.db} message ${args.message}`}`);
  // #439：chunk 是灵敏度参数而非真实模拟——影响触发点数值，不影响是否触发的判定。
  // 运行时 delta 尺寸由 LLM provider 决定（模型/网络分片不同），无单一真相源可绑定。
  console.log(`喂入分块: ${args.chunk} 字符/块（灵敏度参数，模拟流式 delta 尺度；影响触发点数值不影响判定；可用 --chunk 扫 1/37/100/500 对比）\n`);
  let tripped = false;
  for (const b of blocks) {
    // OutputGuard 语义：每个 text/thinking block 边界 reset（text_start/thinking_start）
    console.log(`== block ${b.kind}（${b.text.length} 字符）==`);
    const r = replay(detectorModule, b.text, args.chunk);
    const cfg = r.config;
    const ratioStr = r.ratioAtEnd === null
      ? "n/a（块长 < windowLength，不分段）"
      : `${r.ratioAtEnd.toFixed(3)}（${r.distinctSegments}/${r.segments}，阈值 ${cfg.distinctRatioThreshold}，仅当总长 ≥ ${cfg.minBlockLength} 判定）`;
    console.log(`  机制A 滑窗计数峰值: ${r.peakWindowCount}（阈值 ${cfg.maxWindowRepeats}）`);
    console.log(`  机制B distinct-ratio: ${ratioStr}`);
    if (r.verdict?.degenerate) {
      tripped = true;
      console.log(`  ⛔ 触发: mechanism=${r.verdict.mechanism}`);
      console.log(`     detail: ${r.verdict.detail}`);
    } else {
      console.log(`  ✅ 未触发`);
    }
    console.log();
  }
  console.log(tripped
    ? "结论: 触发退化拦截（真实退化）"
    : "结论: 未触发（若运行时被拦，检查运行进程的配置版本是否与 main 一致——进程未重启会跑旧构建，#424 现场 threshold=50 vs main 20 即此情况）");
  process.exit(tripped ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
