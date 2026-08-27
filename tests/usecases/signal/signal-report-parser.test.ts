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
    // 控制语法（标签）全部剥离，不泄漏 <signal / </signal>；未闭合块的普通正文（写到一半被截断）保留——不吞内容
    expect(clean).toBe('前言 写到一半被截断  后文');
    expect(clean).not.toContain('<signal');
    expect(clean).not.toContain('</signal>');
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

describe('parseSignalReport（F20260827c2sg 审视处置：发现 4 重写为 tokenizer 栈式配对）', () => {
  it('payload 含未闭合 <signal 字样：外层块正常落账，不因字样丢块（发现 4 探针场景 A）', () => {
    const body = '<signal type="objection" severity="low">嵌入了 <signal 这样的字样但故意不闭合</signal>';
    const { signals } = parseSignalReport(body);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('objection');
    expect(signals[0].payload).toContain('<signal');
  });

  it('payload 含反引号包裹的完整示例：外层落账、内层不冒名、strip 无残留（发现 4 探针场景 B）', () => {
    // 外层闭合的完整变体：normalize 剥反引号后内层示例也是完整闭合形态，但它是外层 payload 的一部分
    const crafted = '<signal type="objection" severity="low">格式示例：<signal type="blocked" severity="low">x</signal> 诸如此类</signal>';
    const { signals } = parseSignalReport(crafted);
    // 内层嵌套块是外层 payload 的一部分，不得冒名落账
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('objection');
    expect(signals[0].payload).toContain('格式示例');
    expect(signals[0].payload).toContain('诸如此类');
    // parse/strip 同步：顶层块整体剥离，无 </signal> 残留
    const clean = stripSignalReport('前言 ' + crafted + ' 后文');
    expect(clean).toBe('前言  后文');
    expect(clean).not.toContain('</signal>');
  });

  it('完整嵌套（内外均闭合）：只有外层落账，内层是 payload 的一部分', () => {
    const body = '<signal type="objection" severity="low">外层理由，内附格式示例：<signal type="blocked" severity="low">示例x</signal>完</signal>';
    const { signals } = parseSignalReport(body);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('objection');
    expect(signals[0].payload).toContain('示例x');
  });

  it('孤儿闭标签剥离，不残留闭合语法', () => {
    const clean = stripSignalReport('正文一</signal>正文二');
    expect(clean).toBe('正文一正文二');
    expect(clean).not.toContain('</signal>');
  });

  it('未闭合块 + 后续合法块：合法块正常落账（发现 2 场景在 tokenizer 下的回归防护）', () => {
    const body = '<signal type="objection" severity="low">写到一半被截断 <signal type="blocked" severity="low">合法B</signal>';
    const { signals } = parseSignalReport(body);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('blocked');
    expect(signals[0].payload).toBe('合法B');
  });

  it('双层未闭合 + 尾部合法块：栈式配对不吃后续合法块的闭合标签', () => {
    const body = '<signal type="objection" severity="low">A <signal type="objection" severity="low">B <signal type="blocked" severity="low">合法C</signal>';
    const { signals } = parseSignalReport(body);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('blocked');
    expect(signals[0].payload).toBe('合法C');
  });

  it('属性段含裸 < 的畸形开标签：残文剥离不泄漏进 UI 正文（发现 5 探针场景）', () => {
    const body = '正文一 <signal a<b type="objection" severity="low">x</signal> 正文二';
    const clean = stripSignalReport(body);
    // 控制语法全部剥离（含 tokenizer 认不出的畸形开标签残文）
    expect(clean).not.toContain('<signal');
    expect(clean).not.toContain('</signal>');
    // 落账行为不变：畸形块不落账
    const { signals } = parseSignalReport(body);
    expect(signals).toHaveLength(0);
  });

  it('无 > 的纯文字引用保留（剥语法不吞内容）——兑底正则不误伤内容', () => {
    const clean = stripSignalReport('正文里引用 <signal 字样但无闭合形态');
    expect(clean).toContain('<signal 字样');
  });

  it('发现 6 R2/R3 对偶：畸形外层闭合时内层真实信号同样上达（语义不依赖外层闭合位置）', () => {
    // R2：外层闭合但 type 畸形——内层真实信号下钻上达，不再被埋葬
    const r2 = '<signal type="bogus" severity="low">外层写歪 <signal type="blocked" severity="low">真实信号</signal> 外层尾</signal>';
    const r2Signals = parseSignalReport(r2).signals;
    // R3：同一畸形 type、外层未闭合——内层独立落账（第 3 轮已认可的行为）
    const r3 = '<signal type="bogus" severity="low">外层写歪 <signal type="blocked" severity="low">真实信号</signal>';
    const r3Signals = parseSignalReport(r3).signals;
    // 对偶断言：两种形态的内层结果一致
    expect(r2Signals).toEqual(r3Signals);
    expect(r2Signals).toHaveLength(1);
    expect(r2Signals[0].type).toBe('blocked');
    expect(r2Signals[0].payload).toBe('真实信号');
  });

  it('合法外层的内层块仍不冒名落账（递归只下钻畸形块）', () => {
    // 外层合法：内层是 payload 的一部分，不落账（发现 4 场景 B 防冒名不变）
    const body = '<signal type="objection" severity="low">格式示例：<signal type="blocked" severity="low">x</signal> 诸如此类</signal>';
    const { signals } = parseSignalReport(body);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('objection');
    expect(signals[0].payload).toContain('格式示例');
  });

  it('畸形嵌套畸形：合法内核层层下钻上达', () => {
    const body = '<signal type="x1" severity="low">A<signal type="x2" severity="low">B<signal type="objection" severity="high">真实异议</signal></signal></signal>';
    const { signals } = parseSignalReport(body);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('objection');
    expect(signals[0].severity).toBe('high');
    expect(signals[0].payload).toBe('真实异议');
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
