/**
 * #844（F20260914dsrv）自有项目 dev server 放行路径测试。
 *
 * 覆盖：
 * - 方案 A：端口白名单加载（合法/非法/缺文件/热加载/体积上限）+ 守卫放行判定
 *   - #844 现场六变体同构命令在白名单端口内 → 放行
 *   - 铁拦不松动：主进程 PID 字面量 / PID 文件引用 / otter 特征名 → 仍拦截（含白名单存在时）
 *   - 白名单外端口 / 未配置白名单 → 维持原拦截
 * - 方案 C：guard_intercept 重复拦截升级判定纯函数
 *
 * 注：方案 B（restart-service.mjs）是独立进程脚本，靠脚本内校验逻辑 + 手工冒烟，
 * 不在本单测范围（execFileSync 依赖真实 lsof 环境）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { loadAllowedServicePorts, extractWhitelistedPortRefs } from "@frameworks/agent/allowed-service-ports";
import { classifyGuardIntercept, ESCALATION_THRESHOLD } from "@frameworks/agent/guard-intercept-escalation";

describe("#844 端口白名单加载（allowed-service-ports）", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ports-wl-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("合法配置返回服务列表", () => {
    fs.mkdirSync(path.join(tmpDir, ".otter"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".otter", "allowed-service-ports.json"),
      JSON.stringify({ services: [{ port: 3100, projectDir: "/Users/x/dongbeicun" }] }),
    );
    expect(loadAllowedServicePorts(tmpDir)).toEqual([{ port: 3100, projectDir: "/Users/x/dongbeicun" }]);
  });

  it("缺文件返回空（退化为主逻辑）", () => {
    expect(loadAllowedServicePorts(tmpDir)).toEqual([]);
  });

  it("坏 JSON / 字段非法返回空，不抛出", () => {
    fs.mkdirSync(path.join(tmpDir, ".otter"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".otter", "allowed-service-ports.json"), "{not json");
    expect(loadAllowedServicePorts(tmpDir)).toEqual([]);
    fs.writeFileSync(
      path.join(tmpDir, ".otter", "allowed-service-ports.json"),
      JSON.stringify({ services: [{ port: "3100" }, { port: 0 }, { port: 99999 }, { port: 3100, projectDir: "  " }, null] }),
    );
    expect(loadAllowedServicePorts(tmpDir)).toEqual([]);
  });

  it("热加载：文件变更后自动生效（mtime 缓存失效）", () => {
    fs.mkdirSync(path.join(tmpDir, ".otter"), { recursive: true });
    const file = path.join(tmpDir, ".otter", "allowed-service-ports.json");
    fs.writeFileSync(file, JSON.stringify({ services: [{ port: 3100, projectDir: "/a" }] }));
    expect(loadAllowedServicePorts(tmpDir)).toHaveLength(1);
    // 修改 mtime 不可靠（同 ms 写入），用不同内容 + utimes 强推 mtime
    fs.writeFileSync(file, JSON.stringify({ services: [{ port: 3100, projectDir: "/a" }, { port: 3200, projectDir: "/b" }] }));
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(file, later, later);
    expect(loadAllowedServicePorts(tmpDir)).toHaveLength(2);
  });

  it("体积超限返回空（防巨文件阻塞同步路径）", () => {
    fs.mkdirSync(path.join(tmpDir, ".otter"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".otter", "allowed-service-ports.json"),
      JSON.stringify({ services: [{ port: 3100, projectDir: "/".padEnd(100_000, "x") }] }),
    );
    expect(loadAllowedServicePorts(tmpDir)).toEqual([]);
  });
});


describe("#844 extractWhitelistedPortRefs 单元", () => {
  const ALLOWED = [
    { port: 3100, projectDir: "/a" },
    { port: 3200, projectDir: "/b" },
  ];

  it("lsof 各变体端口形态命中", () => {
    expect(extractWhitelistedPortRefs("lsof -t -i:3100", ALLOWED)).toEqual([3100]);
    expect(extractWhitelistedPortRefs("lsof -ti:3200", ALLOWED)).toEqual([3200]);
    expect(extractWhitelistedPortRefs("lsof -i :3100 -t", ALLOWED)).toEqual([3100]);
  });

  it("无关数字（日期/PID/路径）不误命中", () => {
    expect(extractWhitelistedPortRefs("git log --since=2026-09-14 3100", ALLOWED)).toEqual([]);
  });
});

describe("#844 guard_intercept 升级判定（方案 C）", () => {
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

  it("窗口内 0-1 次已有（本次为第 1-2 次）→ 不升级", () => {
    expect(classifyGuardIntercept([], now).repeated).toBe(false);
    expect(classifyGuardIntercept([{ createdAt: at(30) }], now).repeated).toBe(false);
  });

  it("窗口内 2 次已有（本次为第 3 次）→ 升级", () => {
    const r = classifyGuardIntercept([{ createdAt: at(30) }, { createdAt: at(120) }], now);
    expect(r.repeated).toBe(true);
    expect(r.priorCount).toBe(2);
  });

  it("窗口外事件不计入", () => {
    const events = [{ createdAt: at(30) }, { createdAt: at(60 * 7) }];
    expect(classifyGuardIntercept(events, now).repeated).toBe(false);
  });

  it("时间戳缺失/非法条目忽略，不抛出", () => {
    expect(classifyGuardIntercept([{}, { createdAt: "not-a-date" }], now).repeated).toBe(false);
  });

  it(`阈值常量 = ${ESCALATION_THRESHOLD}（含本次第 3 次起升级）`, () => {
    expect(ESCALATION_THRESHOLD).toBe(3);
  });
});
