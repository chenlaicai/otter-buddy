/**
 * F20260915dabm: lint-date-bombs.mjs 的持久化测试。
 *
 * Why: 所有用例用 temp 文件做 fixture，避免扫描自身触发误报。
 * 测试中的特性 ID 日期仅为字符串 fixture，不用于时间敏感断言。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scanFile, scanProject, FID_DATE_RE, EXEMPTION_COMMENT } from '../../scripts/lint-date-bombs.mjs';
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

describe('scanFile', () => {
  describe('日期校验函数中硬编码 FID 且无 now 注入', () => {
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

    it('应检出多个不安全调用', () => {
      const results = scanFixture(
        'tests/multi-bad.test.ts',
        `const a = validateCommitDate('[F20260818abcd]...');\n`
        + `const b = validateCommitDate('[F20260825abcd]...');\n`,
      );
      const errors = results.filter((r) => r.severity === 'error');
      expect(errors).toHaveLength(2);
    });

    it('不应检出有固定 now 注入的 validateCommitDate', () => {
      const results = scanFixture(
        'tests/safe.test.ts',
        `const NOW = new Date('2026-08-25T12:00:00+08:00');\n`
        + `const result = validateCommitDate('[F20260825abcd][agent][Feature Update] test', NOW);\n`,
      );
      const errors = results.filter((r) => r.severity === 'error');
      expect(errors).toHaveLength(0);
    });

    it('不应检出有变量 now 注入的 validateCommitDate', () => {
      const results = scanFixture(
        'tests/safe-var.test.ts',
        `const baseTime = someSetup();\n`
        + `const result = validateCommitDate('[F20260825abcd]...', baseTime);\n`,
      );
      const errors = results.filter((r) => r.severity === 'error');
      expect(errors).toHaveLength(0);
    });
  });

  describe('FID 在非日期校验上下文中不检出', () => {
    it('describe 标签中的 FID 不应报错', () => {
      const results = scanFixture(
        'tests/describe-label.test.ts',
        `describe('F20260825dva2: some test', () => {\n`
        + `  it('should work', () => {});\n`
        + `});\n`,
      );
      const errors = results.filter((r) => r.severity === 'error');
      expect(errors).toHaveLength(0);
    });

    it('字符串字面量中的 FID（非校验函数）不应报错', () => {
      const results = scanFixture(
        'tests/string-literal.test.ts',
        `const otterName = 'F20260825vrqh';\n`
        + `const otterId = 'F20260805rsto';\n`,
      );
      const errors = results.filter((r) => r.severity === 'error');
      expect(errors).toHaveLength(0);
    });
  });

  describe('豁免注释', () => {
    it('当前行有豁免注释应跳过', () => {
      const results = scanFixture(
        'tests/exempt-inline.test.ts',
        `const result = validateCommitDate('[F20260825abcd]...'); ${EXEMPTION_COMMENT}\n`,
      );
      const errors = results.filter((r) => r.severity === 'error');
      expect(errors).toHaveLength(0);
    });

    it('上一行有豁免注释应跳过', () => {
      const results = scanFixture(
        'tests/exempt-above.test.ts',
        `${EXEMPTION_COMMENT}\n`
        + `const result = validateCommitDate('[F20260825abcd]...');\n`,
      );
      const errors = results.filter((r) => r.severity === 'error');
      expect(errors).toHaveLength(0);
    });
  });

  describe('注释行中的 FID 不检出', () => {
    it('行注释中的 FID 不报错', () => {
      const results = scanFixture(
        'tests/line-comment.test.ts',
        `const x = 1; // F20260825dva2: some note\n`,
      );
      const errors = results.filter((r) => r.severity === 'error');
      expect(errors).toHaveLength(0);
    });

    it('块注释中的 FID 不报错', () => {
      const results = scanFixture(
        'tests/block-comment.test.ts',
        `/**\n`
        + ` * F20260825dva2: validate-commit-date test.\n`
        + ` */\n`
        + `describe('test', () => {});\n`,
      );
      const errors = results.filter((r) => r.severity === 'error');
      expect(errors).toHaveLength(0);
    });
  });

  describe('ISO 日期警告', () => {
    it('应 warning 级检出 tests/ 中的 ISO 日期', () => {
      const results = scanFixture(
        'tests/iso.test.ts',
        `const fixture = { createdAt: "2026-01-01T00:00:00Z" };\n`,
      );
      const warnings = results.filter((r) => r.severity === 'warning');
      expect(warnings).toHaveLength(1);
      expect(warnings[0].pattern).toBe('iso-date');
    });

    it('ISO 日期豁免注释生效', () => {
      const results = scanFixture(
        'tests/iso-exempt.test.ts',
        `const d = "2026-01-01"; ${EXEMPTION_COMMENT}\n`,
      );
      expect(results).toHaveLength(0);
    });
  });

  describe('S2: CLI 集成形态检测（#541 原始炸弹形态）', () => {
    it('应检出 spawnSync CLI 调用中的硬编码 FID（#541 原始形态）', () => {
      const results = scanFixture(
        'tests/cli-bomb.test.ts',
        `const { exitCode } = runCLI(['scripts/validate-commit-date.mjs', '[F20260825abcd]...']);\n`,
      );
      const errors = results.filter((r) => r.severity === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('F20260825abcd');
    });

    it('不应检出有 --at 注入的 CLI 调用', () => {
      const results = scanFixture(
        'tests/cli-safe.test.ts',
        `const { exitCode } = runCLI(['--at', '2026-09-04T03:56:11Z', 'scripts/validate-commit-date.mjs', '[F20260904wxeg]...']);\n`,
      );
      const errors = results.filter((r) => r.severity === 'error');
      expect(errors).toHaveLength(0);
    });
  });

  describe('A3: 字符串内 // 不误剥离', () => {
    it('URL 中的 // 不应被误切', () => {
      const results = scanFixture(
        'tests/url-in-string.test.ts',
        `const url = 'https://example.com';\n`,
      );
      expect(results).toHaveLength(0);
    });
  });

  describe('边界情况', () => {
    it('空文件不应报错', () => {
      const results = scanFixture('tests/empty.test.ts', '');
      expect(results).toHaveLength(0);
    });

    it('只有注释的文件不应报错', () => {
      const results = scanFixture(
        'tests/comments-only.test.ts',
        `// F20260825dva2: comment\n/* F20260818abcd */\n`,
      );
      expect(results).toHaveLength(0);
    });

    it('动态日期生成不应检出', () => {
      const results = scanFixture(
        'tests/dynamic.test.ts',
        `const ymd = (d: Date) => \`\${d.getFullYear()}...\`;\n`
        + `const id = \`[F\${ymd(new Date())}abcd]\`;\n`
        + `const result = validateCommitDate(id);\n`,
      );
      // validateCommitDate(id) 中 id 不含硬编码 FID → 不检出
      const errors = results.filter((r) => r.severity === 'error');
      expect(errors).toHaveLength(0);
    });
  });
});

