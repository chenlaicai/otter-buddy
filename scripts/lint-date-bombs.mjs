#!/usr/bin/env node
/**
 * #1173：测试时间炸弹静态扫描（收窄版 v2，B1 方案重生）。
 *
 * 历史：v1（F20260915dabm）9/23 随 #931 退役——辅助面全量报 ISO 日期 warning
 * 873 条，刷屏训练开发者无视；退役次日 rhi-api 即被存量炸弹引爆（#1165 CI 红），
 * 证明「写法规范 only」管不住存量与漏写。本版按 #1173 的 B1 倾向重生，
 * 收窄策略：只报「ISO 日期与真实时钟共现/交互」的高危组合，纯 fixture 不报。
 *
 * 三层检测（只扫 tests/ 下 *.test.ts / *.spec.ts）：
 *
 * E1 error（v1 主防线原样保留，精度实证 #541/#544 形态）：
 *   日期校验函数（validateCommitDate/validate-commit-date CLI 形态）调用中
 *   硬编码特性 ID（F20YYMMDDxxxx）且未注入 now（第二参数或 --at）。
 *
 * E2 error（v2 新增，#1165 + #1173 三处真炸弹的共同形态）：
 *   快照窗口写入 API（replaceForDate）收到 ISO 日期字面量或绑定到字面量的
 *   变量（const d1 = "2026-08-28"; replaceForDate(d1, ...)）。
 *   被测端（trends/costOutput）用 Date.now() 算窗口起点，字面量滑出窗口后
 *   series 缺日 → 断言炸。窗口 API 白名单见 WINDOW_APIS——宁可窄不可宽，
 *   新形态实证后扩展。
 *
 * W1 warning（it 块共现，不阻断）：
 *   同一 it/test 块内既有非注释 ISO 日期字面量、又有真实时钟调用
 *   （Date.now() / 无参 new Date()）。共现不等于炸弹（mock 内部相对比较、
 *   错误字符串正则、显式 now 注入都安全），但炸弹必然共现——按块粒度收窄
 *   后误报面从 873 条压到 ~20 条，用 CI 基线守恒（W1_BASELINE 只减不增）
 *   管住增量，存量随触碰自然消化。
 *
 * 豁免注释（行内或上一行）：
 *   // date-literal: explicit-now      —— 显式注入 now（v1 语义）
 *   // date-literal: fixture-relative  —— fixture 内部相对比较/错误字符串，不涉真实时钟
 *
 * 用法：
 *   node scripts/lint-date-bombs.mjs [rootDir] [--verbose]
 *   exit 1 当（E1+E2 > 0）或（W1 计数 > W1_BASELINE）
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 特性 ID 日期模式：F + 8 位数字日期 + 4-10 位后缀（v1 原样） */
export const FID_DATE_RE = /F\d{8}[a-z0-9]{4,10}/g;

/** ISO 日期模式：YYYY-MM-DD（202x-209x 年）。不加 \b——后跟 T 时不匹配的坑（v1 教训） */
export const ISO_DATE_RE = /\b20[2-9]\d-[01]\d-[0-3]\d(?=[^\d-]|$)/g;

/** 真实时钟调用：Date.now() 或无参 new Date()（有参的 new Date(x) 是注入，不算） */
export const CLOCK_RE = /Date\.now\(\)|new\s+Date\s*\(\s*\)/;

/** 快照窗口写入 API（E2 面）：日期参数直接决定断言可见性的高危调用 */
const WINDOW_APIS = ['replaceForDate'];

export const EXEMPTION_NOW = '// date-literal: explicit-now';
export const EXEMPTION_RELATIVE = '// date-literal: fixture-relative';
export const EXEMPTIONS = [EXEMPTION_NOW, EXEMPTION_RELATIVE];

/**
 * W1 基线（CI 守恒，只减不增）。
 * 2026-09-29 #1173 清扫后全仓实测值。每次人为消除共现块后手动下调。
 * Why 固化在代码里：CI 无状态，基线必须可执行文件自持。
 */
export const W1_BASELINE = 14;

/**
 * @typedef {Object} ScanResult
 * @property {string} file
 * @property {number} line
 * @property {number} column
 * @property {'feature-id-date' | 'window-api-literal' | 'block-cooccurrence'} pattern
 * @property {'error' | 'warning'} severity
 * @property {string} message
 */

/**
 * @typedef {Object} ScanOptions
 * @property {Array<string | RegExp>} [excludePatterns]
 * @property {string} [rootDir]
 */

/** 从代码行去除行内注释，保留字符串内的 //（如 URL，v1 A3 教训） */
function stripInlineComment(line) {
  let inStr = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
    } else {
      if (ch === "'" || ch === '"' || ch === '`') inStr = ch;
      else if (ch === '/' && line[i + 1] === '/') return line.slice(0, i);
    }
  }
  return line;
}

