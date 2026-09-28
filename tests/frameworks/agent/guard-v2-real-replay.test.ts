/**
 * F20260928grv2 V9+ 真实拦截数据回放回归（搭档急讯 2026-09-28 中午）。
 *
 * 数据源：healing events 9/28 03:34-03:59 UTC（CST 11:34-11:59）的真实拦截现场——
 * 含跨獭（wxid 獭第 19-21 次、invoke-periodic-audit 獭、capability 獭）与本 session
 * 自身被拦的形态。期望值 = 逐条人工裁决：误拦类应放行（#1170/#1171 现场形态），
 * 规则内拦类保持拦（V1 防绕过语义，白名单外行为不变）。
 */
import { describe, expect, it } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";

const mainPid = 42877;
const projectRoot = "/Users/orca/ai/otter-buddy";
const WT = "/Users/orca/ai/otter-buddy/.otter/worktrees";

describe("V9+ 真实拦截数据回放（9/28 healing events 现场）", () => {
  it("E1: cd worktree && 赋值段链 && cp → 放行（invoke-periodic-audit 獭 03:59 现场）", () => {
    const r = checkBashCommandSafety(`${WT}/invoke-periodic-audit && F=web/src/pages/conversation/index.tsx && cp $F /tmp/bak.tsx`.replace(/^/, "cd "), mainPid, undefined, { projectRoot });
    expect(r).toBeNull();
  });
  it("E3: cd worktree && git stash push → 放行（capability 獭 03:41 现场）", () => {
    const r = checkBashCommandSafety(`cd ${WT}/capability-entries-bridge && git stash push -- tests/capability/helpers/audit-fixtures.ts`, mainPid, undefined, { projectRoot });
    expect(r).toBeNull();
  });
  it("E4: cd worktree && git commit -F ... 2>&1 | tail → 放行（本獭 03:41 第18次现场，#1170 主形态）", () => {
    const r = checkBashCommandSafety(`cd ${WT}/guard-v2-redesign && git add -A && git commit -F /tmp/commit-p3.txt 2>&1 | tail -5`, mainPid, undefined, { projectRoot });
    expect(r).toBeNull();
  });
  it("E5: cd worktree && python3 heredoc 写文件（引号定界）→ 放行（本獭 03:40 第16次现场）", () => {
    const cmd = `cd ${WT}/guard-v2-redesign && python3 - << 'PYEOF'\np = "src/x.ts"\ns = open(p).read()\nopen('/tmp/out.txt', 'w').write(s)\nPYEOF`;
    const r = checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot });
    expect(r).toBeNull();
  });
  it("E6: cd worktree && git commit -m 长消息 2>&1 | tail → 放行（wxid 獭 03:34 第21次现场）", () => {
    const r = checkBashCommandSafety(`cd ${WT}/wxid && git commit -m "[F20260928wxid][weixin][BugFix] 检视处置三处" 2>&1 | tail -3`, mainPid, undefined, { projectRoot });
    expect(r).toBeNull();
  });
  it("S1: grep -rn 引号内词样检索 → 放行（#1171 文本误伤现场）", () => {
    const r = checkBashCommandSafety("grep -rn 'k' + 'ill-segment-finder' src/ --include='*.ts' | head -20", mainPid, undefined, { projectRoot });
    expect(r).toBeNull();
  });
  it("S2: cd worktree && cmd 2>&1 | grep -v ... | head → 放行（管道杀豁免现场）", () => {
    const r = checkBashCommandSafety(`cd ${WT}/guard-v2-redesign && git commit -F /tmp/x.txt 2>&1 | grep -v notice | head -30`, mainPid, undefined, { projectRoot });
    expect(r).toBeNull();
  });
  it("E2 对照: node -e 载荷词样+PID → 保持拦（V1 防绕过语义，本獭 03:50 现场属规则内）", () => {
    // 现场原命令形态：one-liner 载荷含连续词样与 PID 数字（防绕过规则保持）
    const k = "k";
    const payload = `${k}ill 42877`;
    const cmd2 = `cd ${WT}/guard-v2-redesign && node -e "console.log('${payload}')"`;
    const r = checkBashCommandSafety(cmd2, mainPid, undefined, { projectRoot });
    expect(r).toBeTruthy();
  });
  it("拦截面对照: kill 主PID / pkill 特征名 / bash -c 'kill $0' 主PID → 拦", () => {
    expect(checkBashCommandSafety("kill 42877", mainPid)).toBeTruthy();
    expect(checkBashCommandSafety("pkill -f otter-buddy", mainPid)).toBeTruthy();
    expect(checkBashCommandSafety("bash -c 'nohup kill $0' 42877", mainPid)).toBeTruthy();
  });
});
