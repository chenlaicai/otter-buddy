/**
 * #858（F20260914ectx）内嵌文本脱敏测试。
 *
 * 覆盖：
 * - shouldSanitizeForScan 判定（引号内词元 + 无危险通道才脱敏）
 * - sanitizeQuotedText 只动引号内、等长替换
 * - 守卫集成：#858 现场形态（gh --body 引 review 文本 / heredoc 描述 / 测试字符串）
 *   放行；真实危险命令（引号外命令位 / bash -c / pipe-to-shell）维持拦截
 * - 回归：原守卫 91 用例语义不变（在 bash-safety-guard.test.ts 内，此处只测增量）
 */
import { describe, it, expect } from "vitest";
import { shouldSanitizeForScan, sanitizeQuotedText } from "@frameworks/agent/quoted-text-sanitizer";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";

const K = ["k", "i", "l", "l"].join("");

describe("#858 shouldSanitizeForScan 判定", () => {
  it("引号内含敏感词元的数据文本 → true", () => {
    expect(shouldSanitizeForScan(`gh pr review 855 --comment --body "review: ${K} 命令在 ${K} guard 里的误拦分析"`)).toBe(true);
    expect(shouldSanitizeForScan(`echo "the ${K} command was blocked"`)).toBe(true);
  });

  it("引号内无敏感词元 → false（无需脱敏）", () => {
    expect(shouldSanitizeForScan('echo "hello world"')).toBe(false);
  });

  it("无引号文本 → false", () => {
    expect(shouldSanitizeForScan("git status")).toBe(false);
  });

  it("危险通道存在 → false（引号内是执行内容）", () => {
    expect(shouldSanitizeForScan(`bash -c 'echo "${K} analysis"'`)).toBe(false);
    expect(shouldSanitizeForScan(`echo "x" | sh -c 'echo "${K}"'`)).toBe(false);
    expect(shouldSanitizeForScan(`cat <<< "heredoc with ${K}"`)).toBe(false);
  });

  it("#923 建议 1 回归：双引号内 $() 命令替换 → 不脱敏（真实执行，拦截路径不变）", () => {
    expect(shouldSanitizeForScan(`echo "result: $( ${K} 42877 )"`)).toBe(false);
    expect(shouldSanitizeForScan(`echo "pid: \`ps aux\` and ${K} desc"`)).toBe(false); // 反引号
    expect(shouldSanitizeForScan(`echo "var: ${K} of ${'${'}HOME}"`)).toBe(false); // 参数展开保守
  });

  it("单词全引号（无空格）不匹配 QUOTED_TEXT（归一化路径领地）", () => {
    expect(shouldSanitizeForScan(`'${K}' 42877`)).toBe(false);
  });
});

describe("#858 sanitizeQuotedText 替换", () => {
  it("只动引号内：引号外词元零触碰", () => {
    const before = `echo "the ${K} word"; ${K} 42877`;
    const after = sanitizeQuotedText(before);
    expect(after).not.toContain(`${K} word`);
    expect(after.endsWith(`${K} 42877`)).toBe(true); // 引号外命令位原样保留
  });

  it("等长替换（命令结构/位置不变形）", () => {
    const before = `echo "a ${K} b"`;
    const after = sanitizeQuotedText(before);
    expect(after.length).toBe(before.length);
    expect(after).toBe(`echo "a XXXX b"`);
  });

  it("多引号段逐一处理", () => {
    const before = `echo "x ${K} y" "z ${K} w"`;
    expect(sanitizeQuotedText(before)).toBe(`echo "x XXXX y" "z XXXX w"`);
  });
});

describe("#858 守卫集成（现场 13 起形态回归）", () => {
  const MAIN_PID = 42877;

  it("检视獭现场：gh pr review --body 引 skill 文本 → 放行", () => {
    const cmd = `gh pr review 855 --comment --body "## 审查报告\\n守卫源码 bash-safety-guard.ts 的 ${K} 正则分析……"`;
    expect(checkBashCommandSafety(cmd, MAIN_PID)).toBeNull();
  });

  it("issue 正文描述形态：--body 含词元描述文本 → 放行", () => {
    const cmd = `gh issue comment 858 --body "现象：${K} 命令被误拦 13 起"`;
    expect(checkBashCommandSafety(cmd, MAIN_PID)).toBeNull();
  });

  it("echo 测试字符串（本特性开发中 2 次被拦的形态）→ 放行", () => {
    const cmd = `echo "const cmd = 'P=$(lsof -t -i:3100); ${K} \\$P';"`;
    expect(checkBashCommandSafety(cmd, MAIN_PID)).toBeNull();
  });

  it("真实危险不受影响：引号外命令位 ${K} 主进程 PID → 拦截", () => {
    const cmd = `echo "desc"; ${K} ${MAIN_PID}`;
    expect(checkBashCommandSafety(cmd, MAIN_PID)).toContain("主进程");
  });

  it("真实危险不受影响：bash -c 引号内终止命令 → 拦截", () => {
    const cmd = `bash -c '${K} ${MAIN_PID}'`;
    expect(checkBashCommandSafety(cmd, MAIN_PID)).toBeTruthy();
  });

  it("真实危险不受影响：pipe-to-shell 含词元 → 拦截", () => {
    const cmd = `echo "${K} ${MAIN_PID}" | sh`;
    expect(checkBashCommandSafety(cmd, MAIN_PID)).toBeTruthy();
  });

  it("#923 建议 1 回归（守卫集成）：双引号内 $() 终止主进程 → 拦截", () => {
    const cmd = `echo "result: $( ${K} ${MAIN_PID} )"`;
    expect(checkBashCommandSafety(cmd, MAIN_PID)).toBeTruthy();
  });

  it("混合形态：描述引号放行但引号外仍有命令位 → 拦截（脱敏后仍命中）", () => {
    // 引号内是描述（脱敏），引号外 xargs 形态的终止命令仍要拦
    const cmd = `echo "desc of ${K}" ; P=$(lsof -t -i:8080); ${K} $P`;
    expect(checkBashCommandSafety(cmd, MAIN_PID)).toBeTruthy();
  });

  it("单词全引号包裹等价裸命令（#850 语义）→ 维持拦截", () => {
    const cmd = `'${K}' ${MAIN_PID}`;
    expect(checkBashCommandSafety(cmd, MAIN_PID)).toBeTruthy();
  });
});
