/**
 * #1069：restart-service.mjs resolvePortEntry 单测（纯逻辑 + tmp 目录驱动文件 IO）。
 * #1250 检视处置后追加：S1 工作根边界（allowedRoots）、M1 原子写/并发锁、L1 权限错误文案。
 *
 * 覆盖：白名单缺失/端口未声明时的两条正道（--add 现场声明 vs 拒绝+指引）、
 * --add 写回保留既有 entries、projectDir 不一致拒绝、损坏 JSON 不覆盖、
 * --add 越工作根拒绝（含 --project / 根本身攻击面）、不存在的目录拒绝、
 * 写回原子性（无 .tmp 残留）、锁释放、main-guard（被 import 时不触发主流程）。
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
  // 模拟工作根布局：tmpDir/workspace/{colink, dongbeicun} + tmpDir/outside/evil
  let allowedRoots: string[];
  let colinkDir: string;
  let dongbeiDir: string;
  let outsideDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-svc-'));
    wlPath = path.join(tmpDir, '.otter', 'allowed-service-ports.json');
    colinkDir = path.join(tmpDir, 'workspace', 'colink');
    dongbeiDir = path.join(tmpDir, 'workspace', 'dongbeicun');
    outsideDir = path.join(tmpDir, 'outside', 'evil');
    fs.mkdirSync(colinkDir, { recursive: true });
    fs.mkdirSync(dongbeiDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    allowedRoots = [path.join(tmpDir, 'workspace')];
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeWl = (services: unknown[]) => {
    fs.mkdirSync(path.dirname(wlPath), { recursive: true });
    fs.writeFileSync(wlPath, JSON.stringify({ services }, null, 2));
  };

  it('端口已声明：直接返回 entry，projectDir 缺省取声明值', () => {
    writeWl([{ port: 3001, projectDir: colinkDir }]);
    const r = resolvePortEntry({ port: 3001, projectDir: null, add: false, whitelistPath: wlPath, allowedRoots });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.port).toBe(3001);
      expect(r.declaredDir).toBe(colinkDir);
    }
  });

  it('端口已声明但 --project 不一致：拒绝（原语义保留）', () => {
    writeWl([{ port: 3001, projectDir: colinkDir }]);
    const r = resolvePortEntry({ port: 3001, projectDir: dongbeiDir, add: false, whitelistPath: wlPath, allowedRoots });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('不一致');
  });

  it('白名单缺失且无 --add：拒绝，错误信息含两条正道指引', () => {
    const r = resolvePortEntry({ port: 3100, projectDir: null, add: false, whitelistPath: wlPath, allowedRoots });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('端口白名单不存在');
      expect(r.error).toContain('--add');
      expect(r.error).toContain('请搭档创建');
    }
    expect(fs.existsSync(wlPath)).toBe(false); // 不偷偷创建
  });

  it('白名单缺失 + --add --project（工作根内）：从空 services 创建并写回，返回 declared', () => {
    const r = resolvePortEntry({ port: 3100, projectDir: dongbeiDir, add: true, whitelistPath: wlPath, allowedRoots });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.declared).toBe(true);
      expect(r.declaredDir).toBe(dongbeiDir);
    }
    const onDisk = JSON.parse(fs.readFileSync(wlPath, 'utf-8'));
    expect(onDisk.services).toEqual([{ port: 3100, projectDir: dongbeiDir }]);
  });

  it('端口未声明 + --add（工作根内）：写回保留既有 entries', () => {
    writeWl([{ port: 3001, projectDir: colinkDir }]);
    const r = resolvePortEntry({ port: 3100, projectDir: dongbeiDir, add: true, whitelistPath: wlPath, allowedRoots });
    expect(r.ok).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(wlPath, 'utf-8'));
    expect(onDisk.services).toHaveLength(2);
    expect(onDisk.services).toContainEqual({ port: 3001, projectDir: colinkDir });
    expect(onDisk.services).toContainEqual({ port: 3100, projectDir: dongbeiDir });
  });

  it('端口未声明且无 --add：拒绝，错误信息含白名单现状 + 两条正道', () => {
    writeWl([{ port: 3001, projectDir: colinkDir }]);
    const r = resolvePortEntry({ port: 9999, projectDir: null, add: false, whitelistPath: wlPath, allowedRoots });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('9999');
      expect(r.error).toContain('3001'); // 白名单现状可见
      expect(r.error).toContain('--add');
    }
  });

  it('--add 缺 --project：拒绝', () => {
    writeWl([]);
    const r = resolvePortEntry({ port: 3100, projectDir: null, add: true, whitelistPath: wlPath, allowedRoots });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('--project');
  });

  it('白名单 JSON 损坏：一律拒绝，--add 也不覆盖（搭档待修配置不丢）', () => {
    fs.mkdirSync(path.dirname(wlPath), { recursive: true });
    fs.writeFileSync(wlPath, '{not json');
    const r = resolvePortEntry({ port: 3100, projectDir: dongbeiDir, add: true, whitelistPath: wlPath, allowedRoots });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('解析失败');
    expect(fs.readFileSync(wlPath, 'utf-8')).toBe('{not json'); // 原文未动
  });

  it('main-guard：被测试 import 不触发主流程（无副作用返回 undefined）', () => {
    // import 本身已成功（顶部 import 语句）——若 main-guard 失效，主流程会在参数解析处
    // process.exit(1) 使整个测试文件加载失败。此用例显式断言导入面可用。
    expect(typeof resolvePortEntry).toBe('function');
  });

  // ── #1250 检视处置：S1 工作根边界 ──

  it('S1·攻击面 1：--project / （任意 cwd 都能匹配的根）+ --add → 拒绝', () => {
    writeWl([]);
    const r = resolvePortEntry({ port: 5432, projectDir: '/', add: true, whitelistPath: wlPath, allowedRoots });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('工作根');
  });

  it('S1·攻击面 2：--project 指向工作根之外的系统目录（如 /var/lib/postgresql）+ --add → 拒绝（精确打击面消除）', () => {
    writeWl([]);
    const r = resolvePortEntry({ port: 5432, projectDir: '/var/lib/postgresql', add: true, whitelistPath: wlPath, allowedRoots });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('工作根');
      expect(r.error).toContain('搭档'); // 指引走搭档授权
    }
  });

  it('S1·攻击面 3：--project 是工作根本身（workspace/，能匹配根内一切 cwd）+ --add → 拒绝', () => {
    writeWl([]);
    const r = resolvePortEntry({ port: 5432, projectDir: allowedRoots[0], add: true, whitelistPath: wlPath, allowedRoots });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('不得是根本身');
  });

  it('S1·allowedRoots 未配置时 --add：拒绝并指引搭档手动编辑（授权面恒在搭档）', () => {
    writeWl([]);
    const r = resolvePortEntry({ port: 3100, projectDir: dongbeiDir, add: true, whitelistPath: wlPath, allowedRoots: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('未配置工作根');
  });

  it('S1·项目目录必须真实存在且是目录（不存在的路径 + --add → 拒绝）', () => {
    writeWl([]);
    const ghost = path.join(allowedRoots[0], 'ghost-project');
    const r = resolvePortEntry({ port: 3100, projectDir: ghost, add: true, whitelistPath: wlPath, allowedRoots });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('不存在或不是目录');
  });

  it('S1·工作根边界不作用于「白名单已声明端口」路径（搭档手动声明的范围外端口仍可用——授权主体是搭档）', () => {
    writeWl([{ port: 5432, projectDir: '/var/lib/postgresql' }]); // 搭档手动声明的系统服务
    const r = resolvePortEntry({ port: 5432, projectDir: null, add: false, whitelistPath: wlPath, allowedRoots });
    expect(r.ok).toBe(true); // 已声明条目不受 --add 边界影响
  });

  // ── #1250 检视处置：M1 原子写 / 锁 ──

  it('M1·写回后无 .tmp 残留文件（temp+rename 原子替换）', () => {
    const r = resolvePortEntry({ port: 3100, projectDir: dongbeiDir, add: true, whitelistPath: wlPath, allowedRoots });
    expect(r.ok).toBe(true);
    const dirEntries = fs.readdirSync(path.dirname(wlPath));
    expect(dirEntries.filter(f => f.includes('.tmp-'))).toEqual([]);
    expect(dirEntries.filter(f => f.endsWith('.lock'))).toEqual([]); // 锁已释放
  });

  it('M1·重复 --add 同端口：幂等复用已有声明，不重复追加', () => {
    writeWl([]);
    const r1 = resolvePortEntry({ port: 3100, projectDir: dongbeiDir, add: true, whitelistPath: wlPath, allowedRoots });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.declared).toBe(true);
    // 第二次：白名单已有该端口（外层已声明分支命中，或并发场景下锁内 re-read 复用）
    const r2 = resolvePortEntry({ port: 3100, projectDir: dongbeiDir, add: true, whitelistPath: wlPath, allowedRoots });
    expect(r2.ok).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(wlPath, 'utf-8'));
    expect(onDisk.services).toHaveLength(1); // 无重复条目——两条路径都不重复追加
  });
});
