import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 部署脚本的远端命令串必须原样到达远端。
 *
 * 脚本用 `$SSH "多行命令"` 把整段命令交给远端 bash，因此这段字符串里出现的东西会先被
 * **本地** bash 处理一遍：内层双引号会把字符串提前截断，`$(...)` 会在本机就展开。
 * 两者都属于「本地看起来对、远端拿到的是残渣」的静默失败——真正的报错发生在远端一个
 * 语义已经错位的判断上，读日志的人会去查远端环境而不是查这行引号。
 *
 * 这里做静态判定：切成 `$SSH "` 开头的命令串，逐个检查它们是否还有未转义的内层引号与
 * 未转义的命令替换。判据只看语法形态，不执行脚本。
 */

const SCRIPT_PATH = resolve(process.cwd(), "deploy/ecs/deploy.sh");

/** 切出 `$SSH "…"` 形式的远端命令串（含首尾引号，便于看上下文）。 */
function extractSshCommandSpans(source: string): string[] {
  const lines = source.split("\n");
  const spans: string[] = [];
  let collecting: string[] | null = null;

  // 收尾判据：行末是未被转义的双引号。单行命令串在起始行即闭合，多行的在末行闭合。
  const closes = (line: string): boolean => line.endsWith('"') && !line.endsWith('\\"');

  for (const line of lines) {
    if (collecting === null) {
      const start = line.indexOf('$SSH "');
      if (start < 0) continue;
      const tail = line.slice(start);
      if (closes(tail)) spans.push(tail);
      else collecting = [tail];
      continue;
    }
    collecting.push(line);
    if (closes(line)) {
      spans.push(collecting.join("\n"));
      collecting = null;
    }
  }
  return spans;
}

/** 逐字符扫描：找出未被转义的内层双引号与未被转义的 `$(`。 */
function findUnsafe(source: string): { quoteAt: number; dollarParenAt: number } {
  const open = source.indexOf('"');
  const close = source.lastIndexOf('"');
  let quoteAt = -1;
  let dollarParenAt = -1;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const escaped = i > 0 && source[i - 1] === "\\";
    // 首个引号是命令串自身起始引号、末个是结束引号，夹在二者之间且未转义的才算内层引号。
    if (char === '"' && !escaped && i > open && i < close && quoteAt < 0) quoteAt = i;
    if (char === "$" && source[i + 1] === "(" && !escaped && dollarParenAt < 0) dollarParenAt = i;
  }
  return { quoteAt, dollarParenAt };
}

describe("deploy/ecs/deploy.sh 远端命令串转义", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const spans = extractSshCommandSpans(source);

  it("至少切出一段远端命令串（防止切分逻辑失效后本测试空跑成绿灯）", () => {
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.some((span) => span.includes("readlink"))).toBe(true);
  });

  it("命令串内层双引号必须转义（否则字符串被本地截断）", () => {
    const offenders = spans.map((span) => findUnsafe(span)).filter((found) => found.quoteAt >= 0);
    expect(offenders).toEqual([]);
  });

  it("命令串内的 $(…) 必须转义（否则在本地展开，远端收到空串）", () => {
    const offenders = spans.map((span) => findUnsafe(span)).filter((found) => found.dollarParenAt >= 0);
    expect(offenders).toEqual([]);
  });

  it("data symlink 校验的 readlink 走远端执行而不是本地展开", () => {
    const span = spans.find((candidate) => candidate.includes("readlink"));
    expect(span).toBeDefined();
    expect(span).toContain('\\$(readlink ${REMOTE_CODE}/data)');
  });
});
