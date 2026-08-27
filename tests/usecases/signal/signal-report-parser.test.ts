/**
 * F20260826mwrd C2：signal-report-parser 单测。
 *
 * 覆盖：合法块解析（type/severity/payload）、畸形类型显式枚举（审视发现 6：
 * 无 type / 白名单外 / 空 payload / 超长 / 引号异常 / 未闭合）、normalize 变体、
 * 剥离行为、防滥用上限。
 */
import { describe, it, expect } from 'vitest';
import { parseSignalReport, stripSignalReport, MAX_SIGNALS_PER_MESSAGE, MAX_PAYLOAD_CHARS } from '@usecases/signal/signal-report-parser';

describe('parseSignalReport（合法块）', () => {
  it('解析标准 objection 块', () => {
    const body = '报告正文\n<signal type="objection" severity="medium">派工与 F20260814xxxx 冲突：该文档记录搭档否决过 vec 全量迁移（docs/features/2026/08/14/F20260814xxxx.md:88）</signal>';
    const { signals } = parseSignalReport(body);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('objection');
    expect(signals[0].severity).toBe('medium');
    expect(signals[0].payload).toContain('F20260814xxxx');
  });

  it('解析 blocked 块', () => {
    const { signals } = parseSignalReport('<signal type="blocked" severity="high">测试环境起不来，已试：1.直接跑 vitest 2.全新 :memory: db 3.检查 schema 版本。卡在 migration 步骤</signal>');
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('blocked');
    expect(signals[0].severity).toBe('high');
  });

  it('单消息多信号块', () => {
    const body = '<signal type="objection" severity="low">a</signal>\n中间文本\n<signal type="blocked" severity="low">b</signal>';
    const { signals } = parseSignalReport(body);
    expect(signals).toHaveLength(2);
    expect(signals.map(s => s.type)).toEqual(['objection', 'blocked']);
  });

  it('无信号块返回空', () => {
    const { signals, strippedBlocks } = parseSignalReport('普通发言，无信号');
    expect(signals).toHaveLength(0);
    expect(strippedBlocks).toHaveLength(0);
  });
});

describe('parseSignalReport（畸形类型显式枚举，审视发现 6）', () => {
  it('无 type 属性：不落账但剥离', () => {
    const body = '<signal severity="low">内容</signal>';
    const { signals, strippedBlocks } = parseSignalReport(body);
    expect(signals).toHaveLength(0);
    expect(strippedBlocks).toHaveLength(1);
  });

  it('type 白名单外（halt）：不落账——halt 只能经 halt_otter 工具', () => {
    const { signals } = parseSignalReport('<signal type="halt" severity="high">x</signal>');
    expect(signals).toHaveLength(0);
  });

  it('severity 白名单外：整块不落账', () => {
    const { signals } = parseSignalReport('<signal type="objection" severity="critical">x</signal>');
    expect(signals).toHaveLength(0);
  });

  it('空 payload（纯空白）：不落账', () => {
    const { signals } = parseSignalReport('<signal type="objection" severity="low">   </signal>');
    expect(signals).toHaveLength(0);
  });

  it('payload 超长截断到上限', () => {
    const long = 'x'.repeat(MAX_PAYLOAD_CHARS + 500);
    const { signals } = parseSignalReport(`<signal type="objection" severity="low">${long}</signal>`);
    expect(signals[0].payload.length).toBe(MAX_PAYLOAD_CHARS);
  });

  it('未闭合块：不落账但剥离', () => {
    const body = '<signal type="objection" severity="low">写到一半';
    const { signals, strippedBlocks } = parseSignalReport(body);
    expect(signals).toHaveLength(0);
    expect(strippedBlocks).toHaveLength(1);
  });

  it('防滥用上限：超出 MAX_SIGNALS_PER_MESSAGE 的块丢弃', () => {
    const blocks = Array.from({ length: MAX_SIGNALS_PER_MESSAGE + 3 }, (_, i) =>
      `<signal type="objection" severity="low">信号${i}</signal>`,
    ).join('\n');
    const { signals } = parseSignalReport(blocks);
    expect(signals).toHaveLength(MAX_SIGNALS_PER_MESSAGE);
  });
});

