/**
 * ps|grep 主进程特征名→kill 数据流判定（F20261118kills / #1899）。
 *
 * 拆分离由：bash-safety-guard.ts 基线恰满 max-lines 450 上限，#1899 政策 A 第 4 确认
 * 通道净增代码必然超限。本组（PKILL 特征名表 + ps→grep 扫描判定 + 四种喂杀形态识别）
 * 自包含、纯函数无状态，独立成文件后主文件回落至上限内。语义零变更（纯搬迁）。
 */

import type { GuardBlock } from "./bash-safety-guard";

/** pkill/killall 族命中的主进程特征名（按名匹配无法区分目标，恒拦；#1899 ps|grep 同表） */
export const PKILL_OTTER_PATTERNS = [
  "otter-buddy", "otter_buddy", "dist/src/main", "dist/src/main.js",
  ".otter-buddy.pid", "main.js", "node",
];

// #1899：ps→grep(主进程特征名)→…→kill 数据流——与 pkill/killall 按名同构，恒拦（政策 A 第 4 确认通道）。
// 复用 self_kill_byname 规则族：按名匹配主进程特征即「能确认」，宁漏勿误总则不因此放宽。
export const PS_GREP_KILL_BLOCK_MSG: GuardBlock = {
  text: "ps|grep 按名匹配会命中主进程（node/otter-buddy 特征名）再 kill——与 pkill/killall 按名同构，不允许。精确终止请用字面量 PID kill。",
  ruleId: "self_kill_byname",
  layer: "self_kill",
};

/** #1899：ps→grep(主进程特征名)→…→kill 数据流——目标来源可确认为主进程（与 pkill 按名同构）。
 *  事故：`for PID in $(ps aux | grep "[d]ist/src/main.js" | awk '{print $2}'); do kill $PID; done`
 *  只认「ps → grep(正向特征名)」且无「grep -v(特征名)」排除的扫描链，且扫描产物确实喂给 kill
 *  （xargs 同链 / 命令替换直给 / for 循环变量 / while read 变量）。非特征名不构成确认，放行。 */

/** [d]ist → dist 反 self-match 归一（单字符类仅 self-match 用；[0-9]/[a-z] 多字符类不动） */
function unbracketGrepSelfMatch(s: string): string {
  return s.replace(/\[([A-Za-z0-9])\]/g, "$1");
}

/** grep 段是否带 -v/--invert（反向匹配——命中「排除特征名」而非「扫描特征名」） */
function isInvertedGrepSegment(seg: string): boolean {
  return /(?:^|\s)(?:-[A-Za-z]*v|--invert-match)(?:\s|$)/.test(unbracketGrepSelfMatch(seg));
}

/** grep 段模式是否含主进程特征名（反 self-match 归一后） */
function grepSegmentHasMainFeature(seg: string): boolean {
  return /\bgrep\b/.test(seg)
    && PKILL_OTTER_PATTERNS.some(sig => unbracketGrepSelfMatch(seg).toLowerCase().includes(sig.toLowerCase()));
}

/** 管道链是否「按名扫描主进程」：有 ps → grep(正向特征名)，且无 grep -v(特征名) 排除 */
function chainScansMainSignature(s: string): boolean {
  const parts = s.split("|").map(p => p.trim());
  const psIdx = parts.findIndex(p => /\bps\b/.test(p));
  if (psIdx < 0) return false;
  const tail = parts.slice(psIdx + 1);
  if (tail.some(p => isInvertedGrepSegment(p) && grepSegmentHasMainFeature(p))) return false;
  return tail.some(p => !isInvertedGrepSegment(p) && grepSegmentHasMainFeature(p));
}

/** 从 s 起始提取 $(…) / `…` 内容（平衡匹配）；非替换开头返回 null */
function extractSubstitutionContent(s: string): string | null {
  const t = s.trimStart();
  if (t.startsWith("$(")) {
    let depth = 0;
    for (let i = 1; i < t.length; i++) {
      if (t[i] === "(") depth++;
      else if (t[i] === ")") { depth--; if (depth === 0) return t.slice(2, i); }
    }
    return null;
  }
  if (t.startsWith("`")) {
    const end = t.indexOf("`", 1);
    return end > 1 ? t.slice(1, end) : null;
  }
  return null;
}

/** 提取从 i 起的替代表达内容（i 指向 $ 或 `）；返回 { content, end }，未闭合返回 null */
function substitutionAt(command: string, i: number): { content: string; end: number } | null {
  if (command[i] === "$" && command[i + 1] === "(") {
    let d = 0;
    let j = i + 1;
    for (; j < command.length; j++) {
      if (command[j] === "(") d++;
      else if (command[j] === ")") { d--; if (d === 0) break; }
    }
    return j < command.length ? { content: command.slice(i + 2, j), end: j } : null;
  }
  if (command[i] === "`") {
    const end = command.indexOf("`", i + 1);
    return end > i ? { content: command.slice(i + 1, end), end } : null;
  }
  return null;
}

