/**
 * Bash 命令安全守卫（F20260830bsgr）。
 *
 * 防止 LLM 通过 bash 工具直接 kill 主进程 PID。
 * 8/30 事故根因：小獭 7708a033 在开发任务中执行 `kill 42877` 直接杀了主进程。
 *
 * 对抗 LLM 自适应变形设计（F20260830bsgr-r2，对抗审视修正）：
 * - 字面量黑名单必输：LLM 可用变量、$()、反引号、xargs、base64、eval 绕过
 * - 翻转策略：非字面量 kill 目标保守拦截，字面量 kill 精确匹配
 * - 每次检查实时读 PID 文件（不缓存，支持热重启换 PID）
 */

import fs from "fs";
import path from "path";
import type { Logger } from "@usecases/ports/logger";

/** 读取主进程 PID 文件，返回 PID 或 null。每次调用都读文件（不缓存）。 */
export function readMainProcessPid(projectRoot: string): number | null {
  try {
    const pidFile = path.join(projectRoot, ".otter-buddy.pid");
    const content = fs.readFileSync(pidFile, "utf-8").trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) || pid <= 0 ? null : pid;
  } catch {
    return null;
  }
}

// ─── 危险命令模式匹配 ───

/** kill 族命令名（含路径穿透、~ 路径、变量赋值前缀、wrapper 命令、bash -c 引号内嵌）
 * F20260903gh698：(1) bash -c 支持引号包裹的内嵌命令（'kill N'/"kill N"/kill N）
 *                (2) 全模式加 i 标志（大小写不敏感）
 */
