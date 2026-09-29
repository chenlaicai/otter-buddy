/**
 * #1173 / F20260929dbmb: lint-date-bombs.mjs（收窄版 v2）的持久化测试。
 *
 * Why: 所有用例用 temp 文件做 fixture，避免扫描自身触发误报。
 * 测试中的 ISO 日期与特性 ID 日期仅为字符串 fixture，不用于时间敏感断言
 * ——本文件在扫描器默认排除清单（who watches the watchers）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scanFile, scanProject, W1_BASELINE } from '../../scripts/lint-date-bombs.mjs';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'date-bomb-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** 写临时文件并扫描 */
function scanFixture(relPath: string, content: string) {
  const absPath = join(tempDir, relPath);
  mkdirSync(join(absPath, '..'), { recursive: true });
  writeFileSync(absPath, content, 'utf-8');
  return scanFile(absPath, { rootDir: tempDir });
}

describe('E1：日期校验函数 + FID + 无 now 注入（v1 主防线原样保留）', () => {
  it('应检出 validateCommitDate 无 now 参数的硬编码 FID', () => {
    const results = scanFixture(
      'tests/bad.test.ts',
      `const result = validateCommitDate('[F20260825abcd][agent][Feature Update] test');\n`,
    );
    const errors = results.filter((r) => r.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].pattern).toBe('feature-id-date');
    expect(errors[0].message).toContain('F20260825abcd');
  });

  it('应检出 validateCommitDate(new Date()) 的硬编码 FID', () => {
    const results = scanFixture(
      'tests/bad-newdate.test.ts',
      `const result = validateCommitDate('[F20260825abcd]...', new Date());\n`,
    );
    const errors = results.filter((r) => r.severity === 'error');
    expect(errors).toHaveLength(1);
  });

  it('安全形态不检出：显式 now 常量注入', () => {
    const results = scanFixture(
      'tests/safe-now.test.ts',
      `const NOW = new Date('2026-01-01T00:00:00Z');\n`
      + `const result = validateCommitDate('[F20260825abcd]...', NOW);\n`,
    );
    expect(results.filter((r) => r.severity === 'error')).toHaveLength(0);
  });

  it('安全形态不检出：CLI --at 注入（validate-commit-date 脚本形态）', () => {
    const results = scanFixture(
      'tests/safe-cli.test.ts',
      `const { exitCode } = runCLI(['--at', '2026-09-04T03:56:11Z', '[F20260825abcd]']);\n`,
    );
    expect(results.filter((r) => r.severity === 'error')).toHaveLength(0);
  });
});

describe('E2：窗口写入 API 收到 ISO 字面量 / 字面量绑定变量（v2 新增）', () => {
  it('应检出 replaceForDate 直接收字面量（#1165 rhi-api trends 原始形态）', () => {
    const results = scanFixture(
      'tests/window-literal.test.ts',
      `it('trends', () => {\n`
      + `  snapshotRepo.replaceForDate("2026-08-26", [{ snapshotDate: "2026-08-26" }]);\n`
      + `});\n`,
    );
    const errors = results.filter((r) => r.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].pattern).toBe('window-api-literal');
  });

  it('应检出绑定到字面量的变量（#1173 invokeStats 形态：const d1 = "2026-09-12"）', () => {
    const results = scanFixture(
      'tests/window-bound-var.test.ts',
      `it('invokeStats', () => {\n`
      + `  const d1 = "2026-09-12";\n`
      + `  const d2 = "2026-09-13";\n`
      + `  snapshotRepo.replaceForDate(d1, rows(d1));\n`
      + `  snapshotRepo.replaceForDate(d2, rows(d2));\n`
      + `});\n`,
    );
    const errors = results.filter((r) => r.severity === 'error');
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.pattern === 'window-api-literal')).toBe(true);
  });

  it('相对日期构造不检出（修复后形态：new Date(Date.now() - N*86400000)）', () => {
    const results = scanFixture(
      'tests/window-relative.test.ts',
      `it('trends', () => {\n`
      + `  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);\n`
      + `  snapshotRepo.replaceForDate(dayAgo, [{ snapshotDate: dayAgo }]);\n`
      + `});\n`,
    );
    expect(results.filter((r) => r.severity === 'error')).toHaveLength(0);
  });

  it('fixture-relative 豁免注释抑制 E2（上一行豁免）', () => {
    const results = scanFixture(
      'tests/window-exempt.test.ts',
      `it('cross-day', () => {\n`
      + `  // date-literal: fixture-relative\n`
      + `  snapshotRepo.replaceForDate("2026-08-24", rows("2026-08-24", 0.2));\n`
      + `});\n`,
    );
    expect(results.filter((r) => r.severity === 'error')).toHaveLength(0);
  });
});