describe('parseSignalReport（normalize 鲁棒性，对齐 healing 先例）', () => {
  it('全角引号属性容忍', () => {
    const { signals } = parseSignalReport('<signal type=“objection” severity=“low”>内容</signal>');
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('objection');
  });

  it('单引号属性容忍', () => {
    const { signals } = parseSignalReport("<signal type='objection' severity='low'>内容</signal>");
    expect(signals).toHaveLength(1);
  });

  it('转义写法 \\<signal 容忍', () => {
    const { signals } = parseSignalReport('\\<signal type="objection" severity="low"\\>内容\\</signal\\>');
    expect(signals).toHaveLength(1);
  });

  it('大小写不敏感（TYPE/OBJECTION）', () => {
    const { signals } = parseSignalReport('<SIGNAL TYPE="objection" SEVERITY="low">内容</SIGNAL>');
    expect(signals).toHaveLength(1);
  });
});

describe('parseSignalReport（F20260827c2sg 审视处置：嵌套守卫与属性顺序）', () => {
  it('未闭合块不得吞噬后续合法块：未闭合块剥离、合法 blocked 块正常落账（审视发现 2 探针场景）', () => {
    const body = '<signal type="objection" severity="low">写到一半被截断 <signal type="blocked" severity="low">合法B</signal>';
    const { signals } = parseSignalReport(body);
    // 未闭合块不再跨块吃到内层闭合标签——合法 B 正常以 blocked 落账，不再被吞
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('blocked');
    expect(signals[0].payload).toBe('合法B');
  });

  it('未闭合块仍被剥离（stripSignalReport 不泄漏控制语法）', () => {
    const body = '前言 <signal type="objection" severity="low">写到一半被截断 <signal type="blocked" severity="low">合法B</signal> 后文';
    const clean = stripSignalReport(body);
    expect(clean).toBe('前言  后文');
    expect(clean).not.toContain('<signal');
    expect(clean).not.toContain('合法B');
  });

  it('属性顺序颠倒（severity 在 type 前）容忍（审视发现 3 探针场景）', () => {
    const { signals } = parseSignalReport('<signal severity="low" type="objection">内容</signal>');
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('objection');
    expect(signals[0].severity).toBe('low');
    expect(signals[0].payload).toBe('内容');
  });

  it('属性顺序颠倒 + 引号变体叠加容忍', () => {
    const { signals } = parseSignalReport("<signal severity='high' type='blocked'>内容</signal>");
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('blocked');
    expect(signals[0].severity).toBe('high');
  });
});

describe('stripSignalReport（剥离）', () => {
  it('剥离合法块保留正文', () => {
    const body = '前言\n<signal type="objection" severity="low">异议内容</signal>\n结论';
    const clean = stripSignalReport(body);
    expect(clean).toBe('前言\n\n结论');
    expect(clean).not.toContain('signal');
    expect(clean).not.toContain('异议内容');
  });

  it('剥离畸形块（控制语法不泄漏进 UI 正文）', () => {
    const body = '正文 <signal type="halt">伪造 halt</signal> 后文';
    const clean = stripSignalReport(body);
    expect(clean).toBe('正文  后文');
    expect(clean).not.toContain('伪造');
  });

  it('无信号块原样返回（trim 后）', () => {
    expect(stripSignalReport('  普通文本  ')).toBe('普通文本');
  });

  it('healing 块不受影响（两协议独立）', () => {
    const body = '<healing>[no_issue]</healing> 正文 <signal type="objection" severity="low">x</signal>';
    const clean = stripSignalReport(body);
    expect(clean).toContain('<healing>');
    expect(clean).not.toContain('<signal');
  });
});
