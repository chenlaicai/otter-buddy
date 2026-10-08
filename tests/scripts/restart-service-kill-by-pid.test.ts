/**
 * F20261008hcpa（#1356 层2 疏通）：restart-service.mjs kill-by-pid 校验逻辑单测。
 *
 * 覆盖 assertKillByPidSafe 静态不变式：PID 合法性、主进程/自身/父进程拒绝、
 * projectDir 在工作根内。lsof 探测（进程存在性/cwd 归属）沿用 #844 口径：脚本内逻辑 + 手工冒烟。
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import { assertKillByPidSafe } from '../../scripts/restart-service.mjs';

const allowedRoot = path.join(os.tmpdir(), 'fake-otter-workroot');
const projectDir = path.join(allowedRoot, 'colink');
const outsideDir = path.join(os.tmpdir(), 'outside-evil');

describe('assertKillByPidSafe（#1356 kill-by-pid）', () => {
  const base = { pid: 12345, projectDir, mainPid: 999, selfPid: 100, selfPpid: 99, allowedRoot };

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
