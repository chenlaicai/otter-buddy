/**
 * payload-extract-aux：能力 5 三病型手术辅助（拍板 2026-10-13）。
 *
 * 病型 A：check-only 形态判定（语法检查=读脚本不执行）。
 * 病型 C：引号自散架侦察 + 载荷级重组 span + 硬性负门（写词面/新 runner 交界）。
 *
 * 纯函数：无状态、无 IO（机制识别检查点非机制面）。
 */
import type { CommandModel, Segment } from "./command-model";
import type { Word } from "./command-lexer";

/** shell 递归/脚本载荷解释器族（与 bash-safety-guard 脚本族同源口径） */
export const SCRIPT_RUNNERS = new Set(["python", "python3", "node", "perl", "ruby", "osascript"]);

/** 病型 A：check-only 形态=语法检查（读脚本不执行）——node --check/-c、perl -c、ruby -c、
 *  python -m py_compile、--syntax-only（bash/sh -n 不在 SCRIPT_RUNNERS，本就走正常段求值）。
 *  与不透明执行形态（node script.js / bash attack.sh）严格分界：无 check 旗标一律不算，
 *  后者窄提取照旧回落（负门钉死不许被 check-only 放宽）。 */
const CHECK_ONLY_FLAGS: Record<string, string[]> = {
  node: ["--check", "-c", "--syntax-only"],
  perl: ["-c", "--syntax-only"],
  ruby: ["-c", "--syntax-only"],
  osascript: ["--syntax-only"],
};

export function isCheckOnlyWords(bare: string, args: Array<string | null>): boolean {
  const vals = args.filter((a): a is string => a !== null);
  if (vals.includes("-e")) return false; // 带执行载荷走载荷通道（含 perl -pi -e 原地编辑面）
  if (/^python/.test(bare)) return vals.includes("-m") && vals.includes("py_compile");
  const flags = CHECK_ONLY_FLAGS[bare];
  return flags !== undefined && flags.some(f => vals.includes(f));
}

export function isCheckOnlySeg(seg: Segment): boolean {
  const bare = (seg.argv0 ?? "").split("/").pop() ?? "";
  if (seg.argv0 === null) return false;
  return isCheckOnlyWords(bare, seg.args);
}

/** check-only 段的文件实参（读侧入账原料）——旗标与元词剔除后按序返回 */
export function checkOnlyFileArgs(seg: Segment): string[] {
  return seg.args.filter((a): a is string => a !== null && !a.startsWith("-") && a !== "py_compile");
}

/** 病型 C 侦察：bash 级引号状态扫描（转义对与单双引号区，与词法双引号扫描同语义）——
 *  命令收尾时引号未闭合 = 捕获命令在 bash 里亲手跑也会散架（引号塔转义断裂），
 *  需要载荷级重组按原意读回（方案 a，拍板 2026-10-13）。 */
export function quoteUnbalanced(raw: string): boolean {
  let state: "out" | "dquote" | "squote" = "out";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (state === "out") {
      if (c === "\\") i++;
      else if (c === "'") state = "squote";
      else if (c === '"') state = "dquote";
    } else if (state === "squote") {
      if (c === "'") state = "out";
    } else {
      if (c === "\\") i++;
      else if (c === '"') state = "out";
    }
  }
  return state !== "out";
}

/** 尾随重定向（重组边界：到重定向前）—— 2>&1 / >x / >>x / &>x / 2>/dev/null 等尾部形态 */
const TRAILING_REDIR = /\s+(?:&>{1,2}|[0-9]{0,2}>>?(?:&[0-9]|&-)?|>(?:&[0-9]|&-)?)\s*\S*\s*$/;

/** 载荷级重组 span：flag 词后到尾随重定向前的原始文本（跨引号开合，按原意读回） */
export function reassemblySpan(commandText: string, start: number): string {
  const tr = TRAILING_REDIR.exec(commandText);
  const end = tr !== null && tr.index > start ? tr.index : commandText.length;
  return commandText.slice(start, end);
}

/** 病型 C 负门②：新 runner 交界——重组 span 内分隔符后出现另一解释器执行形态（非 check-only）
 *  → 跨段藏写风险，回落不猜。echo/printf 等内建非 runner 不算交界。 */
const RUNNER_JUNCTION = /(?:^|[;&|\n])\s*(?:sudo\s+)?(?:bash|zsh|ksh|sh|node|python3?|perl|ruby|osascript)\s+[^\n;&|]*/g;

export function runnerJunctionUnsafe(span: string): boolean {
  for (const m of span.matchAll(RUNNER_JUNCTION)) {
    const segText = m[0].replace(/^[;&|\n]\s*/, "").replace(/^sudo\s+/, "");
    const words = segText.trim().split(/\s+/);
    const bare = (words[0] ?? "").split("/").pop() ?? "";
    if (!isCheckOnlyWords(bare, words.slice(1))) return true;
  }
  return false;
}

/** 段是否带载荷旗标（-c/-e/- 或词内 cmdsub/var 展开——有展开就有载荷面） */
export function hasPayloadFlag(seg: Segment): boolean {
  return seg.words.some(w => w.evaluated === "-c" || w.evaluated === "-e" || w.evaluated === "-");
}

/** 段是否脚本解释器段（argv0 命中 SCRIPT_RUNNERS） */
export function isScriptRunnerSeg(seg: Segment): boolean {
  const bare = (seg.argv0 ?? "").split("/").pop() ?? "";
  return seg.argv0 !== null && SCRIPT_RUNNERS.has(bare);
}

/** 模型是否含脚本载荷族（解释器载荷旗标段或 cmdsub/var 展开词） */
export function detectScriptPayload(model: CommandModel): boolean {
  for (const seg of model.segments) {
    if (isScriptRunnerSeg(seg) && (hasPayloadFlag(seg) || seg.words.some(w => w.parts.some(p => p.type === "cmdsub" || p.type === "var")))) {
      return true;
    }
  }
  return model.payloads.some(p => p.model !== null && detectScriptPayload(p.model));
}

/** 病型 B/C：载荷脚本文本解析——命令引号自散架时走载荷级重组 span（病型 C，硬性负门：
 *  span 内写词面/新 runner 交界 → null=回落）；否则 evaluated 优先，null 时 cmdsub 拼原文
 *  （病型 B，var/arith/unknown 不拼——展开值不可知不猜）。 */
export function resolvePayloadScript(payloadWord: Word, flagWord: Word, commandText: string): { script: string | null; cMode: boolean } {
  const cMode = quoteUnbalanced(commandText);
  if (cMode) {
    const span = reassemblySpan(commandText, flagWord.span.end);
    if (runnerJunctionUnsafe(span)) return { script: null, cMode };
    return { script: span, cMode };
  }
  if (payloadWord.evaluated !== null) return { script: payloadWord.evaluated, cMode };
  if (payloadWord.parts.every(p => p.type === "lit" || p.type === "escape" || p.type === "cmdsub")) {
    return { script: payloadWord.parts.map(p => p.text).join(""), cMode };
  }
  return { script: null, cMode };
}
