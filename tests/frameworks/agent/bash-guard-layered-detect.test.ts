/**
 * F20260923glay Part A：bash 守卫判定基准分层——脚本 one-liner 载荷内字符串字面量剥离。
 *
 * 9/23 实证（日志统计）：今日 BLOCKED 93 次中疑似误拦 51 次（55%），主要形态 =
 * python3 -c / node -e 内联分析脚本（只读），载荷内字符串里的 > | & 文本暴露给
 * REDIRECT_PATTERN 误触主仓写判定。根因：stripQuotedTextSpans 的 SHELL_PAYLOAD_CHANNEL
 * 把脚本 one-liner 与 shell 载荷（bash -c）一刀切同待——前者载荷内字符串是数据，
 * 后者引号内是 shell 代码。
 *
 * 安全不变量（本组测试守护）：
 * - kill 族检测始终看原文（脚本载荷剥离只影响重定向/主仓写判定）
 * - node -e 纳入脚本 kill 检测（防 process.kill 绕过）
 * - shell 载荷（bash -c / 管道进 shell / heredoc）仍整体保留原文
 */

import { describe, it, expect } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";

const mainPid = 42877;
const projectRoot = "/repo";

describe("F20260923glay Part A：脚本 one-liner 载荷字符串剥离（误拦修复）", () => {
  // ── 误拦面：python/node 内联分析脚本，载荷字符串含 > | & 文本 ──
  it("python3 -c 载荷含 > 文本（f-string / 比较符）→ 放行", () => {
    const cmd = `python3 -c "
data = open('/repo/web/dist/assets/index.js').read()
import re
for pat in ['const Qm=', 'a > b']:
    print(data.find(pat))
"`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).toBeNull();
  });

  it("node -e 载荷含 > 与 | 文本 → 放行", () => {
    const cmd = `node -e 'const fs=require("fs");const s=fs.readFileSync("/tmp/x.log","utf8");console.log(s.split("\\n").filter(l=>l.includes("a > b | c")).length)'`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).toBeNull();
  });

  it("python3 -c 管道接收 stdin 读日志（grep | python3 -c）→ 放行", () => {
    const cmd = `grep "broadcastEvent" data/logs/app.log | python3 -c "
import sys, json
for line in sys.stdin:
    print(json.loads(line).get('msg',''))
"`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).toBeNull();
  });

  it("python3 -c 载荷含项目路径词元（字符串字面量内）→ 放行", () => {
    const cmd = `python3 -c "
import json
d = json.load(open('/repo/data/workspaces/abc/x.json'))
print(d['name'])
"`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).toBeNull();
  });

  // ── 安全面：kill 检测看原文，脚本载荷剥离不影响 ──
  it("python3 -c 载荷含 kill + 数字（真危险）→ 仍拦截", () => {
    const cmd = `python3 -c "import os; os.kill(42877, 15)"`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).not.toBeNull();
  });

  it("node -e process.kill（真危险）→ 仍拦截（新增 node 覆盖）", () => {
    const cmd = `node -e "process.kill(42877, 'SIGTERM')"`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).not.toBeNull();
  });

  it("python3 -c 字符串里的 kill 字样 + 数字（数据非调用，如注释/日志分析）→ kill 检测仍触发（保守拦截，可接受误拦）", () => {
    // 已知取舍：kill 检测看原文无法区分字符串内 kill 字样与真调用——保守拦截。
    // 该形态在日志分析中真实出现（查 kill 相关日志），误拦可接受（改写法绕过：
    // 用工作区脚本文件而非 one-liner）。本测试固化「保守拦」语义防未来误放行。
    const cmd = `python3 -c "print('kill test 12345')"`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).not.toBeNull();
  });

  // ── shell 载荷不回退（引号内是 shell 代码，剥离会瞎 kill 检测）──
  it("bash -c 引号内 kill（危险通道载荷）→ 仍拦截", () => {
    const cmd = `bash -c 'kill 42877'`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).not.toBeNull();
  });

  it("bash -c 引号内重定向（载荷内真实 shell 语法）→ 不因此放行其他判定", () => {
    // bash -c 'echo x > /repo/src/y.ts' 的重定向在载荷内——bash -c 是危险通道整体保留原文，
    // REDIRECT_PATTERN 在原文上跑会命中 > /repo/src/y.ts → 拦截（语义正确：载荷会真写主仓）
    const cmd = `bash -c 'echo x > /repo/src/y.ts'`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).not.toBeNull();
  });

  it("python3 heredoc patch 形态（既有两道防线）→ 仍拦截", () => {
    const cmd = `python3 - <<'EOF'\nopen('src/foo.ts','w').write('x')\nEOF`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).not.toBeNull();
  });
});
