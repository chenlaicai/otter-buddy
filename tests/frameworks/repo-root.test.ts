import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getRepoRoot, findRepoRoot, __resetRepoRootCacheForTests } from '@frameworks/repo-root';

// ─── issue #429：运行时资源路径统一解析 ──────
// getRepoRoot() 基于代码位置（import.meta.dirname）向上逐级探测
// 含 package.json 且 name === "otter-buddy" 的目录，与 process.cwd() 无关。
// 本文件验证：
// 1. 正常情况：定位到本仓库根（与 cwd 无关）
// 2. cwd 非项目根：process.chdir 到临时目录后仍能正确定位（systemd/容器场景）
// 3. 锚语义：停止条件 = package.json name 匹配
// 4. 进程内缓存稳定
// 5. findRepoRoot（带起点参数的依赖注入入口）：
//    - 探测成功返回锚点
//    - 探测失败返回 null（getRepoRoot 的 fail-soft 兜底分支可测）

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

describe('findRepoRoot（依赖注入入口，可测失败兜底）', () => {
  it('从合法起点逐级向上探测：找到锚点返回绝对路径', () => {
    const fromDir = join(TESTS_FRAMEWORKS_DIR, 'nested', 'deeper');
    const result = findRepoRoot(fromDir);
    expect(result).toBe(resolve(TESTS_FRAMEWORKS_DIR, '../..'));
  });

  it('fail-soft 兜底：findRepoRoot 探测 10 级内无锚时返回 null（负向测试，不依赖 getRepoRoot 的 cwd 兜底）', () => {
    // 构造一个 12 级深的临时目录链（超过 MAX_UPWARD_STEPS = 10），链上无任何 package.json
    const base = mkdtempSync(join(tmpdir(), 'repo-root-fail-soft-'));
    let deep = base;
    for (let i = 0; i < 12; i++) {
      deep = join(deep, `level-${i}`);
      mkdirSync(deep);
    }
    // findRepoRoot 从 deep 起点向上探测 10 级，链上无锚 → 返回 null
    expect(findRepoRoot(deep)).toBeNull();
  });

  it('探测成功时锚语义正确：name 匹配才停，name 不匹配继续向上', () => {
    // 临时目录结构：外层包 name 非 otter-buddy，内层包 name 是 otter-buddy
    // 期望 findRepoRoot 从内层起点开始，遇到内层锚点即返回，不穿透到外层
    const base = mkdtempSync(join(tmpdir(), 'repo-root-anchor-'));
    const outerDir = join(base, 'outer');
    const innerDir = join(outerDir, 'inner');
    mkdirSync(innerDir, { recursive: true });
    writeFileSync(
      join(outerDir, 'package.json'),
      JSON.stringify({ name: 'not-otter-buddy' }),
      'utf8'
    );
    writeFileSync(
      join(innerDir, 'package.json'),
      JSON.stringify({ name: 'otter-buddy' }),
      'utf8'
    );
    expect(findRepoRoot(innerDir)).toBe(innerDir);
    // 外层包 name 非 otter-buddy → 不是锚，findRepoRoot 继续向上；tmp 根（base）无 package.json → 返回 null
    expect(findRepoRoot(outerDir)).toBeNull();
    expect(findRepoRoot(outerDir)).not.toBe(outerDir);
  });
});