describe('scanProject', () => {
  it('应检出 tests/ 下日期校验中的日期炸弹', () => {
    const testsDir = join(tempDir, 'tests');
    mkdirSync(testsDir, { recursive: true });
    writeFileSync(
      join(testsDir, 'bad.test.ts'),
      `const x = validateCommitDate('[F20260825abcd] test');\n`,
    );

    const { errors } = scanProject(tempDir);
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toMatch(/tests\/bad\.test\.ts/);
  });

  it('空项目不应报错', () => {
    mkdirSync(join(tempDir, 'tests'), { recursive: true });
    const { errors } = scanProject(tempDir);
    expect(errors).toHaveLength(0);
  });

  it('不应扫描 node_modules', () => {
    mkdirSync(join(tempDir, 'tests', 'node_modules'), { recursive: true });
    writeFileSync(
      join(tempDir, 'tests', 'node_modules', 'bad.test.ts'),
      `const x = validateCommitDate('[F20260825abcd] test');\n`,
    );
    mkdirSync(join(tempDir, 'tests'), { recursive: true });

    const { errors } = scanProject(tempDir);
    expect(errors).toHaveLength(0);
  });
});

describe('FID_DATE_RE 正则', () => {
  it('应匹配完整特性 ID 格式', () => {
    expect('F20260825abcd'.match(FID_DATE_RE)).toHaveLength(1);
    expect('F20260825abcd1234'.match(FID_DATE_RE)).toHaveLength(1);
  });

  it('不应匹配后缀不足 4 位的', () => {
    expect('F20260825abc'.match(FID_DATE_RE)).toBeNull();
    expect('F20260825ab'.match(FID_DATE_RE)).toBeNull();
  });

  it('不应匹配非 F 前缀', () => {
    expect('R20260825abcd'.match(FID_DATE_RE)).toBeNull();
    expect('20260825abcd'.match(FID_DATE_RE)).toBeNull();
  });
});
