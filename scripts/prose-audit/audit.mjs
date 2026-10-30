#!/usr/bin/env node
/**
 * 同型审计（prose-audit）· 把「感觉文风很固定」变成可判定的数据
 * 真相源文档：scripts/prose-audit/README.md
 * 背景与清单：docs/research/2026/10/30/R20261030lvtap-llm-voice-text-antipatterns.md
 *
 * 用法：node audit.mjs <章节目录或文件> [--json] [--top N] [--out 报告路径]
 *   --json   机器可读输出（默认人读报告）
 *   --top N  每类最多报 N 条（默认 10）
 *   --out    报告写入文件（默认 stdout）
 *
 * 输出五维检测（对应反泔水清单 T1-T8）：
 *   1. 开头句式签名聚类（T1/T2 公文式开头、结构同构）
 *   2. 收尾句式签名聚类（T1/T6 收尾升华、结构同构）
 *   3. 跨章 n-gram 重复（T3 同型情节/句式）
 *   4. 连接词 tics 率（T5「不是X而是Y」、T8 连接词套话）
 *   5. 句长节奏均匀度 + 比喻密度（T7 语调恒定、T4 堆砌意象）
 *
 * 各判定均为阈值启发式，命中项是「需人眼复核的候选」而非定罪——机械先行、人工定性。
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, extname, basename } from 'node:path';

const TEXT_EXTS = new Set(['.md', '.txt', '.markdown']);

/* ---------- 读取：目录或单文件 → [{ name, text }] ---------- */
export function loadChapters(inputPath) {
  const abs = resolve(inputPath);
  const st = statSync(abs);
  const chapters = [];
  if (st.isFile()) {
    chapters.push({ name: basename(abs), text: readFileSync(abs, 'utf8') });
    return chapters;
  }
  const entries = readdirSync(abs)
    .filter((f) => TEXT_EXTS.has(extname(f).toLowerCase()))
    .sort();
  for (const f of entries) {
    chapters.push({ name: f, text: readFileSync(join(abs, f), 'utf8') });
  }
  return chapters;
}