describe('W1：it 块内 ISO 日期与真实时钟共现（warning 级）', () => {
  it('共现检出：块内既有 ISO 字面量又有 Date.now()', () => {
    const results = scanFixture(
      'tests/cooccur.test.ts',
      `it('mixed', () => {\n`
      + `  const today = new Date().toISOString().slice(0, 10);\n`
      + `  const d = "2026-08-28";\n`
      + `  expect(d).toBeTruthy();\n`
      + `});\n`,
    );
    const warnings = results.filter((r) => r.pattern === 'block-cooccurrence');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe('warning');
  });

  it('纯 fixture 块不报：ISO 无真实时钟共现', () => {
    const results = scanFixture(
      'tests/pure-fixture.test.ts',
      `it('pure', () => {\n`
      + `  const d1 = "2026-08-24";\n`
      + `  const d2 = "2026-08-25";\n`
      + `  expect(d2 > d1).toBe(true);\n`
      + `});\n`,
    );
    expect(results.filter((r) => r.pattern === 'block-cooccurrence')).toHaveLength(0);
  });

  it('注释行与豁免行不计入共现', () => {
    const results = scanFixture(
      'tests/comment-only.test.ts',
      `it('comments', () => {\n`
      + `  // 说明：2026-08-28 是旧日期\n`
      + `  const today = new Date().toISOString();\n`
      + `  expect(today).toBeTruthy();\n`
      + `});\n`,
    );
    expect(results.filter((r) => r.pattern === 'block-cooccurrence')).toHaveLength(0);
  });
});

describe('修饰块开块（#1206 检视 S2 回归锚）', () => {
  it('it.each 块内 E2 形态必须检出', () => {
    const results = scanFixture(
      'tests/each-block.test.ts',
      `it.each([\n`
      + `  ['case1'],\n`
      + `])('window %s', () => {\n`
      + `  snapshotRepo.replaceForDate('2026-08-26', [{ snapshotDate: '2026-08-26' }]);\n`
      + `});\n`,
    );
    expect(results.filter((r) => r.pattern === 'window-api-literal')).toHaveLength(1);
  });

  it('it.skip 块内 W1 共现必须检出', () => {
    const results = scanFixture(
      'tests/skip-block.test.ts',
      `it.skip('mixed', () => {\n`
      + `  const today = new Date().toISOString();\n`
      + `  const d = '2026-08-28';\n`
      + `  expect(d).toBeTruthy();\n`
      + `});\n`,
    );
    expect(results.filter((r) => r.pattern === 'block-cooccurrence')).toHaveLength(1);
  });
});

describe('扫描器自身约定', () => {
  it('W1_BASELINE 是非负整数且当前告警面不超基线', () => {
    expect(Number.isInteger(W1_BASELINE)).toBe(true);
    expect(W1_BASELINE).toBeGreaterThanOrEqual(0);
    // 本仓 tests/ 实测面（v2 上线时 12 条）
    const r = scanProject(process.cwd());
    expect(r.warnings.length).toBeLessThanOrEqual(W1_BASELINE);
  });
});
