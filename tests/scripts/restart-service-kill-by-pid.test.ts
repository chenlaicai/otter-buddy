/**
 * F20261008hcpa（#1356 层2 疏通）：restart-service.mjs kill-by-pid 校验逻辑单测。
 *
 * 覆盖 assertKillByPidSafe 静态不变式：PID 合法性、主进程/自身/父进程拒绝、
 * projectDir 在工作根内。lsof 探测（进程存在性/cwd 归属）沿用 #844 口径：脚本内逻辑 + 手工冒烟。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { assertKillByPidSafe, killByPidAllowedRoots } from '../../scripts/restart-service.mjs';

const allowedRoot = path.join(os.tmpdir(), 'fake-otter-workroot');
const projectDir = path.join(allowedRoot, 'colink');
const outsideDir = path.join(os.tmpdir(), 'outside-evil');

describe('assertKillByPidSafe（#1356 kill-by-pid）', () => {
  const base = { pid: 12345, projectDir, mainPid: 999, selfPid: 100, selfPpid: 99, allowedRoots: [allowedRoot] };

  it('正常 PID + 工作根内 projectDir → 通过', () => {
    expect(assertKillByPidSafe(base)).toEqual({ ok: true });
  });

  it('PID <= 1（init/launchd）恒拒', () => {
    expect(assertKillByPidSafe({ ...base, pid: 1 }).ok).toBe(false);
    expect(assertKillByPidSafe({ ...base, pid: 0 }).ok).toBe(false);
    expect(assertKillByPidSafe({ ...base, pid: -5 }).ok).toBe(false);
  });

  it('缺 --project 拒绝', () => {
    const r = assertKillByPidSafe({ ...base, projectDir: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('--project');
  });

  it('projectDir 在工作根外拒绝', () => {
    const r = assertKillByPidSafe({ ...base, projectDir: outsideDir });
    expect(r.ok).toBe(false);
  });

  it('projectDir 为工作根根本身拒绝', () => {
    const r = assertKillByPidSafe({ ...base, projectDir: allowedRoot });
    expect(r.ok).toBe(false);
  });

  it('PID === 主进程拒绝', () => {
    const r = assertKillByPidSafe({ ...base, pid: 999 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('主进程');
  });

  it('PID === 自身/父进程拒绝', () => {
    expect(assertKillByPidSafe({ ...base, pid: 100 }).ok).toBe(false);
    expect(assertKillByPidSafe({ ...base, pid: 99 }).ok).toBe(false);
  });

  it('mainPid 为 null（PID 文件缺失）不误拒', () => {
    expect(assertKillByPidSafe({ ...base, pid: 999, mainPid: null })).toEqual({ ok: true });
  });

  it('非整数 PID 拒绝', () => {
    expect(assertKillByPidSafe({ ...base, pid: NaN }).ok).toBe(false);
    expect(assertKillByPidSafe({ ...base, pid: 1.5 }).ok).toBe(false);
  });
});

// ── #1580 固化失败用例（修复前必失败）：alpha 规范数据根内 projectDir 应放行 ──
describe('#1580：alpha 规范数据根（~/.otter/alpha/<hash>）内 projectDir 放行', () => {
  const alphaRoot = path.join(os.homedir(), '.otter', 'alpha');
  const alphaProject = path.join(alphaRoot, '8f113208');
  const base = { pid: 12345, projectDir: alphaProject, mainPid: 999, selfPid: 100, selfPpid: 99, allowedRoots: [allowedRoot, alphaRoot] };

  it('alpha 数据根内 projectDir → 应通过（当前被工作根校验误拒）', () => {
    expect(assertKillByPidSafe(base)).toEqual({ ok: true });
  });

  it('alpha 数据根根本身 → 拒绝（非根本身语义保留）', () => {
    const r = assertKillByPidSafe({ ...base, projectDir: alphaRoot });
    expect(r.ok).toBe(false);
  });

  it('alpha 数据根外同级目录 → 仍拒绝（授权面不外溢）', () => {
    const r = assertKillByPidSafe({ ...base, projectDir: path.join(os.homedir(), '.otter', 'evil') });
    expect(r.ok).toBe(false);
  });

  it('空 allowedRoots → 拒绝（fail-closed）', () => {
    const r = assertKillByPidSafe({ ...base, allowedRoots: [] });
    expect(r.ok).toBe(false);
  });
});

// ── 检视 A4/A5：wiring 覆盖 + 双源对齐（防调用点/硬编码根漂移静默失效）──
describe('#1580 wiring 与双源对齐', () => {
  it('killByPidAllowedRoots 双根 = otter 工作根 + alpha 规范数据根', () => {
    const roots = killByPidAllowedRoots('/Users/orca/ai/otter-buddy');
    expect(roots).toEqual([
      '/Users/orca/ai',
      path.join(os.homedir(), '.otter', 'alpha'),
    ]);
  });

  it('alpha 根与 alpha.sh alpha_root_dir 等值比对（双源真相防漂移，检视 D2）', () => {
    const alphaSh = fs.readFileSync(
      fileURLToPath(new URL('../../scripts/alpha.sh', import.meta.url)),
      'utf8',
    );
    // 从 alpha_root_dir() 提取 "$HOME/<suffix>/…" 的 suffix（如 /.otter/alpha），与生产根等值比较——
    // 前缀存在性匹配防不住 suffix 漂移（如 alphav2），必须严格相等才算对齐
    const m = alphaSh.match(/alpha_root_dir\(\)\s*\{\s*echo\s+"\$HOME([^"$]+)\//);
    expect(m).not.toBeNull();
    const declaredRoot = path.join(os.homedir(), m![1]);
    expect(killByPidAllowedRoots('/Users/orca/ai/otter-buddy')[1]).toBe(declaredRoot);
  });
});