/* ---------- 句子切分（按中文句末标点，保留正文） ---------- */
export function splitSentences(text) {
  return text
    .split(/[。！？!?；;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/* ---------- 句式签名：结构骨架，剥去具体内容 ---------- */
// 签名 = 前 6 字的字符类别序列 + 时间词旗 + 引语旗 + 长度桶
// 字符类别：C=汉字 D=数字 P=标点 L=拉丁 其他=O
const TIME_WORD =
  /腊月|正月|冬月|仲春|孟春|季春|清晨|黄昏|入夜|夜色|晨光|拂晓|晌午|年|月|日|时|刻|季|春|夏|秋|冬/;
const QUOTE_START = /^[「“"'『]/;

function charClass(ch) {
  if (/[0-9]/.test(ch)) return 'D';
  if (/[a-zA-Z]/.test(ch)) return 'L';
  if (/[\u4e00-\u9fa5]/.test(ch)) return 'C';
  if (/[，。！？、；：「」“”‘’（）《》…—·\s]/.test(ch)) return 'P';
  return 'O';
}

export function sentenceSignature(sentence) {
  const head = sentence.slice(0, 24);
  const classes = head
    .split('')
    .map(charClass)
    .filter((c) => c !== 'P' && c !== 'O')
    .slice(0, 6)
    .join('');
  const hasTimeWord = TIME_WORD.test(head.slice(0, 12));
  const hasQuote = QUOTE_START.test(sentence.trim());
  const len = sentence.length;
  const lenBucket = len < 12 ? 'short' : len <= 30 ? 'mid' : 'long';
  return { key: `${classes}|t:${hasTimeWord}|q:${hasQuote}|${lenBucket}`, hasTimeWord, hasQuote, classes };
}

/* ---------- 聚类：按签名归并章节 ---------- */
export function clusterBySignature(items, getSentences) {
  const map = new Map();
  for (const it of items) {
    const sents = getSentences(it);
    if (sents.length === 0) continue;
    const sig = sentenceSignature(sents[0]);
    const bucket = map.get(sig.key) || { signature: sig, chapters: [] };
    bucket.chapters.push(it.name);
    map.set(sig.key, bucket);
  }
  return [...map.values()]
    .filter((b) => b.chapters.length >= 2) // 单章不成「同型」
    .sort((a, b) => b.chapters.length - a.chapters.length);
}

/* ---------- 跨章 n-gram 重复 ---------- */
// 全虚词 n-gram 噪声大（每章都碰巧有「一个一个」），过滤掉只由虚/填充字组成的 n-gram，
// 让报告聚焦实词短语（如「桌子太窄」）。
const FUNCTION_CHARS = new Set(
  '一个们我的了在是你就也都还有这那什么没很之其而并与或但如果就着过给对向从到把被让能使会要想说看上来下去出来起又才只已再很更最比跟同向每该些把被'.split(''),
);
const isFunctionGram = (gram) => [...gram].every((c) => FUNCTION_CHARS.has(c));

export function crossChapterNGrams(chapters, n = 4, minChapters = 2) {
  const map = new Map(); // ngram -> Set(chapter name)
  for (const ch of chapters) {
    const flat = ch.text.replace(/\s+/g, '');
    const seen = new Set();
    for (let i = 0; i + n <= flat.length; i++) {
      const gram = flat.slice(i, i + n);
      if (isFunctionGram(gram)) continue;
      if (/[，。！？、；：「」“”（）《》]/.test(gram)) continue;
      if (!seen.has(gram)) {
        seen.add(gram);
        const set = map.get(gram) || new Set();
        set.add(ch.name);
        map.set(gram, set);
      }
    }
  }
  return [...map.entries()]
    .filter(([, chaps]) => chaps.size >= minChapters)
    .map(([phrase, chaps]) => ({ phrase, chapters: [...chaps], chapterCount: chaps.size }))
    .sort((a, b) => b.chapterCount - a.chapterCount || a.phrase.localeCompare(b.phrase));
}

/* ---------- 连接词 / 句式 tics ---------- */
const NOT_X_BUT_Y = /不是[^，。！？]{1,15}[，,]?而是/g;
const CLICHE_CONNECTIVES = [
  '值得注意', '综上所述', '总的来说', '总而言之', '重要的是', '换言之', '与此同时', '由此可见',
  '毋庸置疑', '不难发现', '深吸一口气', '眼中闪过', '心中一紧', '不禁', '恍然大悟',
];

export function measureConnectiveTics(text) {
  const flat = text.replace(/\s+/g, '');
  const per1k = (count) => (flat.length ? +((count / flat.length) * 1000).toFixed(2) : 0);
  const notBut = (flat.match(NOT_X_BUT_Y) || []).length;
  const tics = [];
  if (notBut > 0) tics.push({ phrase: '不是X而是Y', count: notBut, ratePer1k: per1k(notBut) });
  for (const phrase of CLICHE_CONNECTIVES) {
    let count = 0;
    let idx = flat.indexOf(phrase);
    while (idx !== -1) {
      count++;
      idx = flat.indexOf(phrase, idx + phrase.length);
    }
    if (count > 0) tics.push({ phrase, count, ratePer1k: per1k(count) });
  }
  return tics.sort((a, b) => b.count - a.count);
}

/* ---------- 句长节奏均匀度 ---------- */
export function measureSentenceRhythm(text) {
  const sents = splitSentences(text);
  if (sents.length < 3) return { mean: 0, variance: 0, cv: 0, uniformity: false, sentenceCount: sents.length };
  const lens = sents.map((s) => s.length);
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
  const sd = Math.sqrt(variance);
  const cv = mean ? sd / mean : 0; // 变异系数：低 = 语调恒定
  return { mean: +mean.toFixed(1), variance: +variance.toFixed(1), cv: +cv.toFixed(3), uniformity: cv < 0.35, sentenceCount: sents.length };
}

/* ---------- 比喻/意象密度 ---------- */
const METAPHOR = /像|仿佛|宛如|犹如|如同|好似|似的|一般|般|恍如|犹如/g;

export function measureMetaphorDensity(text) {
  const flat = text.replace(/\s+/g, '');
  const count = (flat.match(METAPHOR) || []).length;
  const ratePer1k = flat.length ? +((count / flat.length) * 1000).toFixed(2) : 0;
  return { count, ratePer1k, high: ratePer1k > 6 };
}

/* ---------- 主审计 ---------- */
export function auditChapters(chapters, opts = {}) {
  const top = opts.top ?? 10;
  const bodyText = (ch) => ch.text.replace(/\s+/g, '');

  const openingPatterns = clusterBySignature(chapters, (ch) => splitSentences(ch.text).slice(0, 1)).slice(0, top);
  const closingPatterns = clusterBySignature(chapters, (ch) => {
    const s = splitSentences(ch.text);
    return s.slice(-1);
  }).slice(0, top);

  const allText = chapters.map((c) => c.text).join('\n');
  const rhythm = measureSentenceRhythm(allText);
  const metaphor = measureMetaphorDensity(allText);
  const tics = measureConnectiveTics(allText).slice(0, top);
  const ngrams = crossChapterNGrams(chapters, 4, 2).slice(0, top);

  // 汇总 flags（供人眼快速定位）
  const flags = [];
  for (const p of openingPatterns) {
    if (p.signature.hasTimeWord) flags.push(`公文式时间开头同构（T2）：${p.chapters.length} 章同签名，如 ${p.chapters.slice(0, 3).join('、')}`);
    else flags.push(`开头句式同构（T1）：${p.chapters.length} 章同签名，如 ${p.chapters.slice(0, 3).join('、')}`);
  }
  for (const p of closingPatterns) flags.push(`收尾句式同构（T1/T6）：${p.chapters.length} 章同签名，如 ${p.chapters.slice(0, 3).join('、')}`);
  if (ngrams.length) flags.push(`跨章 n-gram 重复（T3）：如「${ngrams[0].phrase}」出现在 ${ngrams[0].chapterCount} 章`);
  const notBut = tics.find((t) => t.phrase === '不是X而是Y');
  if (notBut && notBut.ratePer1k > 0.5) flags.push(`「不是X而是Y」句式偏高（T5）：${notBut.ratePer1k}/千字`);
  if (metaphor.high) flags.push(`比喻密度偏高（T4）：${metaphor.ratePer1k}/千字`);
  if (rhythm.uniformity) flags.push(`句长节奏高度均匀（T7）：变异系数 ${rhythm.cv}`);

  return {
    meta: {
      chapterCount: chapters.length,
      totalChars: chapters.reduce((a, c) => a + bodyText(c).length, 0),
      generatedAt: new Date().toISOString(),
    },
    openingPatterns,
    closingPatterns,
    crossChapterNGrams: ngrams,
    connectiveTics: tics,
    sentenceRhythm: rhythm,
    metaphorDensity: metaphor,
    flags,
  };
}

/* ---------- 人读报告 ---------- */
export function formatReport(report) {
  const L = [];
  L.push(`# 同型审计报告`);
  L.push(``);
  L.push(`章节 ${report.meta.chapterCount} 个 · 正文 ${report.meta.totalChars} 字 · ${report.meta.generatedAt}`);
  L.push(``);
  L.push(`## 需复核项（flags）`);
  if (report.flags.length === 0) L.push(`（未命中明显同型，仍建议人眼抽查）`);
  for (const f of report.flags) L.push(`- ${f}`);
  L.push(``);
  L.push(`## 开头句式聚类（T1/T2）`);
  for (const p of report.openingPatterns) {
    L.push(`- 签名 \`${p.signature.key}\`（${p.chapters.length} 章）：${p.chapters.join('、')}`);
  }
  L.push(``);
  L.push(`## 收尾句式聚类（T1/T6）`);
  for (const p of report.closingPatterns) {
    L.push(`- 签名 \`${p.signature.key}\`（${p.chapters.length} 章）：${p.chapters.join('、')}`);
  }
  L.push(``);
  L.push(`## 跨章 n-gram 重复（T3）`);
  for (const g of report.crossChapterNGrams) {
    L.push(`- 「${g.phrase}」→ ${g.chapterCount} 章：${g.chapters.join('、')}`);
  }
  L.push(``);
  L.push(`## 连接词 tics（T5/T8）`);
  for (const t of report.connectiveTics) {
    L.push(`- ${t.phrase}：${t.count} 次（${t.ratePer1k}/千字）`);
  }
  L.push(``);
  L.push(`## 节奏与密度`);
  L.push(`- 句长：均值 ${report.sentenceRhythm.mean} · 变异系数 ${report.sentenceRhythm.cv}${report.sentenceRhythm.uniformity ? '（⚠️ 均匀）' : ''}`);
  L.push(`- 比喻密度：${report.metaphorDensity.ratePer1k}/千字${report.metaphorDensity.high ? '（⚠️ 偏高）' : ''}`);
  return L.join('\n');
}

/* ---------- CLI ---------- */
function parseArgs(argv) {
  const args = { json: false, top: 10, out: null, input: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--top') args.top = Number(argv[++i]) || 10;
    else if (a === '--out') args.out = argv[++i];
    else if (!a.startsWith('--') && !args.input) args.input = a;
  }
  return args;
}

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error('用法：node audit.mjs <章节目录或文件> [--json] [--top N] [--out 报告路径]');
    process.exit(1);
  }
  const chapters = loadChapters(args.input);
  if (chapters.length === 0) {
    console.error('未找到 .md/.txt 章节文件');
    process.exit(1);
  }
  const report = auditChapters(chapters, { top: args.top });
  const outText = args.json ? JSON.stringify(report, null, 2) : formatReport(report);
  if (args.out) {
    writeFileSync(args.out, outText);
    console.error(`报告已写入 ${args.out}`);
  } else {
    console.log(outText);
  }
}
