/**
 * F20261009fdid（#1274）: lint:docs id 唯一性检查测试。
 *
 * 测 import 真实现的纯函数 findDuplicateIds（isMain 守卫下 import 不触发
 * dist 依赖与文件遍历，模式对齐 lint-intent.test.ts）。
 * 端到端接线（重复 id → error → exit 1）由 pre-commit 的 npm run lint:docs
 * 实跑覆盖（PR Verification 节展示输出）。
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error 真实现是 .mjs 脚本（无类型声明），运行时 import 纯函数
import { findDuplicateIds, evaluateDistFreshness } from '../../scripts/lint-docs.mjs';

describe('lint:docs id 唯一性（findDuplicateIds）', () => {
  it('两个文件共用同一 id → 报告该 id（#1274 原案锁定：ax376 组形态）', () => {
    const dupes = findDuplicateIds([
      { rel: 'docs/features/2026/08/24/F20260824ax376-pr-evaluation-system-phase1.md', id: 'F20260824ax376' },
      { rel: 'docs/features/2026/08/24/F20260824ax376-fix-lock-manager-concurrency.md', id: 'F20260824ax376' },
      { rel: 'docs/features/2026/08/25/F20260825ktt2-lock-timeout-observability.md', id: 'F20260825ktt2' },
    ]);
    expect(dupes.size).toBe(1);
    expect(dupes.get('F20260824ax376')).toEqual([
      'docs/features/2026/08/24/F20260824ax376-pr-evaluation-system-phase1.md',
      'docs/features/2026/08/24/F20260824ax376-fix-lock-manager-concurrency.md',
    ]);
  });

  it('三个文件共用同一 id → 列表长度 3（gh698 组曾为此形态，治理后防复发）', () => {
    const dupes = findDuplicateIds([
      { rel: 'docs/features/2026/09/03/a.md', id: 'F20260903gh698' },
      { rel: 'docs/features/2026/09/03/b.md', id: 'F20260903gh698' },
      { rel: 'docs/features/2026/09/03/c.md', id: 'F20260903gh698' },
    ]);
    expect(dupes.get('F20260903gh698')!.length).toBe(3);
  });

  it('无重复 → 空 Map（治理后的期望态）', () => {
    const dupes = findDuplicateIds([
      { rel: 'docs/features/2026/08/24/a.md', id: 'F20260824ax376' },
      { rel: 'docs/features/2026/10/09/b.md', id: 'F20261009slmc' },
    ]);
    expect(dupes.size).toBe(0);
  });

  it('缺 id 条目跳过——缺 id 属 validator 管辖，不误报为重复', () => {
    const dupes = findDuplicateIds([
      { rel: 'docs/features/2026/08/24/a.md', id: undefined },
      { rel: 'docs/features/2026/08/24/b.md', id: undefined },
      { rel: 'docs/features/2026/08/24/c.md', id: 'F20260824real' },
    ]);
    expect(dupes.size).toBe(0);
  });

  it('多组重复同时报（各组独立成条，不只报第一组）', () => {
    const dupes = findDuplicateIds([
      { rel: 'a1.md', id: 'F20260824ax376' },
      { rel: 'a2.md', id: 'F20260824ax376' },
      { rel: 'b1.md', id: 'F20260903gh698' },
      { rel: 'b2.md', id: 'F20260903gh698' },
    ]);
    expect(dupes.size).toBe(2);
    expect(dupes.has('F20260824ax376')).toBe(true);
    expect(dupes.has('F20260903gh698')).toBe(true);
  });
});

describe('lint:docs dist 新鲜度（evaluateDistFreshness，#1400 假绿防线）', () => {
  it('src 修改晚于 dist 构建 → 陈旧（issue 假绿现场形态：旧 dist 必须被拦）', () => {
    const r = evaluateDistFreshness(
      [{ rel: 'src/entities/document/frontmatter-validator.ts', mtimeMs: 2000 }],
      [{ rel: 'dist/src/entities/document/frontmatter-validator.js', mtimeMs: 1000 }],
    );
    expect(r.fresh).toBe(false);
    expect(r.newestSrc).toBe('src/entities/document/frontmatter-validator.ts');
  });

  it('src 全部早于 dist 构建 → 新鲜（build 后未改源的常规态，pre-commit 路径恒此态）', () => {
    const r = evaluateDistFreshness(
      [
        { rel: 'src/entities/document/frontmatter-validator.ts', mtimeMs: 500 },
        { rel: 'src/entities/document/known-values.ts', mtimeMs: 600 },
      ],
      [{ rel: 'dist/src/entities/document/frontmatter-validator.js', mtimeMs: 1000 }],
    );
    expect(r.fresh).toBe(true);
  });

  it('mtime 相等边界 → 保守判陈旧（等号 fail-closed：写入同刻无法证明已含）', () => {
    const r = evaluateDistFreshness(
      [{ rel: 'src/a.ts', mtimeMs: 1000 }],
      [{ rel: 'dist/src/a.js', mtimeMs: 1000 }],
    );
    expect(r.fresh).toBe(false);
  });

  it('多文件取极值正确：src 取最新者、dist 取最早写入者（任一源晚于任一产物即陈旧）', () => {
    const r = evaluateDistFreshness(
      [
        { rel: 'src/old.ts', mtimeMs: 100 },
        { rel: 'src/new.ts', mtimeMs: 3000 },
      ],
      [
        { rel: 'dist/src/first.js', mtimeMs: 2000 },
        { rel: 'dist/src/last.js', mtimeMs: 4000 },
      ],
    );
    expect(r.fresh).toBe(false);
    expect(r.newestSrc).toBe('src/new.ts');
  });

  it('任一侧为空 → skipped 不误报（dist 缺失归「未构建」检查管）', () => {
    expect(evaluateDistFreshness([], [{ rel: 'd.js', mtimeMs: 1 }]).skipped).toBe(true);
    expect(evaluateDistFreshness([{ rel: 's.ts', mtimeMs: 1 }], []).skipped).toBe(true);
  });
});
