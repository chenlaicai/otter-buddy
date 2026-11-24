import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * prompt 体积预算闸 lint 的行为测试（层A）。
 * 子进程方式跑真脚本，验证三个语义：
 * 1. 超预算 exit 1 + 报文件名
 * 2. 预算内 exit 0；触警告线打警告
 * 3. per-file budget_bytes override 生效
 */

const script = path.resolve(__dirname, '../../scripts/lint-prompt-size.mjs');

const repoRoot = path.resolve(__dirname, '../..');

function runLint(dir: string, coreRoot?: string): { code: number; stdout: string; stderr: string } {
  const args = [script, '--dir', dir];
  if (coreRoot) args.push('--core-root', coreRoot);
  const r = spawnSync('node', args, { encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function copyCorePrompts(destination: string): void {
  for (const relativePath of ['.pi/SYSTEM.md', 'prompts/identity/BIG_OTTER.md', 'prompts/identity/SMALL_OTTER.md']) {
    const target = path.join(destination, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, relativePath), target);
  }
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

describe('M3 核心 prompt 协议与只降 ratchet', () => {
  it('旧 SMALL 的 body <signal> 指令会被拒绝', () => {
    const coreRoot = path.join(tmpDir, 'core');
    copyCorePrompts(coreRoot);
    fs.writeFileSync(path.join(coreRoot, 'prompts/identity/SMALL_OTTER.md'), [
      '对派工有异议时，用结构化 `<signal>` 嵌在 speak body 里：',
      '- `<signal type="objection" severity="high">正文必须含 file:line</signal>`',
      '- `<signal type="blocked" severity="medium">正文必须附已试清单</signal>`',
    ].join('\n'));

    const r = runLint(tmpDir, coreRoot);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('SMALL_OTTER.md');
    expect(r.stderr).toContain('body');
    expect(r.stderr).toContain('<signal>');
  });

  it('真实核心 prompt 与 speak.signal 结构化参数定义通过一致性检查', () => {
    const r = runLint(tmpDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('speak.signal 结构化参数：通过');
    expect(r.stdout).toContain('核心 prompt：3 个文件');
  });

  it.each(['.pi/SYSTEM.md', 'prompts/identity/BIG_OTTER.md', 'prompts/identity/SMALL_OTTER.md'])(
    '核心文件超只降 ratchet 会失败：%s',
    (relativePath) => {
      const coreRoot = path.join(tmpDir, 'core');
      copyCorePrompts(coreRoot);
      fs.appendFileSync(path.join(coreRoot, relativePath), 'x');

      const r = runLint(tmpDir, coreRoot);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(relativePath);
      expect(r.stderr).toContain('超 ratchet');
    },
  );
});
