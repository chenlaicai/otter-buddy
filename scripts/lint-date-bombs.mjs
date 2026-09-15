#!/usr/bin/env node
/**
 * F20260915dabm: 测试日期炸弹静态扫描（commit-time gate）。
 *
 * 问题：时间敏感测试硬编码特性 ID 日期（如 F20260825abcd），
 * 编写时绿（在 ±7 天容忍窗内），日期滚动后必然 CI 红——
 * #422→#541 两次炸弹无防线兜底。
 *
 * 方案：commit-time 静态扫描，tests/ 下命中即 fail，提示改动态生成。
 * 豁免机制：`// date-literal: explicit-now` 表示显式传 now 参数的断言场景。
 *
 * 与 scripts/validate-commit-date.mjs（#442，commit 日期校验）同属
 * 「日期语义防线」族：前者拦截「写入侧」（commit message 日期偏差），
 * 本脚本拦截「存量侧」（测试代码硬编码日期字面量）。
 *
 * ## 扫描策略
 *
 * 不是所有特性 ID（F20YYMMDDxxxx）都是日期炸弹——大部分只是测试数据
 * 字符串（otter 名、describe 标签）。真正的日期炸弹是：特性 ID 日期
 * 被传入 validateCommitDate() 等日期校验函数且未注入固定 now 参数，
 * 导致校验依赖系统时钟，日期滚动后必然失败。
 *
 * 主防线：检测 validateCommitDate / validate-date 相关调用中使用
 *         硬编码 FID 且未显式注入 now 参数的模式
 * 辅助：ISO 日期在测试中的使用（warning 级，不阻断）
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 特性 ID 日期模式：F + 8 位数字日期 + 4-10 位后缀。
 * 精确匹配 F\d{8}[a-z0-9]{4,10}——只捕获完整特性 ID。
 */
export const FID_DATE_RE = /F\d{8}[a-z0-9]{4,10}/g;

/**
 * ISO 日期模式：YYYY-MM-DD（仅 202x 年）。
 * Why: 不加 \b 后缀——`2026-01-01T00:00:00Z` 中日期后紧跟 T，\b 不匹配。
 */
export const ISO_DATE_RE = /\b20[2-9]\d-[01]\d-[0-3]\d(?=[^\d-]|$)/g;

export const EXEMPTION_COMMENT = '// date-literal: explicit-now';

/**
 * 判断一行代码是否包含「日期校验函数调用 + 硬编码 FID + 无 now 注入」。
 *
 * 识别的危险模式：
 *   validateCommitDate('[F20260825abcd]...')          — 无 now 参数
 *   validateCommitDate('[F20260825abcd]...', new Date()) — now 依赖系统时钟
 *
 * 安全模式（不触发）：
 *   validateCommitDate('[F20260825abcd]...', NOW)      — 有固定 now 注入
 *   validateCommitDate('[F20260825abcd]...', someDate)  — 有变量 now 注入
 *
 * @param {string} codePart - 行内注释去除后的代码部分
 * @returns {{ hasFid: boolean, hasValidationCall: boolean, hasUnsafeNow: boolean, fidMatches: RegExpMatchArray[] }}
 */
function analyzeLine(codePart) {
  const fidMatches = [...codePart.matchAll(FID_DATE_RE)];
  const hasFid = fidMatches.length > 0;

  // 日期校验函数调用模式
  const validationCallRe = /validateCommitDate|validateDate|checkDate/i;
  const hasValidationCall = validationCallRe.test(codePart);

  // 判断 now 参数是否不安全：
  // - 无第二参数 → 不安全（依赖默认 new Date()）
  // - 第二参数是 new Date() → 不安全（依赖系统时钟）
  // - 第二参数是常量/变量 → 安全
  let hasUnsafeNow = false;
  if (hasValidationCall) {
    // 提取括号内容：validateCommitDate(... , ...) 或 validateCommitDate(...)
    const callMatch = codePart.match(
      /validateCommitDate\s*\(([^)]*)\)/,
    );
    if (callMatch) {
      const args = callMatch[1];
      const argParts = splitArgs(args);
      if (argParts.length === 1) {
        // 只有一个参数 → 无 now 注入 → 不安全
        hasUnsafeNow = true;
      } else if (argParts.length >= 2) {
        const nowArg = argParts[1].trim();
        // new Date() 或 new Date 作为 now → 不安全
        if (/^new\s+Date\s*\(/.test(nowArg)) {
          hasUnsafeNow = true;
        }
        // NOW / now / currentDate 等常量 → 安全
        // 其他变量 → 安全（假设是有意注入）
      }
    }
  }

  return { hasFid, hasValidationCall, hasUnsafeNow, fidMatches };
}

/**
 * 简单的括号感知参数分割（不处理嵌套括号，足够覆盖 validateCommitDate 的调用场景）。
 * @param {string} argsStr
 * @returns {string[]}
 */
function splitArgs(argsStr) {
  const args = [];
  let depth = 0;
  let current = '';
  for (const ch of argsStr) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      args.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) args.push(current);
  return args;
}

