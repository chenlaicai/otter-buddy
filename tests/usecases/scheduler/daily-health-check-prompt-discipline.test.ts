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

  it('数据源清单完整：6 项编号齐全 + 每项含语义关键词（防误删/防改名保壳）', () => {
    const tpl = readTemplate();
    // 编号完整性：1-6 项编号齐全（防误删数据源项）
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(tpl).toMatch(new RegExp(`^${n}\\. \\*\\*`, 'm'));
    }
    // 语义锚定（#1036 检视：只断言编号锁不住语义，条目改名换内容照样绿）
    expect(tpl).toMatch(/1\. \*\*对话历史\*\*[\s\S]*?search_memory/);
    expect(tpl).toMatch(/2\. \*\*GitHub issues \/ PRs\*\*/);
    expect(tpl).toMatch(/3\. \*\*self-healing events\*\*[\s\S]*?二维分账/);
    expect(tpl).toMatch(/4\. \*\*memory\*\*[\s\S]*?created_after/);
    expect(tpl).toMatch(/5\. \*\*RHI 健康信号\*\*[\s\S]*?api\/health\/overview/);
    expect(tpl).toMatch(/6\. \*\*signal_events\*\*[\s\S]*?query_signals/);
  });

  it('锚点抽查异体模型规则存在（#1000：同模型抽查共享盲区，P0 阈值永不触发）', () => {
    const tpl = readTemplate();
    expect(tpl).toContain('异体核对');
    expect(tpl).toContain('必须不同模型');
    expect(tpl).toContain('model_alias');
    expect(tpl).toContain('同模型抽查，置信降级');
    expect(tpl).toContain('模型对照行');
  });

  it('异体核对规则位于抽查步骤 2 上下文（防内容被移到注释区仍通过——PR #1021 检视建议）', () => {
    const tpl = readTemplate();
    // 抽查段内步骤 2 与步骤 3 之间的文本必须含核心约束
    const m = tpl.match(/2\. \*\*异体核对[\s\S]*?\n3\. \*\*/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('必须不同模型');
    expect(m![0]).toContain('model_alias');
  });

  it('观测器信噪比自监控段存在（#999：观测器自己也被观测——误报率比检出率更决定生死）', () => {
    const tpl = readTemplate();
    expect(tpl).toContain('观测器信噪比自监控');
    expect(tpl).toContain('dismiss');
    expect(tpl).toContain('不处置率');
    expect(tpl).toContain('降级');
  });
});