/** kill 词元之后、顶层分隔符之前的命令替换/反引号里，是否有主进程特征名扫描（命令替换直给） */
function killDirectSubstitutionsScanMain(command: string, killIdx: number): boolean {
  let depth = 0;
  for (let i = killIdx; i < command.length; i++) {
    const c = command[i];
    if (depth === 0 && /[|;&\n]/.test(c)) return false;
    const isSubStart = (c === "$" && command[i + 1] === "(") || c === "`";
    if (!isSubStart) {
      if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
      continue;
    }
    const sub = substitutionAt(command, i);
    if (sub && chainScansMainSignature(sub.content)) return true;
    if (sub) i = sub.end;
  }
  return false;
}

/** 第 n 次出现的子串位置（kill 段文本可能重复，按出现次序对齐） */
function nthIndexOf(haystack: string, needle: string, n: number): number {
  let idx = -1;
  for (let k = 0; k <= n; k++) {
    idx = haystack.indexOf(needle, idx + 1);
    if (idx < 0) return -1;
  }
  return idx;
}

/** idx 所在语句段（以 ; & \n 为边界）的 [start, end) */
function clauseBounds(command: string, idx: number): { start: number; end: number } {
  const seps = [";", "&", "\n"];
  let start = 0;
  let end = command.length;
  for (const sep of seps) {
    const l = command.lastIndexOf(sep, idx - 1);
    if (l >= start) start = l + 1;
  }
  for (const sep of seps) {
    const r = command.indexOf(sep, idx);
    if (r >= 0 && r < end) end = r;
  }
  return { start, end };
}

/** kill 是否在 headerIdx 之后的 do…done 循环体内 */
function killInsideDoDone(command: string, killIdx: number, headerIdx: number): boolean {
  const doMatch = /\bdo\b/.exec(command.slice(headerIdx));
  if (!doMatch) return false;
  const doIdx = headerIdx + doMatch.index;
  const doneIdx = command.indexOf("done", doIdx);
  return doneIdx > doIdx && killIdx >= doIdx && killIdx < doneIdx;
}

/** for VAR in <list> 的 list 是否主进程特征名扫描（$(…)/`…`/裸链） */
function forListScansMain(forRest: string): boolean {
  const sub = extractSubstitutionContent(forRest);
  if (sub) return chainScansMainSignature(sub);
  const listEnd = forRest.search(/[;|&\n]|\bdo\b/i);
  const list = listEnd >= 0 ? forRest.slice(0, listEnd) : forRest;
  return chainScansMainSignature(list);
}

/** for 循环变量目标：for VAR in $(scan…)/`scan…`/裸链，且 kill 在该循环体内 */
function forLoopFeedsMainScan(command: string, v: string, killIdx: number): boolean {
  const forRe = new RegExp(`for\\s+${v}\\s+in\\s+`, "ig");
  let fm;
  while ((fm = forRe.exec(command)) !== null) {
    if (!killInsideDoDone(command, killIdx, fm.index)) continue;
    if (forListScansMain(command.slice(fm.index + fm[0].length))) return true;
  }
  return false;
}

/** while read 变量目标：…| while [IFS=] read … VAR，且 kill 在该循环体内，输入链为特征名扫描 */
function whileReadFeedsMainScan(command: string, v: string, killIdx: number): boolean {
  const whileRe = new RegExp(`\\|\\s*while\\s+(?:IFS=(?:\\S+|'[^']*'|"[^"]*")?\\s+)?read\\b([^;\\n]*)`, "ig");
  let wm;
  while ((wm = whileRe.exec(command)) !== null) {
    if (!new RegExp(`\\b${v}\\b`).test(wm[1])) continue;
    if (!killInsideDoDone(command, killIdx, wm.index)) continue;
    const upstreamStart = Math.max(command.lastIndexOf(";", wm.index - 1), command.lastIndexOf("\n", wm.index - 1)) + 1;
    if (chainScansMainSignature(command.slice(upstreamStart, wm.index))) return true;
  }
  return false;
}

export function psGrepMainSignatureFeedsKill(command: string, killSegment: string, occurrence: number): boolean {
  const killIdx = nthIndexOf(command, killSegment, occurrence);
  if (killIdx < 0) return false;
  // A. 命令替换直给：kill $(scan) / kill `scan`（多个逐个查，到顶层分隔符为止）
  if (killDirectSubstitutionsScanMain(command, killIdx)) return true;
  // B. xargs kill：stdin 直接来自同链上游 ps→grep(特征名) 扫描（只看含该 kill 的语句段）
  if (/\bxargs\b/i.test(killSegment)) {
    const { start, end } = clauseBounds(command, killIdx);
    if (chainScansMainSignature(command.slice(start, end))) return true;
  }
  // C. 循环/read 变量目标：$VAR / ${VAR}
  const varM = /\$\{?([A-Za-z_]\w*)\}?/.exec(killSegment.replace(/^.*?\bkill\b\s*(?:-\S+\s+)*/, ""));
  if (!varM) return false;
  const v = varM[1];
  return forLoopFeedsMainScan(command, v, killIdx) || whileReadFeedsMainScan(command, v, killIdx);
}

