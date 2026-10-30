/**
 * F20261030lvgov（LLM-Voice 治理）：同型审计脚本 audit.mjs 单测。
 *
 * 覆盖五维检测中可机械验证的判定：开头/收尾签名聚类（T1/T2）、跨章 n-gram 重复（T3）、
 * 连接词 tics（T5/T8）、句长节奏均匀度（T7）、比喻密度（T4）。
 * 用合成章节构造已知同型断言命中，构造多变章节断言不误报——阈值启发式的 fail-safe 方向验证。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  splitSentences,
  sentenceSignature,
  clusterBySignature,
  crossChapterNGrams,
  measureConnectiveTics,
  measureSentenceRhythm,
  measureMetaphorDensity,
  auditChapters,
  loadChapters,
} from '../../scripts/prose-audit/audit.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'prose-audit-'));

describe('sentenceSignature（开头/收尾骨架）', () => {
  it('同为「时间词开头」的两句同签名（公文式开头）', () => {
    const a = sentenceSignature('腊月十三，青石埠，七号仓。');
    const b = sentenceSignature('腊月十四，青石埠，九号仓。');
    expect(a.key).toBe(b.key);
    expect(a.hasTimeWord).toBe(true);
  });

  it('时间词开头 与 对白开头 → 不同签名', () => {
    const a = sentenceSignature('腊月十三，青石埠，七号仓。');
    const b = sentenceSignature('「走。」他把刀收回鞘里。');
    expect(a.key).not.toBe(b.key);
    expect(b.hasQuote).toBe(true);
  });
});

describe('clusterBySignature（同型聚类）', () => {
  it('三章同公文式开头 → 聚为一类；孤立章不入类', () => {
    const chapters = [
      { name: 'c1', text: '腊月十三，青石埠，七号仓。\n他走进去。' },
      { name: 'c2', text: '腊月十四，青石埠，九号仓。\n他走出去。' },
      { name: 'c3', text: '腊月十五，青石埠，一号仓。\n他站住了。' },
      { name: 'c4', text: '「谁？」门后有人喝问。\n他没答。' },
    ];
    const clusters = clusterBySignature(chapters, (ch) => splitSentences(ch.text).slice(0, 1));
    expect(clusters.length).toBe(1);
    expect(clusters[0].chapters.sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('各章开头皆不同 → 不报任何同型', () => {
    const chapters = [
      { name: 'a', text: '刀光一闪。\n完。' },
      { name: 'b', text: '「谁？」他喝问。\n完。' },
      { name: 'c', text: '那年冬天雪很大。\n完。' },
    ];
    const clusters = clusterBySignature(chapters, (ch) => splitSentences(ch.text).slice(0, 1));
    expect(clusters.length).toBe(0);
  });
});

describe('crossChapterNGrams（T3 同型重复）', () => {
  it('同一 4 字短语跨两章出现 → 报出', () => {
    const chapters = [
      { name: 'c152', text: '桌子太窄，摆不下那盏灯。' },
      { name: 'c177', text: '这桌子太窄了些，得换。' },
      { name: 'c178', text: '风从窗缝里灌进来。' },
    ];
    const grams = crossChapterNGrams(chapters, 4, 2);
    const hit = grams.find((g) => g.phrase === '桌子太窄');
    expect(hit).toBeTruthy();
    expect(hit?.chapterCount).toBe(2);
  });

  it('高频虚词被停用表过滤 → 不误报「一个」', () => {
    const chapters = [
      { name: 'x', text: '一个一个又一个。' },
      { name: 'y', text: '一个一个又一个。' },
    ];
    const grams = crossChapterNGrams(chapters, 4, 2);
    expect(grams.find((g) => g.phrase === '一个一个')).toBeFalsy();
  });
});

describe('measureConnectiveTics（T5/T8）', () => {
  it('「不是X而是Y」句式被计数', () => {
    const tics = measureConnectiveTics('这不是退缩，而是蛰伏。这不是结束，而是开始。');
    const hit = tics.find((t) => t.phrase === '不是X而是Y');
    expect(hit).toBeTruthy();
    expect(hit?.count).toBe(2);
  });

  it('连接词套话被计数', () => {
    const tics = measureConnectiveTics('值得注意的是，事情起了变化。');
    expect(tics.find((t) => t.phrase === '值得注意')).toBeTruthy();
  });
});

describe('measureSentenceRhythm（T7 节奏均匀度）', () => {
  it('句长高度一致 → uniformity=true', () => {
    const r = measureSentenceRhythm('他走进院子。他推开门。他坐下身。他喝口水。他闭上眼。');
    expect(r.uniformity).toBe(true);
    expect(r.sentenceCount).toBe(5);
  });

  it('句长参差 → uniformity=false', () => {
    const r = measureSentenceRhythm('刀。那一刀快得像要把夜色劈成两半，寒光在檐下停了一瞬，然后才是血。停。');
    expect(r.uniformity).toBe(false);
  });
});

describe('measureMetaphorDensity（T4 堆砌意象）', () => {
  it('比喻密集 → high=true', () => {
    const dense = '他像一匹狼。她仿佛是雾。那声音宛如叹息。日子如同流水。心好似被针扎。梦一般散了。';
    expect(measureMetaphorDensity(dense).high).toBe(true);
  });

  it('无比喻 → high=false 且 rate=0', () => {
    const plain = '他推开门，坐下，倒了杯茶，看着窗外。';
    const r = measureMetaphorDensity(plain);
    expect(r.high).toBe(false);
    expect(r.ratePer1k).toBe(0);
  });
});

describe('auditChapters + loadChapters（端到端）', () => {
  it('合成同型语料 → flags 命中公文式开头/同型/密度', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, '01.md'), '腊月十三，青石埠，七号仓。\n桌子太窄。他像狼般盯着。她仿佛听见了。那声音宛如雷。日子如同流水。心好似刀割。梦一般醒了。');
    fs.writeFileSync(path.join(dir, '02.md'), '腊月十四，青石埠，九号仓。\n桌子太窄。他像狼般盯着。她仿佛听见了。那声音宛如雷。日子如同流水。心好似刀割。梦一般醒了。');
    fs.writeFileSync(path.join(dir, '03.md'), '腊月十五，青石埠，一号仓。\n桌子太窄。他像狼般盯着。她仿佛听见了。那声音宛如雷。日子如同流水。心好似刀割。梦一般醒了。');

    const chapters = loadChapters(dir);
    expect(chapters.length).toBe(3);
    const report = auditChapters(chapters);
    expect(report.meta.chapterCount).toBe(3);
    // 公文式时间开头同构
    expect(report.flags.some((f) => f.includes('公文式时间开头同构'))).toBe(true);
    // 跨章 n-gram 重复
    expect(report.flags.some((f) => f.includes('跨章 n-gram 重复'))).toBe(true);
    // 比喻密度偏高
    expect(report.flags.some((f) => f.includes('比喻密度偏高'))).toBe(true);
  });

  it('多变语料 → 不误报开头同型', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'a.md'), '刀光一闪。\n那人退了三步。');
    fs.writeFileSync(path.join(dir, 'b.md'), '「谁？」门后喝问。\n夜色很深。');
    fs.writeFileSync(path.join(dir, 'c.md'), '那年冬天雪很大，压断了老槐。\n天亮才停。');

    const chapters = loadChapters(dir);
    const report = auditChapters(chapters);
    expect(report.openingPatterns.length).toBe(0);
  });
});
