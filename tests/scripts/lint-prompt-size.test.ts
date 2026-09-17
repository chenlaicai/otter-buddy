import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * F20260917pbgg: prompt 体积预算闸 lint 的行为测试（issue #1030 层A）。
 * 子进程方式跑真脚本（与 lint-date-bombs.test.ts 同模式），验证三个语义：
 * 1. 超预算 exit 1 + 报文件名
 * 2. 预算内 exit 0；触警告线打警告
 * 3. per-file budget_bytes override 生效
 */

const script = path.resolve(__dirname, '../../scripts/lint-prompt-size.mjs');

function runLint(dir: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('node', [script, '--dir', dir], { encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 生成 body 为指定字节数的模板（frontmatter 会被 lint 剥离不计入） */
function makeTemplate(bytes: number, frontmatter = 'task_name: t'): string {
  const body = 'x'.repeat(bytes);
  return `---\n${frontmatter}\n---\n${body}`;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-size-lint-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('#1030 prompt 体积预算闸', () => {
  it('超预算：exit 1 且输出文件名与字节数', () => {
    fs.writeFileSync(path.join(tmpDir, 'big.md'), makeTemplate(12000));
    const r = runLint(tmpDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('big.md');
    expect(r.stderr).toContain('12000B');
    expect(r.stderr).toContain('超预算');
  });

  it('预算内：exit 0；触警告线（>8000B）输出警告但不阻断', () => {
    fs.writeFileSync(path.join(tmpDir, 'warn.md'), makeTemplate(9000));
    const r = runLint(tmpDir);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('⚠');
    expect(r.stderr).toContain('警告线');
  });

  it('frontmatter 不计入体积（与 DB body 口径一致）', () => {
    // body 5000B + frontmatter 6000B：body 未超预算必须通过
    fs.writeFileSync(path.join(tmpDir, 'fm.md'), `---\ntask_name: ${'y'.repeat(6000)}\n---\n${'x'.repeat(5000)}`);
    const r = runLint(tmpDir);
    expect(r.code).toBe(0);
  });

  it('per-file budget_bytes override：显式声明更高预算则放行', () => {
    fs.writeFileSync(path.join(tmpDir, 'override.md'), makeTemplate(12000, 'budget_bytes: 13000\n'));
    const r = runLint(tmpDir);
    expect(r.code).toBe(0);
  });

  it('目录不可读：exit 2（不静默跳过）', () => {
    const r = runLint(path.join(tmpDir, 'not-exist'));
    expect(r.code).toBe(2);
  });
});
