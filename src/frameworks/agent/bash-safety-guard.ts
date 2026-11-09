/**
 * Bash 命令安全守卫·终态（F20261030gblkv，guard-v4）。
 *
 * 架构：黑名单两层流水线——第一站杀进程判定（9/16 原点，唯一硬目标），
 * 第二站黑名单两类（凭证路径/下载即执行）。看不懂的放行（宁漏勿误）。
 *
 * 决策链（搭档 2026-10-29 拍板，原话锚定见 F20261030gblkv 特性文档）：
 * - 「禁止白名单！只允许有黑名单！」——白名单写区/git 动态授权/沙箱层全部退役
 * - 守卫原点=防獭杀主进程（9/16 事故 F20260916gtlr）；「守卫 git」是漂移出的伪目标
 * - sandbox-exec（Apple deprecated）整层退役；验证=回放回归库（真实使用为准）
 *
 * F20261109bexfz（搭档 2026-11-09 拍板）：B 类外发域名表判定整类退役——「防外发」
 * 需求无真实来源（搭档原话「这个防止外发的需求我甚至都不知道是从哪里提出的，肯定
 * 不是我遇到过的……那说明这只是个虚构的伪需求」）；白名单语义与「只允许黑名单」总则
 * 相反。curl/wget 的 POST/PUT 外发不再看目的地；存量 healing 归因由 classify 指纹表
 * 回溯兑底（指纹在表、ID 退役、isHistoricalAttribution）。
 *
 * 保留的既有资产（语义不变，从旧版继承）：
 * - kill-segment-finder.ts：kill 族命令位置粗筛（四层：位置/引号状态机/$()嵌套/前缀包装）
 * - SERVICE_SCRIPT_KILL：服务脚本自杀模式（9/16 原案，字面无 kill）
 * - 非字面量 kill：F20261105killa 政策 A 退役保守拦——能确认才拦（字面量三查/PID 文件引用/pkill 特征名），确认不了放行（宁漏勿误贯彻第一站）
 * - #844 白名单端口溯源：kill $(lsof :3100) 类受控放行（allowed-service-ports）
 * - PID 文件（.otter-buddy.pid）：主进程号码主源
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "node:child_process";
import type { Logger } from "@usecases/ports/logger";
import { findKillSegments } from "./kill-segment-finder";
import type { GuardRuleLayer } from "./guard-intercept-classify";
import {
  loadAllowedServicePorts,
  extractWhitelistedPortRefs,
  type AllowedService,
} from "./allowed-service-ports";

export type { AllowedService };

// ─── 守卫选项 ───

export interface GuardOptions {
  /** 主仓根绝对路径（PID 文件/白名单定位基准） */
  projectRoot?: string;
  /** session 工作目录（兼容参数：v4 判定不依赖，保留签名兼容调用方） */
  sessionCwd?: string;
  /** 兼容参数：v4 无沙箱层，此标志不再影响判定（保留签名兼容） */
  sandboxGuarded?: boolean;
  /** 测试注入：进程查询桩（生产缺省真查 lsof/ps） */
  processProbe?: ProcessProbe;
  /** F20261109bexfz 退役兼容参数：B 类外发域名表已删除，此字段不再影响判定
   *  （保留签名兼容存量调用方/测试桩，传值静默忽略）。 */
  allowedEgressDomains?: string[];
}

// ─── 主进程身份（运行时事实三查） ───

/** 进程查询接口：生产真查（lsof/ps），测试可注入桩 */
export interface ProcessProbe {
  /** 谁在监听某端口 → PID（无则 null） */
  whoListens(port: number): number | null;
  /** PID 的档案：{直接父进程号, 完整命令行}（进程不存在→null） */
  identity(pid: number): { ppid: number; args: string } | null;
}

/** 主进程指纹：命令行必含入口路径（部署布局不变则终身有效） */
const MAIN_ARGS_SIGNATURE = "otter-buddy/dist/src/main.js";

