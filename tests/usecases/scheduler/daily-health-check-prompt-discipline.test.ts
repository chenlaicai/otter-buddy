/**
 * 每日健康检查模板纪律锁（issue #791 P1）
 *
 * 9:00 任务的 prompt 真相源在 prompts/scheduled/daily-health-check.md（git 模板，
 * F20260904dhs7/#428 确立），DB body 是运行时副本（update-scheduled-task-body.mjs 同步）。
 * 本测试锁定 #791 加的两条数据核查纪律不被后续模板编辑误删：
 * 1. sqlite3 直查前置纪律——先 curl /api/settings 确认 dbPath（#791 现场：错查孤儿库
 *    otter.db 得「零事件」，实际在用库 245 条）
 * 2. 关键数字双源验证——单源数字标注「未交叉验证」（#791 现场：口径混排把 other:33
 *    拆散隐去，呈现失真即数据不实）
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

function readTemplate(): string {
  return readFileSync('prompts/scheduled/daily-health-check.md', 'utf8');
}

describe('每日健康检查模板纪律锁（#791 P1）', () => {
  it('sqlite3 直查前置纪律存在：先 curl /api/settings 确认 dbPath（#791 错库教训）', () => {
    const tpl = readTemplate();
    expect(tpl).toContain('sqlite3 直查前置纪律');
    expect(tpl).toContain('curl -s http://localhost:3000/api/settings');
    expect(tpl).toContain('确认 dbPath');
  });

  it('关键数字双源验证纪律存在（#791 口径混排教训）', () => {
    const tpl = readTemplate();
    expect(tpl).toContain('关键数字双源验证');
    expect(tpl).toContain('未交叉验证');
  });

  it('数据源清单完整：7 项编号齐全（防误删数据源项）', () => {
    const tpl = readTemplate();
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      expect(tpl).toMatch(new RegExp(`^${n}\\. \\*\\*`, 'm'));
    }
  });
});