/**
 * 扫描文件内容，返回日期炸弹列表。
 *
 * @param {string} filePath - 文件绝对路径
 * @param {object} [options]
 * @param {string[]} [options.excludePatterns] - 排除模式列表（每条正则字符串）
 * @param {string} [options.rootDir] - 根目录（用于相对路径显示）
 * @returns {{ file: string, line: number, column: number, pattern: string, severity: string, message: string }[]}
 */
export function scanFile(filePath, options = {}) {
  const { excludePatterns = [], rootDir } = options;
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const results = [];
  const relPath = rootDir ? relative(rootDir, filePath) : filePath;

  const isTestFile = filePath.includes('/tests/') || filePath.includes('/test/');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // 豁免检查：当前行或上一行含豁免注释则跳过
    const prevLine = i > 0 ? lines[i - 1] : '';
    const hasExemption =
      line.includes(EXEMPTION_COMMENT) || prevLine.includes(EXEMPTION_COMMENT);
    if (hasExemption) continue;

    // 跳过注释行：行注释、块注释（/*、*/、* 开头）
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;

    // 去除行内注释后扫描
    const codePart = line.split('//')[0];

    if (isTestFile) {
      // === 主防线：日期校验函数调用中硬编码 FID 且无安全 now 注入 ===
      const analysis = analyzeLine(codePart);
      if (analysis.hasFid && analysis.hasValidationCall && analysis.hasUnsafeNow) {
        for (const m of analysis.fidMatches) {
          results.push({
            file: relPath,
            line: lineNum,
            column: (m.index ?? 0) + 1,
            pattern: 'feature-id-date',
            severity: 'error',
            message: `日期校验函数中硬编码特性 ID 日期 ${m[0]}：`
              + ` 未注入固定 now 参数，日期滚动后测试必然失败。`
              + ` 修复：注入固定日期常量（如 NOW）或改用动态生成。`
              + ` 豁免：在代码行或上一行添加 ${EXEMPTION_COMMENT}`,
          });
        }
      }

      // === 辅助：ISO 日期使用（warning 级）===
      for (const m of codePart.matchAll(ISO_DATE_RE)) {
        results.push({
          file: relPath,
          line: lineNum,
          column: (m.index ?? 0) + 1,
          pattern: 'iso-date',
          severity: 'warning',
          message: `测试代码中硬编码 ISO 日期 ${m[0]}：`
            + ` 若用于时间敏感断言，日期滚动后将失效。`
            + ` 豁免：在代码行或上一行添加 ${EXEMPTION_COMMENT}`,
        });
      }
    }
  }

  // 应用排除模式（支持 RegExp 对象和字符串）
  return results.filter(
    (r) => !excludePatterns.some((p) => {
      const re = typeof p === 'string' ? new RegExp(p) : p;
      return re.test(r.file + ':' + r.line);
    }),
  );
}

/**
 * 递归遍历目录，返回文件列表。
 */
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
    } catch {
      // 跳过无法读取的文件（如断链 symlink）
    }
  }
  return results;
}

const isTestFile = (f) => /\.(test|spec)\.(ts|mts|js|mjs)$/.test(f);

/**
 * 扫描整个项目，返回按 severity 分组的结果。
 *
 * @param {string} rootDir - 项目根目录
 * @param {object} [options]
 * @param {string[]} [options.excludePatterns] - 排除模式列表
 * @returns {{ errors: object[], warnings: object[] }}
 */
export function scanProject(rootDir, options = {}) {
  const testsDir = join(rootDir, 'tests');
  const allResults = [];

  // Why: 扫描器自身的测试文件包含预期的危险模式（负向用例），
  // 不应被自己检出——经典 "who watches the watchers" 排除。
  const defaultExclude = [/lint-date-bombs\.test\.ts/];
  const mergedExclude = [...defaultExclude, ...(options.excludePatterns || [])];

  try {
    const files = walkSync(testsDir, isTestFile);
    for (const f of files) {
      allResults.push(...scanFile(f, { ...options, rootDir, excludePatterns: mergedExclude }));
    }
  } catch {
    // tests/ 目录不存在则跳过
  }

  return {
    errors: allResults.filter((r) => r.severity === 'error'),
    warnings: allResults.filter((r) => r.severity === 'warning'),
  };
}

// CLI 入口
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const rootDir = resolve(process.argv[2] || process.cwd());
  const { errors, warnings } = scanProject(rootDir);

  for (const w of warnings) {
    console.warn(`⚠ warning: ${w.file}:${w.line}:${w.column} [${w.pattern}] ${w.message}`);
  }
  for (const e of errors) {
    console.error(`✖ error: ${e.file}:${e.line}:${e.column} [${e.pattern}] ${e.message}`);
  }

  if (errors.length > 0) {
    console.error(
      `\n${errors.length} 个日期炸弹（测试中日期校验函数使用硬编码特性 ID 且未注入 now）。\n`
      + '修复：注入固定日期常量或改用动态生成。\n'
      + `豁免：在代码行或上一行添加 ${EXEMPTION_COMMENT}`,
    );
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn(`\n${warnings.length} 个日期字面量警告（ISO 日期，不阻断）。`);
  }

  process.exit(0);
}