const isCommentLine = (line) => /^\s*(\/\/|\/\*|\*|\{\/\*)/.test(line);

/** it/test 块切片：返回 [{start, end}]（行号 1-based，含边界）。
 * 简化策略：遇 it(/test( 开新块；块以「缩进 <= it 行缩进的 }); 行」结束。
 * vitest 嵌套闭包内的 it 罕见；误切的后果只是窗口放大（跨块合并）。
 * 开块正则含 .skip/.each/.only 等修饰形态（#1206 检视 S2 探针实证曾漏检）。 */
function sliceItBlocks(lines) {
  const blocks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const codePart = stripInlineComment(line);
    if (!cur) {
      // #1206 检视 S2：it.skip/it.each/it.only 修饰形态必须开块（检视獭探针实证漏检面）
      const m = codePart.match(/^(\s*)(?:it|test)(?:\.(?:skip|only|each|todo|concurrent|sequential))*\s*(?:\(|\[)/);
      if (m && !isCommentLine(line)) {
        cur = { start: i + 1, indent: m[1].length };
      }
    } else {
      const indented = codePart.match(/^(\s*)\}/);
      if (indented && indented[1].length <= cur.indent && /\}\)?\s*;?\s*$/.test(codePart)) {
        cur.end = i + 1;
        blocks.push(cur);
        cur = null;
      }
    }
  }
  if (cur) { cur.end = lines.length; blocks.push(cur); }
  return blocks;
}

/** E1（v1 原样语义）：日期校验函数 + FID + 无 now 注入 */
function analyzeE1(codePart) {
  const fidMatches = [...codePart.matchAll(FID_DATE_RE)];
  if (!fidMatches.length) return [];
  const validationCallRe = /validateCommitDate|validateDate|checkDate|validate-commit-date/i;
  if (!validationCallRe.test(codePart)) return [];
  // CLI 形态 --at 等同 now 注入；函数形态第二参非裸 new Date() 视为注入
  if (/--at/.test(codePart)) return [];
  const callMatch = codePart.match(/validateCommitDate\s*\(([^)]*)\)/);
  if (callMatch) {
    const args = callMatch[1];
    const parts = args.split(',');
    if (parts.length === 1) {
      return fidMatches.map((m) => ({ col: (m.index ?? 0) + 1, fid: m[0] }));
    }
    const nowArg = (parts[1] ?? '').trim();
    if (/^new\s+Date\s*\(/.test(nowArg)) {
      return fidMatches.map((m) => ({ col: (m.index ?? 0) + 1, fid: m[0] }));
    }
  }
  // spawnSync CLI 形态无 --at
  if (/validate-commit-date/.test(codePart)) {
    return fidMatches.map((m) => ({ col: (m.index ?? 0) + 1, fid: m[0] }));
  }
  return [];
}

/** E2：窗口 API 收到 ISO 字面量或字面量绑定变量。
 * 需要块上下文（收集 const X = "ISO" 的绑定）→ 在 scanFile 块级调用。 */
