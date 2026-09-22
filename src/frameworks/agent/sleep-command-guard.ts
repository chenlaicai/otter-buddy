/**
 * F20260922slan：sleep 命令检测（独立规则模块，自 bash-safety-guard.ts 拆出控文件行数）。
 *
 * 痛点锚：海獭裸跑 `sleep 30 && gh pr checks` 对搭档是长时间静默黑盒（搭档原话：
 * 「我只感觉到海獭一直没说话、然后执行很长一段时间」）。收编哲学（梯度分层）：
 * 拦截 → 引导先 speak 说明理由 → 改用 wait 工具（正道，含 reason 自证 + until 苏醒检查）。
 *
 * 覆盖形态（守卫只扫命令字符串，`bash scripts/x.sh` 文件形态零影响）：
 * - `sleep` 在命令位置（复用位置感知：段首/shell 操作符后/$( 内；COMMAND_PREFIX_WORD
 *   剥除覆盖 `timeout 30 sleep 5` 等前缀包装）
 * - 时长参数可静态解析（单位 s/m/h/d、小数、多参数求和）且总时长 ≥ 5s
 * - `sleep infinity` / `sleep inf`（GNU 同义词）= 最长静默形态，必拦
 * 放行：总时长 < 5s（微 sleep 重试抖动搭档无感）、真不可解析形态（`sleep $X` /
 * `sleep $(cat t)`——变量无法判断时长，宁漏勿误，归逃逸面）。
 * 实测语义（检视 S5）：`sleep 5 6`=11s（多参数求和）、`sleep 0.1m`=6s、`sleep 1h` 真实存在。
 *
 * 依赖注入：位置感知判定函数（isCommandPosition / extractCommandSegment）由守卫主文件
 * 传入——本模块零重复实现，与 kill 族位置感知同一份逻辑（口径一致，防漂移）。
 *
 * 返回：带 SLEEP_REASON_PREFIX 标记的拦截文案（发射点据此分流 bash_sleep:），或 null 放行。
 */

import type { Logger } from "@usecases/ports/logger";

/** sleep 拦截标记前缀——守卫内部返回的 sleep 拦截文案统一带此前缀，
 *  circuit-breaker-helpers 发射点据此分流为 `bash_sleep:`（与 kill 域 `bash_safety:` 分离，D5a）。
 *  判定用 startsWith（delta-3 备注：精确匹配/结构化字段，禁用 includes）。 */
export const SLEEP_REASON_PREFIX = "__bash_sleep_block__:";

const SLEEP_COMMAND = /\bsleep\b/i;
/** sleep 时长参数：数值+可选单位后缀（s=秒/m=分/h=时/d=天，GNU sleep 全支持） */
const SLEEP_DURATION = /^(\d+(?:\.\d+)?)([smhd]?)s?$/i;
const SLEEP_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
const SLEEP_INFINITE = /^(?:inf|infinity)$/i;

/** 解析单参数字符串为秒数；不可解析返回 null（保守放行——变量/命令替换形态） */
function parseSleepDurationSeconds(token: string): number | null {
  if (SLEEP_INFINITE.test(token)) return Number.POSITIVE_INFINITY;
  const m = token.match(SLEEP_DURATION);
  if (!m) return null;
  const value = parseFloat(m[1]);
  const unit = (m[2] || "s").toLowerCase();
  return value * (SLEEP_UNITS[unit] ?? 1);
}

/** sleep 拦截文案（kill 域文案零共用——sleep 是感知问题非安全问题，措辞向引导而非禁止） */
function buildSleepBlockMessage(durationDesc: string): string {
  return `检测到你使用了 sleep 等待（约 ${durationDesc}）。裸 sleep 会让搭档看到长时间静默黑盒。请先 speak 说明你要等什么、为什么要等这么久，然后改用 wait 工具（wait 的 seconds/reason/until 参数支持等待+理由自证+可选的苏醒检查命令）。`;
}

/** 判定函数签名（位置感知由守卫主文件注入——与 kill 族同一份逻辑，口径一致防漂移） */
export interface SleepGuardDeps {
  /** 词元是否在命令位置（段首/操作符后/$( 内/前缀词剥除后）——同 isKillAtCommandPosition 判定 */
  isCommandPosition: (text: string, pattern: RegExp) => boolean;
}

/** 提取首个命令位置的词元段（到 shell 操作符/行尾为止），供参数解析。
 *  复用 deps.isCommandPosition 判定命令位——同一判定逻辑，避免口径漂移。 */
function extractCommandSegment(text: string, pattern: RegExp, isCommandPosition: SleepGuardDeps["isCommandPosition"]): string | null {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  const m = re.exec(text);
  if (!m) return null;
  if (!isCommandPosition(text, pattern)) return null;
  const after = text.slice(m.index);
  const endMatch = after.search(/[|;&\n]|&&|\|\|/);
  return endMatch === -1 ? after : after.slice(0, endMatch);
}

export function checkSleepCommand(
  command: string,
  logger: Logger | undefined,
  deps: SleepGuardDeps,
): string | null {
  // 位置感知：sleep 词元须出现在命令位置
  if (!deps.isCommandPosition(command, SLEEP_COMMAND)) return null;
  const seg = extractCommandSegment(command, SLEEP_COMMAND, deps.isCommandPosition);
  if (!seg) return null;
  const tokens = seg.split(/\s+/).filter(Boolean).slice(1); // 去命令名
  if (tokens.length === 0) return null; // 裸 `sleep` 无参（非法但非本规则管辖）
  let totalSeconds = 0;
  for (const tok of tokens) {
    const secs = parseSleepDurationSeconds(tok);
    if (secs === null) return null; // 存在不可解析参数（变量/命令替换）→ 保守放行
    totalSeconds += secs;
  }
  if (totalSeconds === Number.POSITIVE_INFINITY) {
    logger?.warn("[bash-safety-guard] BLOCKED sleep infinity (longest silent form)", { command: command.substring(0, 200) });
    return SLEEP_REASON_PREFIX + buildSleepBlockMessage("无限");
  }
  if (totalSeconds < 5) return null; // 微 sleep：搭档无感，防误伤脚本/重试抖动
  logger?.warn("[bash-safety-guard] BLOCKED bare sleep >=5s (silent-wait guard)", { totalSeconds, command: command.substring(0, 200) });
  return SLEEP_REASON_PREFIX + buildSleepBlockMessage(`${totalSeconds} 秒`);
}

/** F20260922slan：剥离 sleep 拦截标记（若带标记）。标记只存在于守卫内部传输，
 *  对外（含诊断文案）一律是干净文案——发射点据原始标记决定 `bash_sleep:` 前缀。
 *  判定用 startsWith（delta-3 备注：精确匹配，禁用 includes）。 */
export function stripSleepMarkerIfPresent(reason: string): string {
  return reason.startsWith(SLEEP_REASON_PREFIX) ? reason.slice(SLEEP_REASON_PREFIX.length) : reason;
}
