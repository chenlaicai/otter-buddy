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
import { findDuplicateIds } from '../../scripts/lint-docs.mjs';

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
