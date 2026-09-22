/**
 * F20260825dva2: validate-commit-date.mjs 的持久化测试。
 *
 * 覆盖 PR #435 处置记录中实测过的 11 用例 + DST 边界。
 * 所有用例注入固定 now 参数，避免依赖系统时钟。
 */
import { describe, it, expect } from 'vitest';
import { validateCommitDate } from '../../scripts/validate-commit-date.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../scripts/validate-commit-date.mjs');

// F20260914prdb: execFileSync 换 spawnSync——成功路径（exit 0）也要能收 stderr，
// 否则 --warn-on-drift 的警告文本无法断言（#789 定稿改名模型测试需要）
function runCLI(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf-8' });
  return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// 固定基准时间：2026-08-25 12:00 Asia/Shanghai（正午，避开午夜边界干扰）
const NOW = new Date('2026-08-25T12:00:00+08:00');

describe('validateCommitDate', () => {
  describe('F 类特性 ID 日期校验', () => {
    it('should pass when F-type ID date is today', () => {
      const result = validateCommitDate('[F20260825abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('ok');
      expect(result.diffDays).toBe(0);
    });

    it('should pass when F-type ID date is 1 day before', () => {
      const result = validateCommitDate('[F20260824abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(true);
      expect(result.diffDays).toBe(1);
    });

    it('should pass when F-type ID date is 1 day after', () => {
      const result = validateCommitDate('[F20260826abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(true);
      expect(result.diffDays).toBe(1);
    });

    it('should pass when F-type ID date is 2 days before', () => {
      const result = validateCommitDate('[F20260823abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(true);
      expect(result.diffDays).toBe(2);
    });

    it('should pass when F-type ID date is 2 days after', () => {
      const result = validateCommitDate('[F20260827abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(true);
      expect(result.diffDays).toBe(2);
    });

    it('should pass when F-type ID date is 3 days before', () => {
      // F20260913ctlv：±2 → ±7 放宽（原 ±2 系时区漂移推导，非特性周期限制——
      // 长周期 PR 的 commit/PR 标题撞闸是设计盲区，见 F20260913ctlv 收尾）
      const result = validateCommitDate('[F20260822abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(true);
      expect(result.diffDays).toBe(3);
    });

    it('should pass when F-type ID date is 7 days before', () => {
      const result = validateCommitDate('[F20260818abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(true);
      expect(result.diffDays).toBe(7);
    });

    it('should reject when F-type ID date is 8 days before', () => {
      const result = validateCommitDate('[F20260817abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('fail');
      expect(result.diffDays).toBe(8);
    });

    it('should reject when F-type ID date is 8 days after', () => {
      const result = validateCommitDate('[F20260902abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('fail');
      expect(result.diffDays).toBe(8);
    });
  });

  describe('R 类特性 ID — 跳过校验', () => {
    it('should skip date validation for R-type ID regardless of date', () => {
      const result = validateCommitDate('[R20260818c5xt][research] 研究文档', NOW);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('skip');
    });
  });

  describe('无 ID / Merge 短路', () => {
    it('should skip when commit message has no feature ID', () => {
      const result = validateCommitDate('chore: 一般提交', NOW);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('skip');
    });

    it('should skip for merge commit', () => {
      // Merge commit 在钩子层已 case 短路，但模块层也应优雅处理
      const result = validateCommitDate('Merge branch main into feature/xxx', NOW);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('skip');
    });
  });

  describe('非法日期', () => {
    it('should handle invalid date like month 13', () => {
      const result = validateCommitDate('[F20261325abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('bad_date');
    });

    it('should handle invalid date like day 40', () => {
      const result = validateCommitDate('[F20260840abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('bad_date');
    });

    it('should handle invalid date like Feb 30', () => {
      const result = validateCommitDate('[F20260230abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('bad_date');
    });
  });

  describe('DST 边界', () => {
    it('should handle date near DST transition correctly', () => {
      // Why: formatToParts 始终返回 Asia/Shanghai 本地日期，DST 不影响日期部分
      // 用 2026-03-08（DST 切换附近）的 UTC 晚间做基准
      const dstNow = new Date('2026-03-08T23:30:00Z'); // UTC 23:30 = Shanghai 3/9 07:30
      const result = validateCommitDate('[F20260309abcd][agent][Feature Update] 测试', dstNow);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('ok');
      expect(result.diffDays).toBe(0);
    });

    it('should handle midnight boundary in Asia/Shanghai', () => {
      // Why: 23:59 Shanghai 和 00:01 Shanghai 差 1 天，但都在 ±2 天容忍内
      const lateNight = new Date('2026-08-25T15:59:00Z'); // UTC 15:59 = Shanghai 23:59
      const result = validateCommitDate('[F20260824abcd][agent][Feature Update] 测试', lateNight);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('ok');
    });
  });

  describe('CLI --at 基准时间注入（F20260914prdb）', () => {
    // Why: CI 的 PR 标题校验改传 PR 创建时间（github.event.pull_request.created_at），
    // 必须验证 --at 参数语义：ID 日期与注入基准比对，而非与当前时间比对。
    // 复现 #789 现场：PR 创建于 2026-09-04，标题 ID 2026-09-04，但校验运行于 2026-09-14
    it('should pass when ID date matches PR creation time (10-day-old PR, #789 现场)', () => {
      const { exitCode } = runCLI([
        '--at', '2026-09-04T03:56:11Z',
        '[F20260904wxeg][weixin][BugFix] 出站 sendmessage 全量观测日志',
      ]);
      expect(exitCode).toBe(0);
    });

    it('should still reject when ID date is 8+ days off PR creation time', () => {
      // PR 创建于 2026-09-04，但标题写了 2026-08-25（差 10 天）→ 发起时就写错，仍应拦
      const { exitCode, stderr } = runCLI([
        '--at', '2026-09-04T03:56:11Z',
        '[F20260825abcd][agent][Feature Update] 测试',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('偏差');
    });

    it('should exit 1 when --at has no argument', () => {
      const { exitCode, stderr } = runCLI(['--at']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('--at');
    });

    it('should exit 1 when --at is not valid ISO time', () => {
      const { exitCode, stderr } = runCLI(['--at', 'not-a-date', '[F20260904wxeg][agent][BugFix] 测试']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('合法');
    });

    it('should not break --at usage without title (stdin path unaffected)', () => {
      // --at 剥离后无位置参数 → stdin 路径；空输入 exit 0（既有行为不变）
      const { exitCode } = runCLI(['--at', '2026-09-04T03:56:11Z']);
      // 无 stdin 输入时 readFileSync(0) 会读到空/EOF → exit 0
      expect([0, 1]).toContain(exitCode);
    });
  });

  describe('CLI 双基准与 --warn-on-drift（F20260914prdb 定稿改名模型）', () => {
    // 搭档决策 2026-09-14：squash 模型下 PR 标题即 main 历史，特性文档 ID ≡ PR 标题 ID；
    // PR 定稿改名（创建日→合入日）后，双基准任一通过：创建基准覆盖旧 ID，当前基准覆盖新 ID
    it('dual-base: 定稿改名合入日后，--at 创建时间基准被当前时间基准救回（PR 标题改名场景）', () => {
      // #789 现场语义：创建=今天-10 天（超窗），定稿改名=今天（与当前差 0 天 → 当前基准救回）。
      // F20260922ctxi 修复时间炸弹：原 fixture 硬编码 2026-09-04 / 2026-09-14（隐含「今天=9-14」，
      // 标题日期距今 >7 天后救回窗口失效、用例必挂）——改为相对日期动态生成，语义不变。
      const today = new Date();
      const tenDaysAgo = new Date(today.getTime() - 10 * 24 * 3600_000);
      const fid = (d: Date) => `F${d.toISOString().slice(0, 10).replace(/-/g, '')}wxeg`;
      const { exitCode } = runCLI([
        '--at', tenDaysAgo.toISOString(),
        `[${fid(today)}][weixin][BugFix] 出站 sendmessage 全量观测日志`,
      ]);
      expect(exitCode).toBe(0);
    });

    it('dual-base: 创建日 ID 持续肠通（--at 基准通过，与当前时间无关）', () => {
      const { exitCode } = runCLI([
        '--at', '2026-09-04T03:56:11Z',
        '[F20260904wxeg][weixin][BugFix] 出站 sendmessage 全量观测日志',
      ]);
      expect(exitCode).toBe(0);
    });

    it('dual-base: 两基准都不在窗内仍拦（发起时就写错且未改名）', () => {
      // 创建 9-04，标题写 8-25（差 10 天）且与今天也超窗 → 拦
      const { exitCode, stderr } = runCLI([
        '--at', '2026-09-04T03:56:11Z',
        '[F20260825abcd][agent][Feature Update] 测试',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('偏差');
    });

    it('--warn-on-drift: 偏差超窗降为警告 exit 0（钩子场景）', () => {
      const { exitCode, stderr } = runCLI([
        '--warn-on-drift',
        '[F20260801abcd][agent][Feature Update] 测试',
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toContain('警告');
    });

    it('--warn-on-drift: bad_date 非法日期仍硬拦（凭印象编日期笔误仍被拦下）', () => {
      const { exitCode, stderr } = runCLI([
        '--warn-on-drift',
        '[F20261325abcd][agent][Feature Update] 测试',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('非法');
    });
  });

  describe('CLI 退出码（集成）', () => {
    // Why: CLI 集成用例走真实脚本，脚本用系统当前日期判定偏差（±2 天）。
    // 硬编码日期会在日期滚动后必然失败（#422 同源教训：禁止凭印象标日期）。
    // 动态生成「今天/3 天前」的日期，测试永不随时间衰减。
    const today = new Date();
    const ymd = (d: Date) =>
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
        d.getDate(),
      ).padStart(2, '0')}`;
    // 本地时区近似即可：±7 天容忍下 UTC/Shanghai 差 1 天不影响结论
    // F20260913ctlv：±2 → ±7 放宽，集成测试用 8 天前才应拒绝
    const eightDaysAgo = new Date(today.getTime() - 8 * 24 * 3600 * 1000);

    it('should exit 0 for valid F-type commit', () => {
      const { exitCode } = runCLI([`[F${ymd(today)}abcd][agent][Feature Update] 测试`]);
      expect(exitCode).toBe(0);
    });

    it('should exit 1 for rejected F-type commit (偏差 > 7 天)', () => {
      const { exitCode, stderr } = runCLI([`[F${ymd(eightDaysAgo)}abcd][agent][Feature Update] 测试`]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('偏差');
    });

    it('should exit 1 for bad_date (month 13)', () => {
      const { exitCode, stderr } = runCLI(['[F20261325abcd][agent][Feature Update] 测试']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('非法');
    });

    it('should exit 1 for bad_date (day 40)', () => {
      const { exitCode } = runCLI(['[F20260840abcd][agent][Feature Update] 测试']);
      expect(exitCode).toBe(1);
    });

    it('should exit 0 for R-type commit (skip)', () => {
      const { exitCode } = runCLI(['[R20260818c5xt][research] 研究文档']);
      expect(exitCode).toBe(0);
    });
  });
});
