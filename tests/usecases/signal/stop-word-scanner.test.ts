/**
 * L2「停下」安全词扫描单测（F20260826mwrd C3，母方案 Part 6）。
 *
 * 覆盖形态枚举（母方案审视发现 3 的实现层定义）：
 * - 形态 1：去首尾标点/空白后完全相等
 * - 形态 2：片段两侧均为标点/空白/emoji/消息首尾
 * - 负例：相邻为文字（讨论/引用形态）不命中
 * - reminder 文本含语境确认引导（不硬拦）
 */
import { describe, it, expect } from 'vitest';
import { scanStopWords } from '@usecases/signal/stop-word-scanner';

describe('scanStopWords 形态 1：完全相等（去首尾标点/空白）', () => {
  it('纯「停下」命中', () => {
    const r = scanStopWords('停下');
    expect(r.matched).toEqual(['停下']);
    expect(r.reminder).toContain('停下');
  });

  it('尾标点「停下。」「停下！」「停下！！」命中', () => {
    for (const msg of ['停下。', '停下！', '停下！！', '停下？']) {
      expect(scanStopWords(msg).matched, msg).toEqual(['停下']);
    }
  });

  it('首尾空白/标点混合命中（「 停下 」「"停下"」）', () => {
    expect(scanStopWords(' 停下 ').matched).toEqual(['停下']);
    expect(scanStopWords('"停下"').matched).toEqual(['停下']);
  });

  it('首尾中文标点（「——停下——」）命中', () => {
    expect(scanStopWords('——停下——').matched).toEqual(['停下']);
  });
});

describe('scanStopWords 形态 2：片段独立成词（两侧为边界）', () => {
  it('「快停下」（首边界+尾边界）命中', () => {
    expect(scanStopWords('快停下').matched).toEqual(['停下']);
  });

  it('「都停下。」命中', () => {
    expect(scanStopWords('都停下。').matched).toEqual(['停下']);
  });

  it('「停下，都别动」片段居中两侧标点命中', () => {
    expect(scanStopWords('停下，都别动').matched).toEqual(['停下']);
  });

  it('emoji 作边界「⛔停下⛔」命中', () => {
    expect(scanStopWords('⛔停下⛔').matched).toEqual(['停下']);
  });

  it('中英混排「stop！停下！now」命中', () => {
    expect(scanStopWords('stop！停下！now').matched).toEqual(['停下']);
  });

  it('零宽/变体字符后侧命中（F20260827c3hr 审视建议 2）——VS16/ZWSP/ZWNJ/组合重音符', () => {
    // 真实键盘/剪贴板夹带：iOS emoji 键盘带 VS16（U+FE0F）、网页复制带 ZWSP（U+200B）/
    // ZWNJ（U+200C）、macOS 长按带组合重音符（U+0301）——用户不可见、不构成词义，归边界类
    const cases: Array<[string, string]> = [
      ['停下\uFE0F', 'VS16（emoji 变体选择符）'],
      ['停下\u200B', 'ZWSP（零宽空格）'],
      ['停下\u200C', 'ZWNJ（零宽非连接符）'],
      ['停下\u0301', '组合重音符（macOS 长按）'],
    ];
    for (const [msg, label] of cases) {
      expect(scanStopWords(msg).matched, label).toEqual(['停下']);
    }
  });

  it('「⛔停下」形态 1 不命中（trim 不剥 emoji——emoji 属内容字符）但形态 2 命中（F20260827c3hr 审视发现 1）', () => {
    // 形态 1：trim 只剥标点/空白/组合记号/格式控制，emoji 不在 trim 范围——「⛔停下」≠「停下」
    // 形态 2 兑底：后侧消息尾是硬边界 → 命中。emoji 包裹的消息一律走形态 2 边界判定。
    expect(scanStopWords('⛔停下').matched).toEqual(['停下']);
  });
});

describe('scanStopWords 负例：讨论/引用形态不命中', () => {
  it('「停下手头工作」不命中（相邻为文字）', () => {
    expect(scanStopWords('停下手头工作').matched).toEqual([]);
    expect(scanStopWords('停下手头工作').reminder).toBeNull();
  });

  it('「这个词叫停下」（后侧为消息尾但前侧是文字——语境确认兑底，命中但 LLM 判定为讨论）', () => {
    // 后侧硬边界（消息尾）→ 命中；reminder 引导 LLM 识别讨论/引用语境不急停（不硬拦设计）
    expect(scanStopWords('这个词叫停下').matched).toEqual(['停下']);
    expect(scanStopWords('这个词叫停下').reminder).toContain('讨论/引用');
  });

  it('「讨论一下停下这个词的语义」两侧均为文字不命中', () => {
    expect(scanStopWords('讨论一下停下这个词的语义').matched).toEqual([]);
  });

  it('「先停一下」不含完整「停下」不命中', () => {
    expect(scanStopWords('先停一下').matched).toEqual([]);
  });

  it('空消息/纯标点不命中', () => {
    expect(scanStopWords('').matched).toEqual([]);
    expect(scanStopWords('。。。').matched).toEqual([]);
  });
});

describe('scanStopWords reminder 语义', () => {
  it('reminder 含语境确认引导（指令 vs 讨论/引用）与 halt 引导', () => {
    const r = scanStopWords('停下');
    expect(r.reminder).toContain('安全指令还是讨论/引用');
    expect(r.reminder).toContain('halt_otter');
    expect(r.reminder).toContain('Magic Words');
  });

  it('未命中时 reminder 为 null（零开销）', () => {
    expect(scanStopWords('正常消息').reminder).toBeNull();
  });
});
