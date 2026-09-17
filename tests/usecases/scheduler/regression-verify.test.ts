import { describe, it, expect } from 'vitest';
import { extractAssertionDueDate } from '@usecases/scheduler/scheduler-service';

// ─── #1004：验证断言到期日期提取 ──────
// extractAssertionDueDate 是 regression-verify 任务的筛选核心：
// 从 closed daily-review issue 的 body 中定位「## 验证断言」段，提取「到期：YYYY-MM-DD」。
// 提取不到 → null（该 issue 不参与回查，prompt 层会提醒补写断言）。

describe('extractAssertionDueDate', () => {
  it('从标准断言段提取到期日期', () => {
    const body = [
      '## 问题',
      '某个问题描述',
      '',
      '## 验证断言',
      '- 断言：healing_events 中 errorType=X 连续 7 天为 0',
      '- 检查方式：sqlite3 查询 ...',
      '- 到期：2026-10-16',
      '',
      '## 其他',
    ].join('\n');
    expect(extractAssertionDueDate(body)).toBe('2026-10-16');
  });

  it('断言段在 body 末尾（无后续 ## 段）也能提取', () => {
    const body = '## 验证断言\n- 断言：某条件\n- 到期：2026-11-01\n';
    expect(extractAssertionDueDate(body)).toBe('2026-11-01');
  });

  it('支持中文冒号', () => {
    const body = '## 验证断言\n- 到期: 2026-10-20\n';
    expect(extractAssertionDueDate(body)).toBe('2026-10-20');
  });

  it('无断言段 → null', () => {
    expect(extractAssertionDueDate('## 问题\n没有断言段')).toBeNull();
  });

  it('断言段无到期行 → null', () => {
    const body = '## 验证断言\n- 断言：某条件\n- 检查方式：某方式\n';
    expect(extractAssertionDueDate(body)).toBeNull();
  });

  it('到期日期格式非法 → null', () => {
    const body = '## 验证断言\n- 到期：下个月\n';
    expect(extractAssertionDueDate(body)).toBeNull();
  });

  it('断言段后的其他段不影响提取', () => {
    const body = '## 验证断言\n- 到期：2026-10-16\n\n## 备注\n到期：2099-01-01\n';
    expect(extractAssertionDueDate(body)).toBe('2026-10-16');
  });
});
