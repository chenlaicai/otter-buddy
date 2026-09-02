/**
 * F20260902wh68: ensure-hooks.mjs 的持久化测试（issue #684 防回归）。
 *
 * 用真实临时 git 仓库验证脚本行为，覆盖 issue #684 的全部现场：
 * - 健康/失效（.husky/_ 残留、绝对路径覆盖、未配置、钩子不可执行）判定
 * - --check 只读模式 fail-closed
 * - worktree 场景：repo config 共享，任一 worktree 内修复全局生效
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/ensure-hooks.mjs');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runScript(args: string[], cwd: string): RunResult {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf-8', cwd });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: any) {
    return { exitCode: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { encoding: 'utf-8', cwd }).trim();
}

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-hooks-test-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 建一个带可用 .githooks/commit-msg 的真实仓库，返回仓库根。 */
function initFixtureRepo(name: string): string {
  const root = path.join(tmpDir, name);
  fs.mkdirSync(root, { recursive: true });
  git(['init', '-b', 'main', '.'], root);
  git(['config', 'user.email', 'test@test.local'], root);
  git(['config', 'user.name', 'test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  fs.mkdirSync(path.join(root, '.githooks'), { recursive: true });
  const hook = path.join(root, '.githooks', 'commit-msg');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(hook, 0o755);
  // 模拟 npm prepare 后的健康态
  git(['config', 'core.hooksPath', '.githooks'], root);
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(['add', '.'], root);
  git(['commit', '-m', '[F20260902abcd][test][Feature Update] 初始化夹具仓库'], root);
  return root;
}

function getHooksPath(root: string): string | null {
  try {
    return git(['config', '--get', 'core.hooksPath'], root);
  } catch {
    return null;
  }
}

describe('ensure-hooks.mjs（issue #684 防回归）', () => {
  it('健康仓库：--check 通过且不改写配置', () => {
    const root = initFixtureRepo('healthy');
    const before = getHooksPath(root);
    const result = runScript(['--check'], root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('✓');
    expect(getHooksPath(root)).toBe(before);
  });

  it('worktree 残留现场（.husky/_）：--check 报失效，fix 写回 .githooks', () => {
    const root = initFixtureRepo('husky-residue');
    git(['config', 'core.hooksPath', '.husky/_'], root);
    const check = runScript(['--check'], root);
    expect(check.exitCode).toBe(1);
    expect(check.stderr).toContain('.husky/_');

    const fix = runScript([], root);
    expect(fix.exitCode).toBe(0);
    expect(fix.stdout).toContain('已自愈');
    expect(getHooksPath(root)).toBe('.githooks');
  });

  it('绝对路径覆盖现场（F20260821kgts）：被判失效并自愈', () => {
    const root = initFixtureRepo('abs-override');
    git(['config', 'core.hooksPath', '/tmp/some-external-tool-hooks'], root);
    expect(runScript(['--check'], root).exitCode).toBe(1);
    expect(runScript([], root).exitCode).toBe(0);
    expect(getHooksPath(root)).toBe('.githooks');
  });

  it('未配置 core.hooksPath：fix 补写 .githooks', () => {
    const root = initFixtureRepo('unset');
    try { git(['config', '--unset', 'core.hooksPath'], root); } catch { /* 键本就不存在 */ }
    expect(runScript(['--check'], root).exitCode).toBe(1);
    expect(runScript([], root).exitCode).toBe(0);
    expect(getHooksPath(root)).toBe('.githooks');
  });

  it('钩子目录存在但 commit-msg 不可执行：判失效（fail-closed）', () => {
    const root = initFixtureRepo('non-exec');
    fs.mkdirSync(path.join(root, 'fake-hooks'), { recursive: true });
    const hook = path.join(root, 'fake-hooks', 'commit-msg');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(hook, 0o644);
    git(['config', 'core.hooksPath', 'fake-hooks'], root);
    expect(runScript(['--check'], root).exitCode).toBe(1);
    expect(runScript([], root).exitCode).toBe(0);
    expect(getHooksPath(root)).toBe('.githooks');
  });

  it('worktree 场景：worktree 内检测失效，worktree 内修复对共享 repo config 全局生效', () => {
    const root = initFixtureRepo('with-worktree');
    git(['config', 'core.hooksPath', '.husky/_'], root);

    // 模拟派工线：从主仓建 worktree，在 worktree 内操作（cwd=worktree）
    const wtPath = path.join(tmpDir, 'with-worktree-wt');
    git(['worktree', 'add', wtPath, '-b', 'fixture-worktree-branch'], root);

    // worktree 内 --check：.husky/_ 相对 worktree 根解析不到 commit-msg → 失效
    const checkInWt = runScript(['--check'], wtPath);
    expect(checkInWt.exitCode).toBe(1);

    // worktree 内自愈：repo-local config 共享，主仓同步生效
    const fixInWt = runScript([], wtPath);
    expect(fixInWt.exitCode).toBe(0);
    expect(getHooksPath(root)).toBe('.githooks');

    // 主仓视角确认健康
    expect(runScript(['--check'], root).exitCode).toBe(0);
  });

  it('仓库外执行：报错退出（exit 1）', () => {
    const outside = path.join(tmpDir, 'not-a-repo');
    fs.mkdirSync(outside, { recursive: true });
    const result = runScript([], outside);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('不在 git 仓库内');
  });
});
