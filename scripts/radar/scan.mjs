#!/usr/bin/env node
/**
 * 每日 AI 雷达 · 确定性抓取层（零 LLM）
 * 真相源文档：scripts/radar/README.md
 * 用法：node scan.mjs [输出数据目录]（缺省为脚本旁 data/）
 *       输出数据目录指工作区的 data 目录，产物落 <目录>/raw/YYYY-MM-DD.json
 *       stdout 同步打印摘要，供 LLM 分拣层直接消费
 * 来源：原「外部洞察」对话工作区 radar/scan.mjs 入库，
 *       抓取逻辑零改动，仅输出目录参数化（运行时数据不进仓库）。
 */

import { writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  selectHackerNewsItem,
  sortHackerNewsItems,
  sortGitHubItems,
  selectAnthropicItems,
  assembleRawResult,
  formatRadarSummary,
} from './scan-lib.mjs';

/* global setTimeout */ // eslint no-undef：Node 全局在 .mjs 下需显式声明（同 scripts/backup-runtime-data.mjs 惯例）

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(process.argv[2] || join(SCRIPT_DIR, '..', 'data'));
const RAW_DIR = join(DATA_DIR, 'raw');
const TODAY = new Date().toISOString().slice(0, 10);
const OUT = join(RAW_DIR, `${TODAY}.json`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 源 1：Hacker News top60 → 正则粗筛 AI 相关 ---------- */
async function fetchHN() {
  const out = [];
  try {
    const ids = (await (await fetch('https://hacker-news.firebaseio.com/v0/topstories.json')).json()).slice(0, 60);
    for (const id of ids) {
      try {
        const i = await (await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)).json();
        const selected = selectHackerNewsItem(i, id);
        if (selected) out.push(selected);
      } catch { /* 单条失败跳过 */ }
      await sleep(150); // 实测并发抓取会被 reset，必须串行+间隔
    }
  } catch (e) {
    return { items: out, error: String(e) };
  }
  return { items: sortHackerNewsItems(out) };
}

/* ---------- 源 2：GitHub search API，3 个 topic 查询 ---------- */
const GH_TOPICS = ['ai-agent', 'llm', 'mcp'];
async function fetchGitHub() {
  const out = [];
  const errors = [];
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  for (const topic of GH_TOPICS) {
    try {
      const q = `topic:${topic}+created:>${weekAgo}&sort=stars&order=desc&per_page=10`;
      const r = await (await fetch(`https://api.github.com/search/repositories?q=${q}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'otter-radar' },
      })).json();
      for (const it of r.items || []) {
        out.push({ repo: it.full_name, desc: it.description || '', stars: it.stargazers_count, created: it.created_at, topic });
      }
      await sleep(400);
    } catch (e) { errors.push(`${topic}: ${e}`); }
  }
  return { items: sortGitHubItems(out), error: errors.length ? errors.join('; ') : undefined };
}

/* ---------- 源 3：Anthropic news（尽力而为源，失败不阻塞） ---------- */
async function fetchAnthropic() {
  try {
    const html = await (await fetch('https://www.anthropic.com/news', { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
    return { items: selectAnthropicItems(html) };
  } catch (e) {
    return { items: [], error: String(e) };
  }
}

/* ---------- 主流程 ---------- */
export async function main() {
  mkdirSync(RAW_DIR, { recursive: true });
  const [hn, gh, an] = await Promise.all([fetchHN(), fetchGitHub(), fetchAnthropic()]);

  const result = assembleRawResult({ date: TODAY, generatedAt: new Date().toISOString(), hackernews: hn, github: gh, anthropic: an });
  writeFileSync(OUT, JSON.stringify(result, null, 2));

  // stdout 摘要：给 LLM 分拣层直接消费
  process.stdout.write(formatRadarSummary({ result, outputPath: OUT }));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
