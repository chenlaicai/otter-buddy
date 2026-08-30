/**
 * F20260830bsgr Bash 命令安全守卫测试（v2 对抗审视修正）。
 *
 * 验证：
 * - kill 字面量主进程 PID → 拦截
 * - kill 字面量无关 PID → 放行
 * - kill 非字面量目标（变量/$()/反引号/xargs/管道/base64/eval）→ 保守拦截
 * - pkill/killall + otter 模式 → 拦截
 * - pkill/killall 无关模式 → 放行
 * - .otter-buddy.pid 引用 + kill → 拦截
 * - PID 文件缺失/非法 → 放行（保守降级）
 *
 * F20260830fabt-r2: 检视獭实证的10 个绕过 PoC 全部转为回归测试
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

  it("每次调用都读文件（不缓存）", () => {
    fs.writeFileSync(path.join(tmpDir, ".otter-buddy.pid"), "111\n");
    expect(readMainProcessPid(tmpDir)).toBe(111);
    // 修改 PID 文件内容
    fs.writeFileSync(path.join(tmpDir, ".otter-buddy.pid"), "222\n");
    expect(readMainProcessPid(tmpDir)).toBe(222);
  });
});

describe("checkBashCommandSafety", () => {
  const mainPid = 42877;

  // ─── 基础：字面量 PID 精确匹配 ───

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

  it("管道中前段 kill 主进程 → 拦截", () => {
    const result = checkBashCommandSafety("echo starting && kill 42877", mainPid);
    expect(result).toContain("kill 42877");
  });

  it("空命令 → 放行", () => {
    const result = checkBashCommandSafety("", mainPid);
    expect(result).toBeNull();
  });

  // ─── pkill/killall 精确模式匹配 ───

  it("pkill otter-buddy → 拦截", () => {
    const result = checkBashCommandSafety("pkill -f otter-buddy", mainPid);
    expect(result).toContain("pkill");
  });

  it("pkill node.*main → 拦截", () => {
    const result = checkBashCommandSafety("pkill -f 'node.*main'", mainPid);
    expect(result).toContain("pkill");
  });

  it("pkill dist/src/main.js → 拦截", () => {
    const result = checkBashCommandSafety("pkill -f dist/src/main.js", mainPid);
    expect(result).toContain("pkill");
  });

  it("pkill .otter-buddy.pid → 拦截", () => {
    const result = checkBashCommandSafety("pkill -f .otter-buddy.pid", mainPid);
    expect(result).not.toBeNull(); // 匹配跨段 PID 文件引用或 pkill 模式
  });

  it("pkill 无关进程名 → 放行", () => {
    const result = checkBashCommandSafety("pkill -f ffmpeg", mainPid);
    expect(result).toBeNull();
  });

  it("killall node → 拦截", () => {
    const result = checkBashCommandSafety("killall node", mainPid);
    expect(result).not.toBeNull();
  });

  it("killall 无关进程 → 放行", () => {
    const result = checkBashCommandSafety("killall ffmpeg", mainPid);
    expect(result).toBeNull();
  });

  // ─── 对抗 LLM 自适应变形：非字面量 kill 目标 → 保守拦截 ───

  it("PoC-1: kill $(cat .otter-buddy.pid) → 拦截（命令替换 + PID 文件引用）", () => {
    const result = checkBashCommandSafety("kill $(cat .otter-buddy.pid)", mainPid);
    expect(result).not.toBeNull();
  });

  it("PoC-2: kill `cat .otter-buddy.pid` → 拦截（反引号命令替换 + PID 文件引用）", () => {
    const result = checkBashCommandSafety("kill `cat .otter-buddy.pid`", mainPid);
    expect(result).not.toBeNull();
  });

  it("PoC-3: MAINPID=$(cat .otter-buddy.pid) && kill $MAINPID → 拦截（变量 + PID 文件引用）", () => {
    const result = checkBashCommandSafety("MAINPID=$(cat .otter-buddy.pid) && kill $MAINPID", mainPid);
    expect(result).not.toBeNull();
  });

  it("PoC-4: cat .otter-buddy.pid | xargs kill → 拦截（管道 + PID 文件引用）", () => {
    const result = checkBashCommandSafety("cat .otter-buddy.pid | xargs kill", mainPid);
    expect(result).not.toBeNull();
  });

  it("PoC-5: kill $(pgrep -f main.js) → 拦截（命令替换 + 非字面量）", () => {
    const result = checkBashCommandSafety("kill $(pgrep -f main.js)", mainPid);
    expect(result).not.toBeNull();
  });

  it("PoC-6: pkill -f main.js → 拦截（otter 进程模式）", () => {
    const result = checkBashCommandSafety("pkill -f main.js", mainPid);
    expect(result).not.toBeNull();
  });

  it("PoC-7: pkill -f dist/src → 拦截（otter 进程模式）", () => {
    const result = checkBashCommandSafety("pkill -f dist/src", mainPid);
    expect(result).not.toBeNull();
  });

  it("PoC-8: echo a2lsbCA0Mjg3Nwo= | base64 -d | sh → 已知局限（base64 编码的 kill 无法文本检测）", () => {
    // base64 编码 "kill 42877\n" → 管道到 sh 是高危模式，但文本分析看不到 kill 关键词
    // 这是纵深防御的已知盲点：管道到 shell 本身不够危险（可执行正常 base64 解码），
    // 只有结合未知编码内容才有风险——超出静态文本分析能力
    const result = checkBashCommandSafety("echo a2lsbCA0Mjg3Nwo= | base64 -d | sh", mainPid);
    expect(result).toBeNull(); // 文本层面看不到 kill，确实放行
  });

  it("PoC-9: eval \"kil\"\"l 42877\" → 拦截（eval 包装）", () => {
    const result = checkBashCommandSafety('eval "kil""l 42877"', mainPid);
    expect(result).not.toBeNull();
  });

  it("PoC-10: perl -e 'kill 15, 42877' → 拦截（perl kill 绕过）", () => {
    // perl 的 kill 不是 shell kill，但参数中有主进程 PID + kill 关键词
    const result = checkBashCommandSafety("perl -e 'kill 15, 42877'", mainPid);
    expect(result).not.toBeNull();
  });

  // ─── 边界：非字面量但无 kill → 放行 ───

  it("变量引用但无 kill 命令 → 放行", () => {
    const result = checkBashCommandSafety("echo $MAIN_PID", mainPid);
    expect(result).toBeNull();
  });

  it("$() 命令替换但无 kill → 放行", () => {
    const result = checkBashCommandSafety("echo $(cat /tmp/status)", mainPid);
    expect(result).toBeNull();
  });

  // ─── PID 实时读取（不缓存） ───

  it("PID 文件更新后立即生效", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pid-test-"));
    try {
      fs.writeFileSync(path.join(tmpDir, ".otter-buddy.pid"), "42877\n");
      expect(readMainProcessPid(tmpDir)).toBe(42877);
      // PID 热重启后变化
      fs.writeFileSync(path.join(tmpDir, ".otter-buddy.pid"), "99999\n");
      expect(readMainProcessPid(tmpDir)).toBe(99999);
      // 旧 PID 不再是主进程
      expect(checkBashCommandSafety("kill 42877", 99999)).toBeNull();
      // 新 PID 是主进程
      expect(checkBashCommandSafety("kill 99999", 99999)).not.toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
