/**
 * guard-touchstone 「judge 考试」（bash-guard-one-shot-plan.md §四 验收核心）
 *
 * 988 条真实数据考题对求值器 v2 全量复跑（试金石 = 搭档方法论：运行的真实数据当考题）：
 *  - 放行池 770 条：必须**正面 ALLOW**——evaluated 且写落点 ∩ 主仓树 = ∅；
 *    fail-closed 不算过（「非回落恰好放行」验收语义，§4.1）
 *  - 拦截池 49 条：必须 BLOCK——positive 落点证据 或 fail-closed（§3.3 读不出终局，
 *    残余面 7 条即以此态如实钉 BLOCK）
 *  - 条件期望 101 条：双态各跑（startCwd=worktree→正面 ALLOW；startCwd=main→BLOCK）
 *
 * 开发棘轮 KNOWN_GAPS（能力补全 1-8 进行中的已知缺口）：
 *  - 只许单调缩小——任何新缺口/回归 = 红，「一步都不许带红前进」的机械护栏
 *  - 能力 1-8 完成后清空并**删除本清单**（考试即 CI 验收门，不留放水口）
 *  - 键格式：`<id>`（放行/拦截池）/ `<id>#wt`、`<id>#main`（条件期望）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateWriteVerdict } from '../../../src/frameworks/agent/write-verdict';

const FIXTURES = join(__dirname, '..', '..', 'fixtures');
interface Entry {
  id: string;
  command: string;
  verdict?: string;
  conditional?: boolean;
  expectations?: Array<{ cwd: string; verdict: string }>;
}
interface Lib { meta: { count: number }; entries: Entry[] }
const load = (name: string): Lib => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

const allow = load('guard-touchstone-allow.json');
const block = load('guard-touchstone-block.json');
const cond = load('guard-touchstone-conditional.json');

/** 语料匿名口径的两态 cwd（/repo = 主仓根、/repo/.otter/worktrees/wt = worktree） */
const ROOT = '/repo';
const WT = '/repo/.otter/worktrees/wt';

type GapMap = Record<string, string>;

/** 单条求值（异常兜底：抛错按 fail-closed 记缺口，不让 harness 崩）。 */
function runVerdict(command: string, startCwd: string) {
  try {
    return evaluateWriteVerdict(command, ROOT, startCwd);
  } catch (e) {
    return { verdict: 'BLOCK' as const, mode: 'fail-closed' as const, reason: `threw: ${(e as Error).message}` };
  }
}

function allowGaps(): GapMap {
  const gaps: GapMap = {};
  for (const e of allow.entries) {
    const r = runVerdict(e.command, ROOT);
    if (!(r.verdict === 'ALLOW' && r.mode === 'positive')) {
      gaps[e.id] = r.mode === 'fail-closed' ? `fail-closed(${r.reason})` : '正面 BLOCK（写落点误报主仓）';
    }
  }
  return gaps;
}

function blockGaps(): GapMap {
  const gaps: GapMap = {};
  for (const e of block.entries) {
    const r = runVerdict(e.command, ROOT);
    if (r.verdict !== 'BLOCK') {
      gaps[e.id] = '放水（求值器判 ALLOW——拦截池必须拦）';
    }
  }
  return gaps;
}

function condGaps(): GapMap {
  const gaps: GapMap = {};
  for (const e of cond.entries) {
    const wt = runVerdict(e.command, WT);
    if (!(wt.verdict === 'ALLOW' && wt.mode === 'positive')) {
      gaps[`${e.id}#wt`] = wt.mode === 'fail-closed' ? `fail-closed(${wt.reason})` : '正面 BLOCK（worktree 态应放）';
    }
    const main = runVerdict(e.command, ROOT);
    if (main.verdict !== 'BLOCK') {
      gaps[`${e.id}#main`] = '放水（主仓态应拦）';
    }
  }
  return gaps;
}

/**
 * 开发棘轮：已知缺口（按池分桶：allow/block/cond，键 → 一句话原因）存 fixture——
 * EXAM_REGEN=1 复跑时机械再生。每步只许删键，不许加键（新缺口/回归 = 红）；
 * 能力 1-8 完成后本文件内容应为 {}，届时删除本清单与 fixture，考试升级为零容忍。
 */
const GAPS_FILE = join(FIXTURES, 'guard-touchstone-exam-gaps.json');
const EMPTY_GAPS = { allow: {} as GapMap, block: {} as GapMap, cond: {} as GapMap };
const KNOWN_GAPS: typeof EMPTY_GAPS = (() => {
  try { return { ...EMPTY_GAPS, ...JSON.parse(readFileSync(GAPS_FILE, 'utf8')) }; } catch { return EMPTY_GAPS; }
})();

function expectRatchet(pool: 'allow' | 'block' | 'cond', actual: GapMap): void {
  const actualKeys = Object.keys(actual).sort();
  const known = KNOWN_GAPS[pool];
  const knownKeys = Object.keys(known).sort();
  if (process.env.EXAM_REGEN === '1') {
    // 再生模式：按池**替换**（闭合缺口随之移除——收缩可见）；仅限开发期基线/有意重定基，
    // 评审看 diff，配套 shrink-only 验证（新缺口=回归）
    KNOWN_GAPS[pool] = { ...actual };
    writeFileSync(GAPS_FILE, JSON.stringify(KNOWN_GAPS, null, 2));
    console.error('EXAM_REGEN:', pool, 'gaps =', Object.keys(KNOWN_GAPS[pool]).length);
    return;
  }
  if (actualKeys.join(',') !== knownKeys.join(',')) {
    console.error('GAP_DIFF', pool, JSON.stringify(actual));
  }
  expect(actualKeys).toEqual(knownKeys);
}

describe('guard-touchstone judge 考试（988 条全量复跑）', () => {
  it('放行池 770 条全部正面 ALLOW（fail-closed 不算过）', () => {
    expectRatchet('allow', allowGaps());
  }, 60_000);

  it('拦截池 49 条全部 BLOCK（正面落点或 fail-closed 终局）', () => {
    expectRatchet('block', blockGaps());
  }, 60_000);

  it('条件期望 101 条双态各跑（worktree→正面 ALLOW / 主仓→BLOCK）', () => {
    expectRatchet('cond', condGaps());
  }, 60_000);
});
