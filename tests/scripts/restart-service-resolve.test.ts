/**
 * #1069：restart-service.mjs resolvePortEntry 单测（纯逻辑 + tmp 目录驱动文件 IO）。
 *
 * 覆盖：白名单缺失/端口未声明时的两条正道（--add 现场声明 vs 拒绝+指引）、
 * --add 写回保留既有 entries、projectDir 不一致拒绝、损坏 JSON 不覆盖、
 * main-guard（被 import 时不触发主流程）。
 *
 * 注：execFileSync/lsof 级校验（PID/cwd）仍靠脚本内逻辑 + 手工冒烟（#844 原口径）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { resolvePortEntry } from '../../scripts/restart-service.mjs';

describe('#1069 resolvePortEntry（白名单声明解析）', () => {
  let tmpDir: string;
  let wlPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-svc-'));
    wlPath = path.join(tmpDir, '.otter', 'allowed-service-ports.json');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeWl = (services: unknown[]) => {
    fs.mkdirSync(path.dirname(wlPath), { recursive: true });
    fs.writeFileSync(wlPath, JSON.stringify({ services }, null, 2));
  };

  it('端口已声明：直接返回 entry，projectDir 缺省取声明值', () => {
    writeWl([{ port: 3001, projectDir: '/Users/x/colink' }]);
    const r = resolvePortEntry({ port: 3001, projectDir: null, add: false, whitelistPath: wlPath });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.port).toBe(3001);
      expect(r.declaredDir).toBe('/Users/x/colink');
    }
  });

  it('端口已声明但 --project 不一致：拒绝（原语义保留）', () => {
    writeWl([{ port: 3001, projectDir: '/Users/x/colink' }]);
    const r = resolvePortEntry({ port: 3001, projectDir: '/Users/x/other', add: false, whitelistPath: wlPath });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('不一致');
  });

  it('白名单缺失且无 --add：拒绝，错误信息含两条正道指引', () => {
    const r = resolvePortEntry({ port: 3100, projectDir: null, add: false, whitelistPath: wlPath });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('端口白名单不存在');
      expect(r.error).toContain('--add');
      expect(r.error).toContain('请搭档创建');
    }
    expect(fs.existsSync(wlPath)).toBe(false); // 不偷偷创建
  });

  it('白名单缺失 + --add --project：从空 services 创建并写回，返回 declared', () => {
    const r = resolvePortEntry({ port: 3100, projectDir: '/Users/x/dongbeicun', add: true, whitelistPath: wlPath });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.declared).toBe(true);
      expect(r.declaredDir).toBe('/Users/x/dongbeicun');
    }
    const onDisk = JSON.parse(fs.readFileSync(wlPath, 'utf-8'));
    expect(onDisk.services).toEqual([{ port: 3100, projectDir: '/Users/x/dongbeicun' }]);
  });

  it('端口未声明 + --add：写回保留既有 entries', () => {
    writeWl([{ port: 3001, projectDir: '/Users/x/colink' }]);
    const r = resolvePortEntry({ port: 3100, projectDir: '/Users/x/dongbeicun', add: true, whitelistPath: wlPath });
    expect(r.ok).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(wlPath, 'utf-8'));
    expect(onDisk.services).toHaveLength(2);
    expect(onDisk.services).toContainEqual({ port: 3001, projectDir: '/Users/x/colink' });
    expect(onDisk.services).toContainEqual({ port: 3100, projectDir: '/Users/x/dongbeicun' });
  });

  it('端口未声明且无 --add：拒绝，错误信息含白名单现状 + 两条正道', () => {
    writeWl([{ port: 3001, projectDir: '/Users/x/colink' }]);
    const r = resolvePortEntry({ port: 9999, projectDir: null, add: false, whitelistPath: wlPath });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('9999');
      expect(r.error).toContain('3001'); // 白名单现状可见
      expect(r.error).toContain('--add');
    }
  });

  it('--add 缺 --project：拒绝', () => {
    writeWl([]);
    const r = resolvePortEntry({ port: 3100, projectDir: null, add: true, whitelistPath: wlPath });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('--project');
  });

  it('白名单 JSON 损坏：一律拒绝，--add 也不覆盖（搭档待修配置不丢）', () => {
    fs.mkdirSync(path.dirname(wlPath), { recursive: true });
    fs.writeFileSync(wlPath, '{not json');
    const r = resolvePortEntry({ port: 3100, projectDir: '/Users/x/dongbeicun', add: true, whitelistPath: wlPath });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('解析失败');
    expect(fs.readFileSync(wlPath, 'utf-8')).toBe('{not json'); // 原文未动
  });

  it('main-guard：被测试 import 不触发主流程（无副作用返回 undefined）', () => {
    // import 本身已成功（顶部 import 语句）——若 main-guard 失效，主流程会在参数解析处
    // process.exit(1) 使整个测试文件加载失败。此用例显式断言导入面可用。
    expect(typeof resolvePortEntry).toBe('function');
  });
});
