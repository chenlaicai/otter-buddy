/**
 * kill 段查找与词元位置判定（F20260922gpqa 从 bash-safety-guard.ts 拆出）。
 *
 * 拆分离由：bash-safety-guard.ts 基线恰满 max-lines 450 上限，#852 引号感知修复
 * 净增代码必然超限。本组（KILL/PKILL 词元目录 + 命令位置判定 + 段查找）自包含、
 * 纯函数无状态，独立成文件后主文件回落至上限内。语义零变更（纯搬迁 + #852 新增分支）。
 */

/** kill 族命令名（含路径穿透、~ 路径、变量赋值前缀、wrapper 命令、bash -c 引号内嵌）
 * F20260903gh698：(1) bash -c 支持引号包裹的内嵌命令（'kill N'/"kill N"/kill N）
 *                (2) 全模式加 i 标志（大小写不敏感）
 */
export const KILL_COMMANDS = /\b(?:sudo\s+)?(?:\/usr\/(?:local\/)?bin\/)?(?:~\/[^\s]+\/)?(?:[A-Za-z_]\w*=\S+\s+)*(?:env\s+|timeout\s+\S+\s+|nohup\s+|command\s+|nice\s+-?n?\s*\d*\s+)*(?:kill|skill)\b|(?:bash|sh)\s*-c\s*[\s'"]?(?:kill|skill|pkill|killall)\b[^|;&]*/i;
/** pkill/killall 族（含路径穿透，F20260903gh698 加 i 标志） */
export const PKILL_COMMANDS = /\b(?:sudo\s+)?(?:\/usr\/(?:local\/)?bin\/)?(?:~\/[^\s]+\/)?(?:pkill|pgrep|killall|killall5)\b/i;

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
const COMMAND_PREFIX_WORD = /^(?:sudo|env|nohup|command|xargs|nice|watch|exec|time|timeout|do)\b\s+/;
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

export function isKillAtCommandPosition(text: string, pattern: RegExp): boolean {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const pos = m.index;
    if (pos === 0) return true;
    // #923 检视建议 1 处置：跳过紧邻空白找真实前导字符——`$( k... )` / `( k... )`
    // 的词元前是空格、空格前才是命令替换/子 shell 边界。只看 pos-1 会把命令位
    // 误判为数据位（#777 既有缺口，引号内 $() 真实执行逃逸）。空白跳过不改变
    // 数据位判定（路径中段/引号内/中文语境的非空白前导仍在白名单外）
    let i = pos - 1;
    while (i >= 0 && /\s/.test(text[i])) i--;
    const prev = i >= 0 ? text[i] : "";
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
/** kill 段查找结果（#1154 r1）：payload 仅 bash/sh -c 载荷级命中携带；
 *  source:"pipe" 标记该段是管道右段（kill 目标来自上游 stdin，间接来源）；
 *  outer 仅载荷级命中携带（含 bash -c 包装与外层位置参数的原始段文本）——
 *  #1154 r2（N1）：载荷引用位置参数（$0/$1/$@…）时外层参数成为 kill 目标的
 *  一部分（`bash -c 'kill $0' 42877` 的 $0 绑定 42877），PID 判定需在引用时纳入。 */
export interface KillSegment { segment: string; isPkill: boolean; payload?: string; source?: "pipe"; outer?: string }

/** 单段 kill 位置判定（findKillSegments 主支/次支出口）
 * #1154 r1：从 findKillSegments 拆出——分段循环内分支复杂度超限。 */
function matchKillAtPosition(trimmed: string, pipeSource: boolean): KillSegment | null {
  if (isKillAtCommandPosition(trimmed, PKILL_COMMANDS)) {
    return { segment: trimmed, isPkill: true, ...(pipeSource ? { source: "pipe" as const } : {}) };
  }
  if (!isKillAtCommandPosition(trimmed, KILL_COMMANDS)) return null;
  // #777：bash -c 分支（KILL_COMMANDS 右支）可内嵌 pkill/killall 词元——
  // 主支的 isKillAtCommandPosition 对该段返回 false（词元在引号内数据位），
  // 但 bash -c 分支的语义是「引号内整串是独立命令」。内嵌词元为 pkill/killall
  // 族时按 pkill 语义检查目标进程名（否则 'pkill -f otter-buddy' 走 kill 语义
  // 解析不到字面量 PID 而漏拦，#698 攻击链回归实证）。
  const innerPkill = /(?:bash|sh)\s*-c\s*[\s'"]?[^|;&]*\b(?:pkill|killall|killall5)\b/i.test(trimmed);
  return { segment: trimmed, isPkill: innerPkill, ...(pipeSource ? { source: "pipe" as const } : {}) }
}

export function findKillSegments(command: string): KillSegment[] {
  const results: KillSegment[] = [];
  // 按 shell 操作符分段。#777 起含 | 管道：F20260903gh698 不含 | 的理由（管道到 kill 是
  // 间接攻击向量整体拦截）在白名单语义下变成漏拦——xargs 前缀词判定依赖段首上下文，
  // 管道右段被吞进左段时剥除失败。| 右段首恒为命令位置（shell 语义），分段代价为零。
  //  || 先于 |：split 交替语义下单 | 会把 || 拆成两个空段，
  //  长操作符必须在前（否则 `a || kill` 被拆成 `a |` `| kill` 三段，段首位置错乱）。
  const segments = command.split(/&&|\|\||[;&|\n]/);
  // 段在原文中的偏移（split 不含分隔符——管道右段判定需要段前分隔符是单 |）
  let segOffset = 0;
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    // #1154 r1：管道右段的 kill 目标来自上游 stdin（间接来源）。split 把 | 吞了，
    // 段文本不含 |——看段起点前一个字符：trimmed 在原文中的起始位置前是 |（且不是
    // || 的第二个）即管道右段。分段把 `lsof | xargs kill` 切成两段后，右段单看无
    // 管道，source 标记让语义层恢复「目标来自 stdin」的间接来源判定。
    const segStart = command.indexOf(trimmed, segOffset);
    segOffset = segStart + trimmed.length;
    // 往前跳过空白看分隔符：| 且前一个不是 |（排除 || 第二字符）即管道右段
    let p = segStart - 1;
    while (p >= 0 && /\s/.test(command[p])) p--;
    const pipeSource = p >= 0 && command[p] === "|" && (p < 1 || command[p - 1] !== "|");
    const direct = matchKillAtPosition(trimmed, pipeSource);
    if (direct) {
      results.push(direct);
      continue;
    }
    // #852：引号包裹的 bash/sh -c 载荷——外层检测对引号内第二位起的词元失效
    //（右支要求词元紧邻 -c、innerPkill 被引号内 ; 截断），提取载荷递归检测补齐。
    // #1154 r1（S2/S3）：逐载荷入结果——hits[0]+break 会让首个良性命中遮蔽后续载荷
    // 的真实攻击（良性 decoy 漏拦）；判定文本改用载荷级命中段（hit.segment），外层
    // 包装/传参/注释不是 kill 目标语义的一部分（混入致注释命中进程名表、传参变量
    // 命中间接 PID 模式两类误拦）。
    for (const payload of extractDashCPayloads(trimmed)) {
      for (const hit of findKillSegments(payload)) {
        results.push({ segment: hit.segment, isPkill: hit.isPkill, payload, outer: trimmed, ...(hit.source ? { source: hit.source } : {}) });
      }
    }
  }
  return results;
}

/** #852：提取 bash/sh -c 的引号包裹载荷（不含外层引号）。无引号形态走 KILL 右支原路径。 */
function extractDashCPayloads(segment: string): string[] {
  const out: string[] = [];
  const re = /(?:bash|sh)\s*-c\s*(?:'([^']*)'|"([^"]*)")/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) {
    const payload = (m[1] ?? m[2] ?? "").trim();
    if (payload) out.push(payload);
  }
  return out;
}
