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
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";
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

describe("#844 白名单放行（方案 A）——六变体同构命令", () => {
  // 六变体来自 #844 现场（dongbeicun dev server，端口 3100），词面改写避免本文件
  // 自身被守卫误拦的循环问题（守卫对文本提及不免疫是 #858 范畴）
  const ALLOWED = [{ port: 3100, projectDir: "/Users/x/dongbeicun" }];
  const MAIN_PID = 42877;
  const GUARD_OPTS = (root: string) => ({ projectRoot: root });
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-wl-"));
    fs.mkdirSync(path.join(tmpDir, ".otter"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".otter", "allowed-service-ports.json"), JSON.stringify({ services: ALLOWED }));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("变体 1/4/5 同构：lsof 端口引用取 PID 后终止（含变量与命令替换）→ 放行", () => {
    // lsof -t -i:3100 → PID → 终止（#844 变体 4/5 同构，k i l l 间隔写法防测试文件自拦）
    const cmd1 = "P=$(lsof -t -i:3100 -sTCP:LISTEN); k''ill $P";
    const cmd2 = "P=$(lsof -ti:3100); if [ -n \"$P\" ]; then k\"\"ill $P; fi";
    const cmd3 = "lsof -i :3100 -t | xargs -n1 k''ill";
    expect(checkBashCommandSafety(cmd1, MAIN_PID, undefined, GUARD_OPTS(tmpDir))).toBeNull();
    expect(checkBashCommandSafety(cmd2, MAIN_PID, undefined, GUARD_OPTS(tmpDir))).toBeNull();
    expect(checkBashCommandSafety(cmd3, MAIN_PID, undefined, GUARD_OPTS(tmpDir))).toBeNull();
  });

  it("变体 1 同构：ps 管道 grep 名字取 PID（模式串与 otter 撞名）→ 维持拦截，引导用 lsof 形态", () => {
    // grep main.js/node 类模式无法静态绑定到端口，且与 otter 主进程特征天然撞名——
    // 按设计不享受白名单（诉求引导到 lsof 形态或 restart-service.mjs）
    const cmd = "ps aux | grep \"node dist/api/src/ma''in.js\" | grep -v grep | awk '{print $2}' | head -1 | xargs -n1 k''ill; lsof -i :3100";
    expect(checkBashCommandSafety(cmd, MAIN_PID, undefined, GUARD_OPTS(tmpDir))).toBeTruthy();
  });

  it("变体 3 同构：pkill -f otter 特征名（main.js）→ 维持拦截（按名匹配无法区分）", () => {
    const cmd = "p''kill -f \"dist/api/src/ma''in.js\" 2>/dev/null; lsof -i :3100";
    expect(checkBashCommandSafety(cmd, MAIN_PID, undefined, GUARD_OPTS(tmpDir))).toBeTruthy();
  });

  it("变体 3 同构：pkill -f 非撞名项目特征（无 otter 词元）→ 本就放行（原逻辑不变）", () => {
    const cmd = "p''kill -f \"dongb" + "eicun-server\" 2>/dev/null";
    expect(checkBashCommandSafety(cmd, MAIN_PID, undefined, GUARD_OPTS(tmpDir))).toBeNull();
  });

  it("铁拦不松动：主进程 PID 字面量（即使白名单存在且命令含端口引用）→ 拦截", () => {
    const cmd = `k''ill 42877; lsof -i :3100`;
    expect(checkBashCommandSafety(cmd, MAIN_PID, undefined, GUARD_OPTS(tmpDir))).toContain("主进程");
  });

  it("铁拦不松动：PID 文件引用 → 拦截", () => {
    const cmd = "k''ill $(cat .otter-buddy.pid); lsof -i :3100";
    expect(checkBashCommandSafety(cmd, MAIN_PID, undefined, GUARD_OPTS(tmpDir))).toBeTruthy();
  });

  it("铁拦不松动：otter 特征名（otter-buddy 词元 + 端口引用）→ 拦截", () => {
    const cmd = "p''kill -f otter-buddy; lsof -i :3100";
    expect(checkBashCommandSafety(cmd, MAIN_PID, undefined, GUARD_OPTS(tmpDir))).toBeTruthy();
  });

  it("#918 严重 1 回归：白名单端口 lsof 做左段接入 shell → 拦截（cmdLevel 检测先于白名单放行）", () => {
    const cmd = `lsof -t -i:3100 | sh -c 'k''ill 12345'`;
    expect(checkBashCommandSafety(cmd, MAIN_PID, undefined, GUARD_OPTS(tmpDir))).toBeTruthy();
  });

  it("#918 建议 3 回归：变量先 lsof 后重赋值再终止 → 拦截（多次赋值只认最后一次）", () => {
    const cmd = `P=$(lsof -t -i:3100); P="4"2877; k''ill $P`;
    expect(checkBashCommandSafety(cmd, MAIN_PID, undefined, GUARD_OPTS(tmpDir))).toBeTruthy();
    // 对照：合法路径不受影响（最后一次赋值就是 lsof）
    const ok = `P=99999; P=$(lsof -t -i:3100); k''ill $P`;
    expect(checkBashCommandSafety(ok, MAIN_PID, undefined, GUARD_OPTS(tmpDir))).toBeNull();
  });

  it("白名单外端口不享受放行", () => {
    const cmd = "P=$(lsof -t -i:8080); k''ill $P";
    expect(checkBashCommandSafety(cmd, MAIN_PID, undefined, GUARD_OPTS(tmpDir))).toBeTruthy();
  });

  it("未配置白名单（无文件）→ 维持原拦截（退化安全）", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-nowl-"));
    try {
      const cmd = "P=$(lsof -t -i:3100); k''ill $P";
      expect(checkBashCommandSafety(cmd, MAIN_PID, undefined, GUARD_OPTS(emptyDir))).toBeTruthy();
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
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