const KILL_COMMANDS = /\b(?:sudo\s+)?(?:\/usr\/(?:local\/)?bin\/)?(?:~\/[^\s]+\/)?(?:[A-Za-z_]\w*=\S+\s+)*(?:env\s+|timeout\s+\S+\s+|nohup\s+|command\s+|nice\s+-?n?\s*\d*\s+)*(?:kill|skill)\b|(?:bash|sh)\s*-c\s*[\s'"]?(?:kill|skill|pkill|killall)\b[^|;&]*/i;
/** pkill/killall 族（含路径穿透，F20260903gh698 加 i 标志） */
const PKILL_COMMANDS = /\b(?:sudo\s+)?(?:\/usr\/(?:local\/)?bin\/)?(?:~\/[^\s]+\/)?(?:pkill|pgrep|killall|killall5)\b/i;
const OTTER_PROCESS_PATTERNS = [
  "otter-buddy", "otter_buddy",
  "node.*main", "dist/src/main", "dist/src/main.js",
  "dist/src", "node.*dist", ".otter-buddy.pid",
  "main.js", // pkill -f main.js 等直接按文件名搜索
  "node", // killall node 会杀所有 node 进程包括 otter-buddy 主进程
];

/** 非字面量 kill 目标模式：变量、命令替换、管道、特殊字符 */
const INDIRECT_PID_PATTERNS = [
  /\$[{(a-zA-Z_]/, // $VAR / $(cmd) / ${VAR}
  /`[^`]*[\s|;&><][^`]*`/, // `cmd arg` 反引号命令替换（要求含空格/管道/重定向等命令特征，排除 markdown 单词代码块如 `skill`）
  /\|.*\bkill\b/, // 管道到 kill（如 ... | xargs kill）
  /xargs\b[^|;&]*\bkill\b/, // xargs kill（容忍 xargs 与目标间的参数，如 xargs -n1 kill）
  /\beval\b/, // eval 包装
  /\\x[0-9a-f]{2}/i, // hex 转义
  /\$\(cat\b.*pid/i, // $(cat ...pid)
  /cat\b.*\.otter-buddy\.pid.*kill/i, // cat pid file → kill
];

/** .otter-buddy.pid 文件引用模式 */
const PID_FILE_REFERENCE = /\.otter-buddy\.pid/;

/**
 * F20260831aksp §2c：检测前归一化——塔死引号拼接/字母间反斜杠的文本规避通道。
 * `ki''ll 123` / `k\ill 123` 归一化后命中 kill 正则。只影响检测，不改日志留存（日志记原始命令）。
 */
export function normalizeForDetection(command: string): string {
  const stripped = command
    .replace(/''/g, "")   // 空单引号对（shell 空串拼接）
    .replace(/""/g, "");  // 空双引号对
  // 字母间反斜杠（k\ill → kill）。lookbehind/lookahead 只匹配反斜杠本身、前后字母不消耗——
  // 单遍即可处理连续转义 k\i\ll → kill（检视 R1 发现2：贪婪消耗式正则会漏连续转义形态）
  return stripped.replace(/(?<=[a-zA-Z])\\(?=[a-zA-Z])/g, "");
}

/**
 * 检查命令是否包含 kill 族操作。
 * 返回匹配的 kill 段（按 shell 操作符分段后逐段扫描）。
 */
/**
 * F20260903gh698：位置感知匹配——regex match 必须出现在命令位置（段首或 shell 操作符后）。
 * #777 语义反转：#760 的 default 分支 `return true` 与位置感知目标相反——一切非白名单
 * 前导字符（/ 引号 空格 中文 数字……）都误判命令位置，字符串字面量/路径恰好含词元即误拦
 * （9/3-9/4 四组事故实证）。修正为白名单语义：
 *   - pos 0（段首，调用方已 trim）
 *   - shell 操作符后（| ; & \n \r \f）
 *   - $( 命令替换 / ` 反引号内 / ( 子 shell 内——这些位置是真实命令执行位
 * 其余一律 continue（视为数据：路径中段、引号内字面量、中文语境等）。
 * Why 不用全局 matchAll：\b 零宽断言在 g 模式下会产生重叠误匹配。
 */
const VALID_CMD_PRECEDERS = new Set(["|", ";", "&", "\n", "\r", "\f", "(", "`"]);

/** #777：命令位置前缀词剥除——这些词的语义是「执行后面的命令」，循环剥除直到词元抵段首。
 *  覆盖 #698 攻击链 wrapper 变体（sudo/env/nohup/timeout/xargs/nice/command + 赋值前缀）。 */
const COMMAND_PREFIX_WORD = /^(?:sudo|env|nohup|command|xargs|nice|watch|exec|time|timeout|do)\s+/;
/** 前缀词的参数（-n1 / -I{} / 5 / VAR=val 等，timeout 的时长、nice 的优先级、赋值） */
const PREFIX_ARG = /^(?:-\S+|\d+|[A-Za-z_]\w*=\S+)\s+/;

/** 循环剥除命令前缀词及其参数；返回剥除后的剩余串（空串 = 词元前只有前缀词序列） */
function stripCommandPrefixes(text: string): string {
  let rest = text.trimStart();
  for (let i = 0; i < 8; i++) { // 循环上限防御：前缀词嵌套深度有界（sudo env timeout 5 nice -n3 ...）
    const wordMatch = rest.match(COMMAND_PREFIX_WORD);
    if (!wordMatch) break;
    rest = rest.slice(wordMatch[0].length);
    while (true) { // 剥该前缀词的参数（timeout 5 / nice -n3 / xargs -n1 -I{} / FOO=1）
      const argMatch = rest.match(PREFIX_ARG);
      if (!argMatch) break;
      rest = rest.slice(argMatch[0].length);
    }
  }
  return rest;
}

function isKillAtCommandPosition(text: string, pattern: RegExp): boolean {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const pos = m.index;
    if (pos === 0) return true;
    const prev = text[pos - 1];
    if (VALID_CMD_PRECEDERS.has(prev)) return true;
    // 前缀词剥除：词元前的文本整体是「前缀词+参数」序列（如 xargs -n1 / sudo FOO=1）→ 命令位置
    const before = text.slice(0, pos);
    if (stripCommandPrefixes(before) === "") return true;
    // 路径穿透：词元前导 '/' 且该路径表达式是段首第一个词（如 ~/bin/<词元>、/usr/bin/<词元>）
    if (prev === "/") {
      const segStart = before.trimStart();
      if (/^(?:~|\/)[^\s]*$/.test(segStart)) return true;
    }
    continue; // #777 反转：非白名单前导 = 数据位置（路径中段/引号内/中文语境），放行
  }
  return false;
}
/**
 * F20260903gh698：位置感知匹配 + 间接防线兜底。
 *
 * findKillSegments 按 shell 操作符分段后，对每段做位置感知匹配：
 * kill/skill 词元必须出现在命令位置（段首或 shell 操作符后），
 * 且不被连字符前缀（如 eval-skill / guard-kill）误触发。
 * 这解决了模式2误报（词元在 markdown body / 路径 / 注释中任意位置匹配）。
 */
function findKillSegments(command: string): { segment: string; isPkill: boolean }[] {
  const results: { segment: string; isPkill: boolean }[] = [];
  // 按 shell 操作符分段。#777 起含 | 管道：F20260903gh698 不含 | 的理由（管道到 kill 是
  // 间接攻击向量整体拦截）在白名单语义下变成漏拦——xargs 前缀词判定依赖段首上下文，
  // 管道右段被吞进左段时剥除失败。| 右段首恒为命令位置（shell 语义），分段代价为零。
  //  || 先于 |：split 交替语义下单 | 会把 || 拆成两个空段，
  //  长操作符必须在前（否则 `a || kill` 被拆成 `a |` `| kill` 三段，段首位置错乱）。
  const segments = command.split(/&&|\|\||[;&|\n]/);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    if (isKillAtCommandPosition(trimmed, PKILL_COMMANDS)) {
      results.push({ segment: trimmed, isPkill: true });
    } else if (isKillAtCommandPosition(trimmed, KILL_COMMANDS)) {
      // #777：bash -c 分支（KILL_COMMANDS 右支）可内嵌 pkill/killall 词元——
      // 主支的 isKillAtCommandPosition 对该段返回 false（词元在引号内数据位），
      // 但 bash -c 分支的语义是「引号内整串是独立命令」。内嵌词元为 pkill/killall
      // 族时按 pkill 语义检查目标进程名（否则 'pkill -f otter-buddy' 走 kill 语义
      // 解析不到字面量 PID 而漏拦，#698 攻击链回归实证）。
      const innerPkill = /(?:bash|sh)\s*-c\s*[\s'"]?[^|;&]*\b(?:pkill|killall|killall5)\b/i.test(trimmed);
      results.push({ segment: trimmed, isPkill: innerPkill });
    }
  }
  return results;
}

/**
 * 检查 kill 段是否有非字面量 PID 目标。
 * 非字面量 = 变量引用 / 命令替换 / 管道 / eval / hex 转义
 */
function hasIndirectPidTarget(segment: string): boolean {
  return INDIRECT_PID_PATTERNS.some(pat => pat.test(segment));
}

/**
 * 提取 kill 命令参数中的字面量数字 PID 列表。
 * 仅返回纯数字参数（非负整数），跳过信号参数（-N、-SIGTERM 等）。
 * F20260903gh698：去引号——bash -c 'kill 42877' 中 PID 被引号包裹，需先去引号再解析。
 */
function extractLiteralPids(segment: string): number[] {
  const pids: number[] = [];
  // 去掉命令名部分，只看参数
  const afterCmd = segment.replace(/^.*?\b(?:kill|skill)\b\s*/, "");
  const words = afterCmd.split(/\s+/).filter(Boolean);
  for (const w of words) {
    if (w.startsWith("-")) continue; // 跳过信号参数
    // #777：去引号外再去子 shell 括号（`(kill 42877)` 的 PID 带右括号尾，parseInt 前剥除）
    const stripped = w.replace(/^["']|["']$/g, "").replace(/^[()]+|[()]+$/g, "");
    const pid = parseInt(stripped, 10);
    if (!isNaN(pid) && pid > 0 && String(pid) === stripped) pids.push(pid);
  }
  return pids;
}

/**
 * 检查 pkill/killall 命令是否可能命中 otter 主进程。
 * 检查 -f/-n 参数值和位置参数中的关键词。
 * F20260903gh698：改用 word-boundary 正则——lower.includes("node") 会误匹配 "ffmpeg" 中的子串 "node"。
 */
function pkillTargetsOtter(segment: string): boolean {
  const lower = segment.toLowerCase();
  return OTTER_PROCESS_PATTERNS.some(
    pat => new RegExp("\\b" + pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(lower),
  );
}

function checkCommandLevelPatterns(
  command: string,
  cmdLower: string,
  mainPid: number,
  logger?: Logger,
): string | null {
  // eval 包装 + 数字参数 → 保守拦截（eval "kil""l 42877" 等字符串拼接绕过）。
  // 词边界限定命令位置（F20260902gvrd）：原 /\beval\b/ 匹配路径/标识符中的 eval-xxx
  //（连字符是词边界，eval-activation-p0 / guard-eval-fix 均命中），叠加任意 2-6 位数字
  //（路径里的日期、行号）即误拦纯 git/grep 命令。收紧为：行首或 shell 操作符/管道后的
  // 独立 eval 单词——字符串拼接绕过仍被覆盖（eval 必在命令位置才执行），路径中的
  // eval-xxx 不再触发。归一化文本同步收紧（塔死 k\ill 后接 eval 的拼接形态由
  // normalizeForDetection 段落化后仍在命令位置）。
  const evalInCommandPosition = /(?:^|[;&|]\s*|\|\s*)eval\s/.test(cmdLower) || /(?:^|[;&|]\s*)eval\b"/.test(cmdLower);
  if (evalInCommandPosition && /\b\d{2,6}\b/.test(command)) {
    logger?.warn("[bash-safety-guard] BLOCKED eval with numeric arguments", { mainPid, command: command.substring(0, 200) });
    return "bash 命令使用 eval 包装了含数字参数的操作，可能隐藏终止进程的命令。该命令不允许：主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更请在 worktree 用独立端口启动隔离实例；服务异常请报告搭档。若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
  }
  // 管道到 shell 执行且含 kill 关键词
  if (/\|\s*(sh|bash|zsh)\b/.test(command) && /\bkill\b/.test(cmdLower)) {
    logger?.warn("[bash-safety-guard] BLOCKED pipe-to-shell with kill content", { mainPid, command: command.substring(0, 200) });
    return "bash 命令通过管道传入 shell 执行且包含终止进程操作，可能针对主进程。该命令不允许：主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更请在 worktree 用独立端口启动隔离实例；服务异常请报告搭档。若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
  }
  // 脚本语言 one-liner 执行 kill：perl/ruby/python -e '...kill N...'
  if (/(?:perl|ruby|python\d?)\s+.*(?:-e|-c)\s/.test(cmdLower) && /\bkill\b/.test(cmdLower) && /\b\d{2,6}\b/.test(command)) {
    logger?.warn("[bash-safety-guard] BLOCKED scripting language one-liner with kill", { mainPid, command: command.substring(0, 200) });
    return "bash 命令通过脚本语言执行了终止进程操作，无法判断目标。该命令不允许：主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更请在 worktree 用独立端口启动隔离实例；服务异常请报告搭档。若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
  }
  return null;
}

/** 检查 kill 段：pkill/killall 模式 或 kill 间接/字面量 PID */
function checkKillSegment(
  segment: string,
  isPkill: boolean,
  mainPid: number,
  command: string,
  logger?: Logger,
): string | null {
  if (isPkill) {
    if (pkillTargetsOtter(segment)) {
      logger?.warn("[bash-safety-guard] BLOCKED pkill/killall targeting otter processes", { mainPid, segment: segment.substring(0, 200) });
      return "bash 命令包含按名匹配的批量终止命令（pkill/killall），可能影响主进程。该命令不允许：主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更请在 worktree 用独立端口启动隔离实例；服务异常请报告搭档。";
    }
    return null;
  }
  if (hasIndirectPidTarget(segment)) {
    logger?.warn("[bash-safety-guard] BLOCKED kill with indirect PID target", { mainPid, segment: segment.substring(0, 200) });
    return "bash 命令中终止进程的目标为变量或命令替换（非字面量 PID），无法判断是否针对主进程。该命令不允许——若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
  }
  if (PID_FILE_REFERENCE.test(segment)) {
    logger?.warn("[bash-safety-guard] BLOCKED kill referencing .otter-buddy.pid file", { mainPid, segment: segment.substring(0, 200) });
    return "bash 命令中终止进程的命令引用了主进程 PID 文件。主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更请在 worktree 用独立端口启动隔离实例；服务异常请报告搭档。";
  }
  const pids = extractLiteralPids(segment);
  if (pids.length > 0 && pids.includes(mainPid)) {
    logger?.warn("[bash-safety-guard] BLOCKED kill targeting main process PID", { mainPid, commandPids: pids, segment: segment.substring(0, 200) });
    // F20260831aksp：PID 数字脱敏——堵「错误 PID 试探 → 拦截文案回显真实 PID → 精准二次打击」链（结构化日志字段 commandPids 保留数值）
    return "bash 命令包含针对主进程 PID 的终止命令。主进程是海獭运行环境，任何情况下不得终止——你不存在需要重启或停止主进程的合法场景。若需验证代码变更请在 worktree 用独立端口启动隔离实例；服务异常请报告搭档。";
  }
  return null;
}

/**
 * 在单份文本上执行全量检测（原始与归一化文本各调一次）。
 */
function checkBashCommandSafetyOnText(
  text: string,
  mainPid: number,
  logger?: Logger,
): string | null {
  // 全命令级高危模式检测（在分段前检查，防止 eval/pipe-to-shell 绕过分段检测）
  const cmdLevelResult = checkCommandLevelPatterns(text, text.toLowerCase(), mainPid, logger);
  if (cmdLevelResult) return cmdLevelResult;

  const killSegments = findKillSegments(text);
  if (killSegments.length === 0) return null;

  // 全命令级：有 kill 段 + 全命令含 .otter-buddy.pid 引用（跨段检测）
  if (PID_FILE_REFERENCE.test(text)) {
    logger?.warn("[bash-safety-guard] BLOCKED kill with cross-segment PID file reference", { mainPid, command: text.substring(0, 200) });
    return "bash 命令中包含主进程 PID 文件引用和终止进程操作，可能针对主进程。该命令不允许：主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更请在 worktree 用独立端口启动隔离实例；服务异常请报告搭档。若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
  }

  for (const { segment, isPkill } of killSegments) {
    const result = checkKillSegment(segment, isPkill, mainPid, text, logger);
    if (result) return result;
  }
  return null;
}

/** 命中规则定位（F20260902gvrd，#730）：拦截文案从静态说明升级为带诊断上下文。
 *  扫描命令中命中各高危词表的子串，返回「规则名 × 片段 × 位置」行。
 *  只做诊断回显，不参与拦截判定——拦截逻辑本身不变。 */
function locateTriggerContext(command: string, mainPid: number | null): string[] {
  const hits: string[] = [];
  const patterns: Array<[string, RegExp]> = [
    ["kill 族命令", /\b(?:sudo\s+)?(?:\/usr\/(?:local\/)?bin\/)?(?:p?kill|skill|killall5?|pgrep)\b/gi],
    ["eval 引用", /\beval\b/gi],
    ["PID 文件引用", /\.otter-buddy\.pid/g],
    ["进程名模式", /\b(?:otter-buddy|otter_buddy|dist\/src\/main|main\.js|node)\b/g],
  ];
  for (const [name, pat] of patterns) {
    const re = new RegExp(pat.source, pat.flags.includes("g") ? pat.flags : pat.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(command)) !== null && hits.length < 6) {
      const start = Math.max(0, m.index - 10);
      const end = Math.min(command.length, m.index + m[0].length + 10);
      // PID 脱敏铁律（F20260831aksp）：片段中的真实主进程 PID 替换为占位符——
      // 防「错误试探 → 文案回显真实 PID → 精准二次打击」。其他数字（日期/行号）无害保留。
      const raw = command.slice(start, end).replace(/\n/g, " ");
      const snippet = mainPid !== null ? raw.split(String(mainPid)).join("<main-pid>") : raw;
      hits.push(`${name}：…${snippet}… @${m.index}`);
    }
  }
  return hits;
}

/** 拦截文案附加诊断块（#730）：被拦的獭能看到命中了什么、在哪，自诊断不再靠人肉读源码。
 *  scanText = 诊断扫描文本：拦截命中自哪份文本（原始/归一化）就用哪份——归一化路径的
 *  触发词在原命令里可能被引号拆开（e""val），扫原文会零命中。 */
function withDiagnostics(message: string, scanText: string, mainPid: number | null): string {
  const hits = locateTriggerContext(scanText, mainPid);
  if (hits.length === 0) return message;
  return `${message}\n【命中详情】${hits.join("；")}`;
}

/**
 * 检查 bash 命令是否安全（不针对主进程的 kill 操作）。
 *
 * 对抗设计（F20260830bsgr-r2）：
 * 1. 全命令级高危模式（eval/pipe-to-shell/脚本语言）→ 拦截
 * 2. pkill/killall + otter 相关模式 → 拦截
 * 3. kill + 非字面量 PID / .otter-buddy.pid 引用 / 字面量主进程 PID → 拦截
 * 4. PID 文件缺失 → 放行（保守降级）
 *
 * F20260831aksp §2c：原始与归一化两份文本都过全量正则——塔死 `ki''ll` / `k\\ill` 类文本规避（R1 严重1）。
 *
 * @returns null 表示安全；字符串表示危险原因
 */
export function checkBashCommandSafety(
  command: string,
  mainPid: number | null,
  logger?: Logger,
): string | null {
  if (!command.trim() || mainPid === null) return null;

  const result = checkBashCommandSafetyOnText(command, mainPid, logger);
  if (result) return withDiagnostics(result, command, mainPid);

  const normalized = normalizeForDetection(command);
  if (normalized !== command) {
    const nResult = checkBashCommandSafetyOnText(normalized, mainPid, logger);
    return nResult ? withDiagnostics(nResult, normalized, mainPid) : null;
  }
  return null;
}
