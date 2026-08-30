/**
 * F20260830bsgr Bash 命令安全守卫测试。
 *
 * 验证：kill 主进程 PID 拦截、kill 无关进程放行、pkill 模式匹配拦截、
 * killall 拦截、无 PID 文件放行、sudo 包装穿透。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { checkBashCommandSafety, readMainProcessPid } from "@frameworks/agent/bash-safety-guard";

describe("readMainProcessPid", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pid-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("正常 PID 文件返回数字", () => {
    fs.writeFileSync(path.join(tmpDir, ".otter-buddy.pid"), "42877\n");
    expect(readMainProcessPid(tmpDir)).toBe(42877);
  });

  it("PID 文件不存在返回 null", () => {
    expect(readMainProcessPid(tmpDir)).toBeNull();
  });

  it("PID 文件内容非法返回 null", () => {
    fs.writeFileSync(path.join(tmpDir, ".otter-buddy.pid"), "abc\n");
    expect(readMainProcessPid(tmpDir)).toBeNull();
  });

  it("PID 文件内容为 0 返回 null", () => {
    fs.writeFileSync(path.join(tmpDir, ".otter-buddy.pid"), "0\n");
    expect(readMainProcessPid(tmpDir)).toBeNull();
  });
});

describe("checkBashCommandSafety", () => {
  const mainPid = 42877;

  it("直接 kill 主进程 PID → 拦截", () => {
    const result = checkBashCommandSafety("kill 42877", mainPid);
    expect(result).toContain("kill 42877");
    expect(result).toContain("主进程");
  });

  it("kill -9 主进程 PID → 拦截", () => {
    const result = checkBashCommandSafety("kill -9 42877", mainPid);
    expect(result).toContain("kill 42877");
  });

  it("kill -15 主进程 PID → 拦截", () => {
    const result = checkBashCommandSafety("kill -15 42877", mainPid);
    expect(result).toContain("kill 42877");
  });

  it("sudo kill 主进程 PID → 拦截（穿透 sudo 包装）", () => {
    const result = checkBashCommandSafety("sudo kill 42877", mainPid);
    expect(result).toContain("kill 42877");
  });

  it("kill 主进程 + nohup 组合命令 → 拦截", () => {
    const result = checkBashCommandSafety(
      "kill 42877 2>/dev/null; sleep 2; nohup node dist/src/main.js > /tmp/otter-main.log 2>&1 &",
      mainPid,
    );
    expect(result).toContain("kill 42877");
  });

  it("kill 无关进程 PID → 放行", () => {
    const result = checkBashCommandSafety("kill 12345", mainPid);
    expect(result).toBeNull();
  });

  it("kill -9 无关进程 PID → 放行", () => {
    const result = checkBashCommandSafety("kill -9 12345", mainPid);
    expect(result).toBeNull();
  });

  it("多个 PID 中包含主进程 → 拦截", () => {
    const result = checkBashCommandSafety("kill 12345 42877 67890", mainPid);
    expect(result).toContain("kill 42877");
  });

  it("多个 PID 都是无关进程 → 放行", () => {
    const result = checkBashCommandSafety("kill 12345 67890", mainPid);
    expect(result).toBeNull();
  });

  it("无 PID 文件（null）→ 放行", () => {
    const result = checkBashCommandSafety("kill 42877", null);
    expect(result).toBeNull();
  });

  it("不含 kill 的命令 → 放行", () => {
    const result = checkBashCommandSafety("git status", mainPid);
    expect(result).toBeNull();
  });

  it("不含 kill 的 node 命令 → 放行", () => {
    const result = checkBashCommandSafety("node dist/src/main.js", mainPid);
    expect(result).toBeNull();
  });

  it("pkill otter-buddy → 拦截", () => {
    const result = checkBashCommandSafety("pkill -f otter-buddy", mainPid);
    expect(result).toContain("pkill");
  });

  it("pkill node.*main → 拦截", () => {
    const result = checkBashCommandSafety("pkill -f 'node.*main'", mainPid);
    expect(result).toContain("pkill");
  });

  it("pkill 无关进程名 → 放行", () => {
    const result = checkBashCommandSafety("pkill -f ffmpeg", mainPid);
    expect(result).toBeNull();
  });

  it("killall node → 拦截", () => {
    const result = checkBashCommandSafety("killall node", mainPid);
    expect(result).toContain("killall");
  });

  it("killall 无关进程 → 放行", () => {
    const result = checkBashCommandSafety("killall ffmpeg", mainPid);
    expect(result).toBeNull();
  });

  it("管道中后段 kill 主进程 → 拦截", () => {
    const result = checkBashCommandSafety("echo starting && kill 42877", mainPid);
    expect(result).toContain("kill 42877");
  });

  it("空命令 → 放行", () => {
    const result = checkBashCommandSafety("", mainPid);
    expect(result).toBeNull();
  });
});
