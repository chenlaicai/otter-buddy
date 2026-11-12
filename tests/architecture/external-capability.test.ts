import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getRepoRoot } from '@frameworks/repo-root';

describe('可选外部适配器架构边界', () => {
  it('核心生产代码不包含 CoLink 厂商耦合', () => {
    const root = getRepoRoot();
    const files = execFileSync('git', ['ls-files', 'src', 'api-contract'], { cwd: root, encoding: 'utf8' })
      .split('\n').filter(Boolean);
    const matches = files.filter(file => /colink/i.test(readFileSync(path.join(root, file), 'utf8')));
    expect(matches).toEqual([]);
  });
});