function analyzeE2(lines, startIdx, endIdx) {
  const hits = [];
  // 收集块内绑定到 ISO 字面量的变量名
  const boundVars = new Set();
  for (let i = startIdx; i < endIdx; i++) {
    const codePart = stripInlineComment(lines[i]);
    for (const m of codePart.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(['"`])(20[2-9]\d-[01]\d-[0-3]\d)[^'"`]*\2/g)) {
      boundVars.add(m[1]);
    }
  }
  for (let i = startIdx; i < endIdx; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;
    const codePart = stripInlineComment(line);
    if (hasExemption(lines, i)) continue;
    for (const api of WINDOW_APIS) {
      const callRe = new RegExp(`\\b${api}\\s*\\(`);
      if (!callRe.test(codePart)) continue;
      // 直接字面量：replaceForDate("2026-08-28"
      for (const m of codePart.matchAll(new RegExp(`${api}\\s*\\(\\s*(['"\`])(20[2-9]\\d-[01]\\d-[0-3]\\d)`, 'g'))) {
        hits.push({ line: i + 1, col: (m.index ?? 0) + 1, api, date: m[2] });
      }
      // 绑定变量：replaceForDate(d1
      for (const m of codePart.matchAll(new RegExp(`${api}\\s*\\(\\s*(\\w+)`, 'g'))) {
        if (boundVars.has(m[1])) {
          hits.push({ line: i + 1, col: (m.index ?? 0) + 1, api, date: `<${m[1]} 绑定 ISO 字面量>` });
        }
      }
    }
  }
  return hits;
}

/** 豁免检查：当前行或上一行含任一豁免注释 */
function hasExemption(lines, i) {
  const cur = lines[i];
  const prev = i > 0 ? lines[i - 1] : '';
  return EXEMPTIONS.some((e) => cur.includes(e) || prev.includes(e));
}

export function scanFile(filePath, options = {}) {
  const { excludePatterns = [], rootDir } = options;
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const results = [];
  const relPath = rootDir ? relative(rootDir, filePath) : filePath;
  const blocks = sliceItBlocks(lines);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;
    if (hasExemption(lines, i)) continue;
    const codePart = stripInlineComment(line);

    // E1
    for (const h of analyzeE1(codePart)) {
      results.push({
        file: relPath, line: i + 1, column: h.col, pattern: 'feature-id-date', severity: 'error',
        message: `日期校验函数中硬编码特性 ID 日期 ${h.fid}：未注入固定 now，日期滚动后必然失败。修复：注入固定日期常量或动态生成。豁免：${EXEMPTION_NOW}`,
      });
    }
  }

  // E2（块级，需变量绑定上下文）
  for (const b of blocks) {
    for (const h of analyzeE2(lines, b.start - 1, b.end)) {
      results.push({
        file: relPath, line: h.line, column: h.col, pattern: 'window-api-literal', severity: 'error',
        message: `窗口写入 API ${h.api}(…) 收到硬编码日期 ${h.date}：被测端用真实时钟算窗口，日期滑出后 series 缺日断言炸（#1165/#1173 实证形态）。修复：相对日期构造（new Date(Date.now() - N*86400000)）。豁免：${EXEMPTION_RELATIVE}`,
      });
    }
  }

  // W1：块级共现
  for (const b of blocks) {
    let isoHit = null;
    let clockHit = null;
    for (let i = b.start - 1; i < b.end; i++) {
      const line = lines[i];
      if (isCommentLine(line)) continue;
      if (hasExemption(lines, i)) continue;
      const codePart = stripInlineComment(line);
      const m = codePart.match(/\b20[2-9]\d-[01]\d-[0-3]\d(?=[^\d-]|$)/);
      if (m && !isoHit) isoHit = { line: i + 1, col: (m.index ?? 0) + 1, date: m[0] };
      if (CLOCK_RE.test(codePart) && !clockHit) clockHit = { line: i + 1 };
    }
    if (isoHit && clockHit) {
      results.push({
        file: relPath, line: isoHit.line, column: isoHit.col, pattern: 'block-cooccurrence', severity: 'warning',
        message: `it 块内 ISO 日期 ${isoHit.date}（L${isoHit.line}）与真实时钟调用（L${clockHit.line}）共现：若日期参与与真实时钟的窗口/差值计算则是炸弹（相对构造/显式注入可消）。确认安全可豁免：${EXEMPTION_RELATIVE}`,
      });
    }
  }

  return results.filter(
    (r) => !excludePatterns.some((p) => {
      const re = typeof p === 'string' ? new RegExp(p) : p;
      return re.test(r.file + ':' + r.line);
    }),
  );
}

function walkSync(dir, filterFn) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (['node_modules', 'dist', '.git', '.otter'].includes(entry)) continue;
        results.push(...walkSync(full, filterFn));
      } else if (filterFn(full)) {
        results.push(full);
      }
    } catch { /* 断链 symlink 跳过 */ }
  }
  return results;
}

const isTestFile = (f) => /\.(test|spec)\.(ts|mts|js|mjs)$/.test(f);

export function scanProject(rootDir, options = {}) {
  const testsDir = join(rootDir, 'tests');
  const allResults = [];
  // who watches the watchers：扫描器自身测试含预期危险模式（负向用例），排除
  const defaultExclude = [/lint-date-bombs\.test\.ts/];
  const mergedExclude = [...defaultExclude, ...(options.excludePatterns || [])];
  try {
    for (const f of walkSync(testsDir, isTestFile)) {
      allResults.push(...scanFile(f, { ...options, rootDir, excludePatterns: mergedExclude }));
    }
  } catch { /* tests/ 不存在则跳过 */ }
  return {
    errors: allResults.filter((r) => r.severity === 'error'),
    warnings: allResults.filter((r) => r.severity === 'warning'),
  };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const rootDir = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : process.cwd());
  const verbose = process.argv.includes('--verbose');
  const { errors, warnings } = scanProject(rootDir);

  if (verbose) {
    for (const w of warnings) console.warn(`⚠ warning: ${w.file}:${w.line}:${w.column} [${w.pattern}] ${w.message}`);
  }
  for (const e of errors) console.error(`✖ error: ${e.file}:${e.line}:${e.column} [${e.pattern}] ${e.message}`);

  let failed = false;
  if (errors.length > 0) {
    console.error(`\n${errors.length} 个日期炸弹（E1 校验函数 / E2 窗口 API 形态）。修复或按注释豁免。`);
    failed = true;
  }
  if (warnings.length > W1_BASELINE) {
    console.error(`\n共现 warning ${warnings.length} 条 > 基线 ${W1_BASELINE}（只减不增纪律，#1173）。两条出路：①确认为炸弹 → 改相对日期构造消除共现；②确认安全（fixture 内部相对/错误字符串/显式注入）→ 块内加豁免注释 ${EXEMPTION_RELATIVE}。消除后手动下调脚本内 W1_BASELINE。`);
    failed = true;
  }
  if (!failed && warnings.length > 0 && verbose) {
    console.warn(`\n${warnings.length} 条共现 warning（≤ 基线 ${W1_BASELINE}，不阻断）。`);
  }
  process.exit(failed ? 1 : 0);
}