const realProbe: ProcessProbe = {
  whoListens(port) {
    try {
      const out = execFileSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], {
        encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      const pid = Number.parseInt(out.split("\n")[0] ?? "", 10);
      return Number.isFinite(pid) ? pid : null;
    } catch { return null; }
  },
  identity(pid) {
    try {
      const out = execFileSync("ps", ["-p", String(pid), "-o", "ppid=,args="], {
        encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      const line = out.split("\n")[0] ?? "";
      const ppid = Number.parseInt(line, 10);
      if (!Number.isFinite(ppid)) return null;
      return { ppid, args: line.slice(line.indexOf(String(ppid)) + String(ppid).length).trim() };
    } catch { return null; }
  },
};

/** 读取主进程 PID 文件（每次判定现读，不缓存——支持热重启换 PID） */
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

// ─── 第一站：杀进程判定 ───

/** 服务脚本自杀模式（9/16 原案：otter-buddy.sh stop/restart，字面无 kill） */
const SERVICE_SCRIPT_KILL = /(?:^|[;&|`$(])\s*(?:sudo\s+)?(?:(?:bash|sh)\s+)?(?:[\w.~/-]*\/)?(?:scripts\/)?otter-buddy\.sh\s+(?:stop|restart)\b/;

/** PID 文件引用——直接指向主进程号码来源 */
const PID_FILE_REFERENCE = /\.otter-buddy\.pid/;

/** pkill/killall 族命中的主进程特征名（按名匹配无法区分目标，恒拦） */
const PKILL_OTTER_PATTERNS = [
  "otter-buddy", "otter_buddy", "dist/src/main", "dist/src/main.js",
  ".otter-buddy.pid", "main.js", "node",
];

/** 从 kill 段提取字面量 PID 参数（信号参数跳过；#777：剥引号与子 shell 括号） */
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

function pkillTargetsOtter(segment: string): boolean {
  const lowered = segment.toLowerCase();
  return PKILL_OTTER_PATTERNS.some(p => lowered.includes(p.toLowerCase()));
}

/** #844 白名单端口溯源放行（现有机制保留）：kill $(lsof :3100) 类 alpha 实例清理 */
function whitelistedPortAllow(
  killSegments: { segment: string; isPkill: boolean }[],
  command: string,
  allowed: AllowedService[],
  mainPid: number,
): boolean {
  if (allowed.length === 0) return false;
  if (PID_FILE_REFERENCE.test(command)) return false;
  for (const k of killSegments) {
    if (extractLiteralPids(k.segment).includes(mainPid)) return false;
    if (k.isPkill && pkillTargetsOtter(k.segment)) return false;
  }
  const portHits = extractWhitelistedPortRefs(command, allowed);
  if (portHits.length === 0) return false;
  const allSegments = command.split(/&&|\|\||[;&|\n]/).map(s => s.trim()).filter(Boolean);
  return killSegments.every(k => {
    const seg = k.segment;
    if (!/\b(?:kill|skill|pkill|killall)\b/.test(seg)) return true;
    if (/\blsof\b/.test(seg) && portHits.some(p => seg.includes(`:${p}`))) return true;
    const rawIdx = allSegments.indexOf(seg);
    if (rawIdx > 0) {
      const prev = allSegments[rawIdx - 1];
      if (/\blsof\b/.test(prev) && portHits.some(p => prev.includes(`:${p}`))) return true;
    }
    const vars = [...seg.matchAll(/\$([A-Za-z_]\w*)/g)].map(m => m[1]);
    return vars.some(v =>
      portHits.some(p => {
        const assign = new RegExp(`\\b${v}\\s*=\\s*\\$\\(\\s*lsof[^)]*:${p}\\b`, "g");
        const matches = [...command.matchAll(assign)];
        if (matches.length === 0) return false;
        const last = matches[matches.length - 1];
        const lastAssignEnd = (last.index ?? 0) + last[0].length;
        return !new RegExp(`\\b${v}\\s*=`).test(command.slice(lastAssignEnd));
      }),
    );
  });
}

/**
 * F20261102grfix（B 治本·拦截点直标）：拦截返回值从纯文案升级为文案+归因键绑定对。
 *
 * 背景：ruleId 此前靠 guard-intercept-classify 事后按文案特征片段反查——文案面向人
 * （改写/动态前缀/多出口分裂）而归因键需要机器稳定，文案一改指纹表即脱节（10-19 抽取
 * 须人肉保锚片段、10-30 v4 重写后整表重对齐两次实证）。现拦截判定处直接给出 ruleId，
 * classify 降级为存量回溯兜底。文案（text）可随意润色，ruleId 是稳定身份永不改。
 */
export interface GuardBlock {
  /** 拦截文案（面向 LLM/人，允许改写） */
  text: string;
  /** 稳定归因键（面向机器，历史聚合连续性锚点） */
  ruleId: string;
  /** 宪法分层（与 guard-intercept-classify 的 GuardRuleLayer 同域） */
  layer: GuardRuleLayer;
}

const MAIN_KILL_BLOCK_MSG: GuardBlock = {
  text: "目标命中主进程（otter-buddy 主服务）——海獭不能杀主进程。需要重启服务走 restart-service 工具（受控通道）；stop/restart 脚本同样禁止直接执行。",
  ruleId: "self_kill_main",
  layer: "self_kill",
};
// F20261105killa 政策 A：INDIRECT_KILL_BLOCK_MSG（self_kill_nonliteral）随保守拦退役删除——
// 历史文案归因由 guard-intercept-classify 指纹表承担（RETIRED_RULE_IDS 封存、可分类不活跃）。
const PKILL_OTTER_BLOCK_MSG: GuardBlock = {
  text: "pkill/killall 按名匹配会命中主进程（node/otter-buddy 特征名）——不允许。精确终止请用字面量 PID kill。",
  ruleId: "self_kill_byname",
  layer: "self_kill",
};

/** 字面量 kill 目标的三查身份（一查 PID 相等 / 二查 args 指纹 / 三查直接父进程）——返回拦截块或 null（放行） */
function checkLiteralKillTarget(segment: string, mainPid: number | null, probe: ProcessProbe): GuardBlock | null {
  const literalPids = extractLiteralPids(segment);
  if (literalPids.length === 0) return null; // 调用方继续走非字面量分支
  if (mainPid !== null && literalPids.includes(mainPid)) return MAIN_KILL_BLOCK_MSG; // 一查
  if (literalPids.some(pid => literalPidTargetsMain(pid, mainPid, probe))) return MAIN_KILL_BLOCK_MSG; // 二查+三查
  return null; // 字面量全过——放
}

/** 单个字面量 PID 的二查+三查：args 指纹 / 直接父进程是主进程 / PID 文件缺失时指纹兜底 */
function literalPidTargetsMain(pid: number, mainPid: number | null, probe: ProcessProbe): boolean {
  const id = probe.identity(pid); // 进程不存在 → null → 放行（非主进程）
  if (!id) return false;
  if (id.args.includes(MAIN_ARGS_SIGNATURE)) return true; // 二查：指纹即主进程本体
  if (mainPid === null) return false; // PID 文件缺失：指纹兜底链已由上行覆盖，不另外推
  return id.ppid === mainPid; // 三查：直接父进程是主进程（直系 worker，杀它连带主进程）
}

/** S2（检视初轮）：广播/进程组 kill 目标——kill -1 / kill -9 -1 / kill -- -<PGID>。
 *  kill(2) 语义：pid<-1=进程组、pid=-1=广播（全部用户进程，必含主进程）——无法静态
 *  排除主进程，保守拦（P0 面优先于宁漏勿误；主进程 PID 可经 ps 获知故同拦）。 */
const BROADCAST_KILL_BLOCK_MSG: GuardBlock = {
  text: "kill 目标为广播/进程组（-1 或 -- -PGID）——无法静态排除主进程，保守拦截。请用字面量 PID kill（非主进程放行）。",
  ruleId: "self_kill_process_group",
  layer: "self_kill",
};

function broadcastKillTargetHit(segment: string): boolean {
  // 剥掉命令名与信号参数后，看目标位置是否 -1 或 -- -N 形态
  const afterCmd = segment.replace(/^.*?\b(?:kill|skill)\b\s*/, "");
  const args = afterCmd.split(/\s+/).filter(Boolean);
  // 显式 -- 分隔后的首个参数是目标（kill -- -123）
  const ddIdx = args.indexOf("--");
  if (ddIdx >= 0 && args.slice(ddIdx + 1).some(a => /^-\d+$/.test(a))) return true;
  // 无信号声明时首参 -1（kill -1 / kill -9 -1 均命中：信号参数已被前面 continue 跳过语境，
  // 这里直接看是否存在裸 -1 目标：跳过首参若它是信号（-9 等），其余 -1 或负数即广播/组）
  const rest = args.filter((a, i) => !(i === 0 && /^-[A-Za-z0-9]+$/.test(a)));
  return rest.some(a => a === "-1" || /^-\d+$/.test(a));
}

/** 非字面量 kill 目标（F20261105killa 政策 A：能确认才拦，确认不了放行）。
 *
 *  演进史：8/30 初版「能确认才拦」→ 8/30 审视轮为堵非字面量绕过临时翻转为保守拦 →
 *  10/30 guard-v4 重建将其作「既有资产」原样保留（与 v4 总则「宁漏勿误」内在矛盾，
 *  落在第一站未扫净的旧角落）→ 11/05 搭档拍板政策 A，原则统一：宁漏勿误贯彻第一站。
 *
 *  保留的确认通道（拦得有依据）：
 *  - PID 文件引用（kill $(cat .otter-buddy.pid)）——目标就是主进程号码来源
 *  - 管道直接来源是主 PID 文件（cat .otter-buddy.pid | xargs kill——检视 S1：
 *    kill 段自身无 pid 文件引用但 stdin 直接来自主 pid 文件，数据流等价于命令
 *    替换，属「能确认」）；其他 pid 文件（pids/backend.pid 等自有资产）不在此列，放行
 *  - 白名单端口溯源放行先行（#844，allowed-service-ports）
 *  其余非字面量形态（变量/$()/管道/xargs——无法静态求值，也即无法确认为主进程）放行。 */
function checkIndirectKillTarget(
  killSegments: { segment: string; isPkill: boolean; source?: "pipe" }[],
  command: string,
  segment: string,
  allowedServices: AllowedService[],
  mainPid: number | null,
): GuardBlock | null {
  if (whitelistedPortAllow(killSegments, command, allowedServices, mainPid ?? -1)) return null;
  if (PID_FILE_REFERENCE.test(segment)) return MAIN_KILL_BLOCK_MSG;
  // 检视 S1：管道右段的直接来源若是主 PID 文件——kill $(cat pid) 与 cat pid | xargs kill
  // 数据流等价（stdin 即目标清单），同属「能确认是主进程」——拦；自有 pid 文件不匹配
  // PID_FILE_REFERENCE（仅主进程 pid），自然落入放行分支。
  const seg = killSegments.find(k => k.segment === segment);
  if (seg?.source === "pipe" && upstreamIsMainPidFile(command, segment)) return MAIN_KILL_BLOCK_MSG;
  return null; // 政策 A：确认不了 ≠ 拦——非字面量目标放行（宁漏勿误）
}

/** 检视 S1：kill 段（管道右段）的直接 stdin 来源是否主 PID 文件。
 *  定位 kill 段在原文的偏移，向左找最近的段分隔符，取左段（trim 后）判是否
 *  「cat/读到主 pid 文件」的命令形态（cat <pidfile> / < <pidfile>）。
 *  只认直接相邻段——两步以上构造（先存变量再管道）属「确认不了」放行面。 */
function upstreamIsMainPidFile(command: string, segment: string): boolean {
  const segStart = command.indexOf(segment);
  if (segStart <= 0) return false;
  const left = command.slice(0, segStart);
  // 截到最后一个段分隔符（| / && / ; 等）——即 kill 段的直接上游段。
  // 注意：上游段本身可含管道（cat a.pid | head）——取「最后一个分隔符之后的全部」时
  // 要允许上游内的 | 不被截断：改用 [^;&|] 排除其他分隔符但单独保留 | 的多级形态。
  // 实现简化：先按分号/&&/\n 截最后一个段，再在该段内找最后一个管道链的最后一级。
  const clause = left.split(/[;&]|&&|\n/).pop() ?? "";
  const pipeParts = clause.split("|");
  const upstream = (pipeParts.length > 1 ? pipeParts[pipeParts.length - 2] : clause).trim();
  if (!upstream) return false;
  // 直接来源形态：cat/读取主 pid 文件（cat <pidfile> 或 < <pidfile> 重定向）。
  // 上游链中间可有 head/awk 等过溗环节——只要链内有 cat 主 pid 文件即认（数据流仍直接）。
  // 自有 pid 文件（pids/backend.pid）不匹配 PID 文件名，自然落入放行分支。
  return /\bcat\b[^|]*\.otter-buddy\.pid/.test(upstream)
    || /<\s*\S*\.otter-buddy\.pid/.test(upstream);
}

/** kill 段循环判定（从 checkKillStation 拆出，complexity 分解） */
function checkKillSegments(command: string, mainPid: number | null, probe: ProcessProbe, guardOptions: GuardOptions | undefined): GuardBlock | null {
  // kill 族粗筛（kill-segment-finder：命令位置/引号/$()嵌套/前缀包装）
  const killSegments = findKillSegments(command);
  if (killSegments.length === 0) return null;

  const allowedServices = guardOptions?.projectRoot ? loadAllowedServicePorts(guardOptions.projectRoot) : [];

  for (const k of killSegments) {
    // pkill/killall 族：按名匹配
    if (k.isPkill) {
      if (pkillTargetsOtter(k.segment)) return PKILL_OTTER_BLOCK_MSG;
      continue; // 非特征名（如 pkill vitest）放行
    }
    // S2：广播/进程组目标保守拦（-1 广播必含主进程；ps 可获知 PGID 同拦）
    if (broadcastKillTargetHit(k.segment)) return BROADCAST_KILL_BLOCK_MSG;
    // kill 字面量：三查身份；无字面量则走非字面量分支
    const literalBlock = checkLiteralKillTarget(k.segment, mainPid, probe);
    if (literalBlock) return literalBlock;
    if (extractLiteralPids(k.segment).length === 0) {
      const indirectBlock = checkIndirectKillTarget(killSegments, command, k.segment, allowedServices, mainPid);
      if (indirectBlock) return indirectBlock;
    }
  }
  return null;
}

/** 第一站主判定 */
function checkKillStation(
  command: string,
  mainPid: number | null,
  logger: Logger | undefined,
  guardOptions: GuardOptions | undefined,
): GuardBlock | null {
  // 服务脚本自杀（9/16 原案）
  if (SERVICE_SCRIPT_KILL.test(command)) return MAIN_KILL_BLOCK_MSG;
  return checkKillSegments(command, mainPid, guardOptions?.processProbe ?? realProbe, guardOptions);
}

// ─── 第二站：黑名单三类 ───

/** A 类：凭证路径。读写都算；~ 展开与绝对路径双形态 */
const CREDENTIAL_PATH_PATTERNS = [
  /\.ssh([/ "'$]|$)/,
  /\.gnupg([/ "'$]|$)/,
  /\.aws([/ "'$]|$)/,
];

/** 展开归一：~/x 与 /Users/<who>/.x 双形态都认（不依赖 HOME 求值——路径特征即拦） */
function credentialPathHit(command: string): boolean {
  // 命令中出现 ~/.ssh 形态或 <home>/.ssh 形态。家目录绝对路径形态由 HOME 前缀匹配：
  const home = process.env.HOME ?? "";
  const normalized = home ? command.split(home).join("~") : command;
  return CREDENTIAL_PATH_PATTERNS.some(p => p.test(normalized));
}

/** F20261109bexfz（搭档 2026-11-09 拍板）：B 类外发域名表判定整类退役——
 *  原 uploadExfilHit/makeEgressDomainAllowed/DEFAULT_EGRESS_DOMAINS/uploadVerbHitFor/
 *  NETWORK_EXFIL_BLOCK_MSG 已删除（「防外发」需求无真实来源，白名单语义与
 *  「只允许黑名单」总则相反）。存量 healing 归因由 classify 指纹表回溯兑底。 */

/** 建议③（检视初轮→delta-r3 数据流判定）：进程替换形态 bash <(curl …)——
 *  fetcher 输出直接进解释器 argv，同属「下载即执行」（不入盘不可审阅）。
 *  delta-r3：数据流判定——只拦「解释器段自带的 <( ) 内是 fetcher」
 *  （bash <(curl) 拦；bash <(echo)|diff <(curl) 放——解释器吃 echo，curl 只是 diff 参数）；
 *  cat <(curl)|bash 漏判面由 pipeToInterpreterHit 的 D4 段内扩形态覆盖。 */
function processSubstitutionHit(command: string): boolean {
  const interpreterRe = /^(?:sudo\s+)?(?:env\s+\S+\s+)?(?:sh|bash|zsh|dash|ksh|python\d?|node|perl|ruby|osascript|source)\b/;
  const fetcherInsideRe = /<\(\s*(?:sudo\s+)?(?:curl|wget)\b/;
  // delta-r3：链内再按 | 拆管道段——解释器段与 <(fetcher) 必须在同一段
  // （bash <(echo)|diff <(curl)：解释器段的替换里是 echo，curl 在 diff 段——放行）
  for (const chain of command.split(/&&|\|\||[;&\n]/)) {
    for (const segRaw of chain.split("|")) {
      const seg = segRaw.trim();
      if (seg && interpreterRe.test(seg) && fetcherInsideRe.test(seg)) return true;
    }
  }
  return false;
}
function pipeToInterpreterHit(command: string): boolean {
  const interpreterRe = /^(?:sudo\s+)?(?:env\s+\S+\s+)?(?:sh|bash|zsh|dash|ksh|python\d?|node|perl|ruby|osascript)\b/;
  // D4（检视 delta-r3）：段首 fetcher 或段内进程替换 fetcher（cat <(curl …) 形态——
  // 替换输出即该段的数据源，管道对端解释器吃到下载内容，与 curl|sh 同构）
  const fetcherRe = /^(?:sudo\s+)?(?:curl|wget)\b|<\(\s*(?:sudo\s+)?(?:curl|wget)\b/;
  // 按管道链拆段（| 单管）；&& / || / ; / & / 换行之间的段互不配对（delta-r2 补 &：
  // 后台复合 curl|head & cat|python3 不跨链配对）
  for (const chain of command.split(/&&|\|\||[;&\n]/)) {
    const parts = chain.split("|").map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    // 链内任一前置段是 fetcher 且任一后续段是解释器 → 命中
    const hasFetcher = parts.slice(0, -1).some(p => fetcherRe.test(p));
    const hasInterpreter = parts.slice(1).some(p => interpreterRe.test(p));
    if (hasFetcher && hasInterpreter) return true;
  }
  return false;
}

/** 第二站主判定 */
/** 第二站黑名单拦截块（F20261102grfix：内联文案常量化+ruleId 直标）。
 *  注：B 类 NETWORK_EXFIL_BLOCK_MSG 已随 F20261109bexfz 退役删除（黑名单剩两类）。 */
const CRED_DIR_BLOCK_MSG: GuardBlock = {
  text: "凭证目录（~/.ssh / ~/.gnupg / ~/.aws）禁止访问——密钥/凭证不进獭上下文。如确需相关操作请告知搭档人工执行。",
  ruleId: "cred_dir_access",
  layer: "bypass_guard",
};
const DOWNLOAD_EXEC_BLOCK_MSG: GuardBlock = {
  text: "检测到「下载即执行」结构（网络命令管道进解释器）——远程脚本直接执行不允许。请先下载落盘、审阅内容后再执行。",
  ruleId: "download_exec",
  layer: "bypass_guard",
};

/** 第二站主判定（F20261109bexfz：B 类外发域名判定退役，剩 A 类凭证路径 + C 类下载即执行）
 *  allowedEgressDomains 参数为退役兼容签名（不再参与判定，静默忽略）。 */
function checkBlacklistStation(command: string, _allowedEgressDomains?: string[]): GuardBlock | null {
  if (credentialPathHit(command)) {
    return CRED_DIR_BLOCK_MSG;
  }
  if (pipeToInterpreterHit(command) || processSubstitutionHit(command)) {
    return DOWNLOAD_EXEC_BLOCK_MSG;
  }
  return null;
}

// ─── 兼容层：旧调用方符号（circuit-breaker-helpers 等） ───

/** v4：sleep 拦截退役（habit 层不再硬拦，wait 工具引导由软约束承担） */
export const SLEEP_REASON_PREFIX = "bash_sleep:";
export function stripSleepMarkerIfPresent(reason: string): string {
  return reason.startsWith(SLEEP_REASON_PREFIX) ? reason.slice(SLEEP_REASON_PREFIX.length) : reason;
}

/** tool_call 门覆盖判定（v4：仅 bash 工具命令） */
export function guardGateCovers(toolName: string | undefined, args: unknown): boolean {
  if (toolName !== "bash") return false;
  const a = args as { command?: unknown } | undefined;
  return typeof a?.command === "string";
}

// ─── 主入口 ───

export function checkBashCommandSafety(
  command: string,
  mainPid: number | null,
  logger?: Logger,
  guardOptions?: GuardOptions,
): GuardBlock | null {
  if (!command.trim()) return null;

  // 第一站：杀进程判定
  const killBlock = checkKillStation(command, mainPid, logger, guardOptions);
  if (killBlock) {
    logger?.warn("[bash-safety-guard] BLOCKED main-process kill (station-1)", { command: command.substring(0, 200) });
    return killBlock;
  }

  // 第二站：黑名单三类
  const blacklistBlock = checkBlacklistStation(command, guardOptions?.allowedEgressDomains);
  if (blacklistBlock) {
    logger?.warn("[bash-safety-guard] BLOCKED blacklist (station-2)", { command: command.substring(0, 200) });
    return blacklistBlock;
  }

  // 放行
  return null;
}
