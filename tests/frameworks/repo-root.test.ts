import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getRepoRoot, __resetRepoRootCacheForTests } from '@frameworks/repo-root';

// ─── issue #429：运行时资源路径统一解析 ──────
// getRepoRoot() 基于代码位置（import.meta.dirname）向上逐级探测
// 含 package.json 且 name === "otter-buddy" 的目录，与 process.cwd() 无关。
// 本文件验证：
// 1. 正常情况：定位到本仓库根（与 cwd 无关）
// 2. cwd 非项目根：process.chdir 到临时目录后仍能正确定位（systemd/容器场景）
// 3. 锚语义：停止条件 = package.json name 匹配
// 4. 进程内缓存稳定

// Why: ESM 环境无 __dirname，用 import.meta.dirname（Node 21.2+ / 22+，与 src 侧先例一致）
const TESTS_FRAMEWORKS_DIR = import.meta.dirname;

afterEach(() => {
  __resetRepoRootCacheForTests();
});

describe('getRepoRoot', () => {
  it('cwd 为项目根时：定位到本仓库根', () => {
    const root = getRepoRoot();
    expect(root).toBe(resolve(TESTS_FRAMEWORKS_DIR, '../..'));
    expect(root).not.toBe('');
  });

  it('cwd 非项目根时：仍基于代码位置定位仓库根（#429 核心场景）', () => {
    const origCwd = process.cwd();
    const tmpDir = mkdtempSync(join(tmpdir(), 'repo-root-test-'));
    process.chdir(tmpDir);
    try {
      const root = getRepoRoot();
      expect(root).toBe(resolve(TESTS_FRAMEWORKS_DIR, '../..'));
    } finally {
      process.chdir(origCwd);
    }
  });

  it('锚语义：仓库根 package.json 的 name 是 otter-buddy（向上探测的停止条件）', () => {
    const root = getRepoRoot();
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string };
    expect(pkg.name).toBe('otter-buddy');
  });

  it('进程内缓存：多次调用返回同一结果', () => {
    const first = getRepoRoot();
    const second = getRepoRoot();
    expect(second).toBe(first);
  });
});
