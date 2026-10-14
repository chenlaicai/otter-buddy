/**
 * guard-touchstone 三库冻结完整性断言（F20261012gtfr）
 *
 * 契约（bash-guard-one-shot-plan.md v3 §四 + review-one-shot-plan-delta 双签结论）：
 *  - 进库冻结：verdict 二值（ALLOW/BLOCK），SKIP=0，追加须双签+呈报
 *  - 命令级去重：截断态 unique 1006 → 全文恢复后 918（17 组恢复撞车合并，双签处置为准）
 *  - 条件期望：无 cd cwd 不可反查条目双态各跑（worktree→ALLOW / 主仓→BLOCK）
 *  - 残余面 7 条 residual_face 如实钉 BLOCK——不许隐身、不许被当「修复面」悄悄放开
 *  - 语料回归属性：本文件只管冻结完整性；「judge 考试」（能力补全后全量试金石复跑）
 *    随能力 PR 落地，验收门是放行池 100% + 拦截池 100%（全过才切）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(__dirname, '..', '..', 'fixtures');
interface Lib { meta: { count: number; [k: string]: unknown }; entries: TouchstoneEntry[] }
const load = (name: string): Lib => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

const allow = load('guard-touchstone-allow.json');
const block = load('guard-touchstone-block.json');
const cond = load('guard-touchstone-conditional.json');

// 残余面 7 条显式钉名（§3.3-①：真实误拦但 fail-closed 仍拦——放宽须重新裁决）
const RESIDUAL_IDS = [
  'TS-40e54fac', // game/index.html new Function 脚本评测
  'TS-b61fa381', // game/index.html new Function 脚本评测（同族）
  'TS-2562bd65', // kelp-audit index.html new Function
  'TS-ef0d6be4', // game html 校验链（内层 new Function）
  'TS-547d0252', // worktree 正道 execSync（strip-ts-comments 注入测试）
  'TS-1acea2b8', // worktree 正道 execSync（npm run check）
  'TS-1c317a90', // colink 后端正道 execSync（mysql 查询）
];

interface TouchstoneEntry {
  id: string;
  command: string;
  verdict?: string;
  conditional?: boolean;
  expectations?: Array<{ cwd: string; verdict: string }>;
  kind?: string;
  adjudication?: string[];
  source?: { anchors?: unknown[] };
}

const all: TouchstoneEntry[] = [...allow.entries, ...block.entries, ...cond.entries];

describe('guard-touchstone 三库冻结完整性', () => {
  it('meta 契约字段齐全（plan / 裁决标准 / 冻结契约 / 双签依据）', () => {
    for (const lib of [allow, block, cond]) {
      expect(lib.meta.plan).toContain('bash-guard-one-shot-plan.md');
      expect(lib.meta.adjudication_standard).toContain('§3.2.1');
      expect(lib.meta.contract).toContain('进库冻结');
      expect(lib.meta.contract).toContain('SKIP=0');
      expect(lib.meta.double_sign).toContain('双签');
      expect(lib.meta.count).toBe(lib.entries.length);
    }
  });

  it('verdict 二值 + SKIP=0：放行池全 ALLOW，拦截池全 BLOCK，条件库双态二值', () => {
    for (const e of allow.entries) expect(e.verdict).toBe('ALLOW');
    for (const e of block.entries) expect(e.verdict).toBe('BLOCK');
    for (const e of cond.entries) {
      expect(e.conditional).toBe(true);
      expect(e.expectations).toHaveLength(2);
      const byCwd = Object.fromEntries(e.expectations!.map((x) => [x.cwd, x.verdict]));
      expect(byCwd.worktree).toBe('ALLOW');
      expect(byCwd.main).toBe('BLOCK');
    }
    // SKIP 防稀释：任何条目任何位置不得出现 SKIP
    for (const e of all) {
      expect(e.verdict).not.toBe('SKIP');
      for (const x of e.expectations ?? []) expect(x.verdict).not.toBe('SKIP');
    }
  });

  it('每条带来源锚点与裁决依据（禁静默条目）', () => {
    for (const e of all) {
      expect(e.id).toBeTruthy();
      expect(e.command.length).toBeGreaterThan(4);
      expect(e.source?.anchors?.length ?? 0).toBeGreaterThan(0);
      expect(e.adjudication?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('id 与命令跨三库唯一（归一化去重契约）', () => {
    const ids = all.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const cmds = all.map((e) => e.command);
    expect(new Set(cmds).size).toBe(cmds.length);
  });

  it('残余面 7 条 residual_face 如实钉住（不许隐身、不许静默放开）', () => {
    const byId = new Map<string, TouchstoneEntry>(
      block.entries.map((e): [string, TouchstoneEntry] => [e.id, e]),
    );
    for (const id of RESIDUAL_IDS) {
      const e = byId.get(id);
      expect(e, `残余面 ${id} 缺失——删改须重新裁决+双签`).toBeDefined();
      expect(e!.kind).toBe('residual_face');
      expect(e!.verdict).toBe('BLOCK');
      expect(e!.adjudication![0]).toContain('残余面');
    }
  });

  it('全量遍历：三库合计与构建记录守恒（真实语料 921 条恒等：794+72+105−新增 TS-smrj 系 50 条）', () => {
    expect(all.length).toBe(allow.meta.count + block.meta.count + cond.meta.count);
    // 2026-10-13 F20261013smrj：4 条会话态 cwd=worktree 相对路径原地编辑改条件期望（改批错的答案，请双签）
    //  allow 770→766 / cond 101→105（守恒不变）；block +14 合成对抗负门（严重1）。
    // 2026-10-14 F20261014smrj 工单②：allow +28 回归闸（影子裁决批 25+3，TS-smrjreg 前缀）
    //  block +4 三牙负门（TS-smrj 系）——追加依据大獭工单+裁决 signal d5f2ae9a，检视獭 delta 复核在途。
    expect(allow.meta.count).toBe(794);
    expect(block.meta.count).toBe(72); // 50 真实语料 + 14 合成对抗负门（严重1）+ 4 三牙负门（工单②）+ 4 exec 负门（delta2）
    expect(cond.meta.count).toBe(105);
    // 真实语料守恒 921（不含 TS-smrj 前缀新增：22 负门 + 28 回归闸）
    const addedGate = [...allow.entries, ...block.entries, ...cond.entries].filter((e) => e.id.startsWith('TS-smrj')).length;
    expect(allow.meta.count + block.meta.count + cond.meta.count - addedGate).toBe(921);
    // 变更计数锚（重刷期望前后差异，详见 touchstone-recheck-diff.md）
    expect(allow.meta.restate_changes).toMatchObject({
      git_policy_flip: 68, to_conditional: 108, o2_pooled: 26, o2_excl: 20, ledger_dispose: 8,
    });
  });
});
