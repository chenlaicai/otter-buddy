/**
 * F20261015phys：bash 物理沙箱——sandbox-exec 包裹獭 bash 执行面。
 *
 * 设计要点：
 * - 守卫收敛（F20261015gsub）后绕过面由 OS 层硬边界兜底：主仓只读 + 进程信号隔离
 * - 注入点：pi-coding-agent SDK 的 baseToolsOverride + createBashTool({ spawnHook })，
 *   spawnHook 在每条 bash 命令执行前改写 command，裹上 sandbox-exec profile
 * - profile 路径必须 realpath 解析（实证坑：macOS /tmp 是 /private/tmp 符号链接，
 *   profile 写 /tmp 不拦，写 /private/tmp 才拦）
 * - profile 必须单行空格分隔（实证坑：多行 profile 经 JSON.stringify 后 \n 变字面两字符，
 *   SBPL 解析器报 unbound variable 崩溃）
 * - 命令必须转义 $ 和反引号（实证坑：JSON.stringify 不转义这两个字符，
 *   外层无沙箱 bash 会先做命令替换——沙箱被完全绕过）
 * - 进程隔离用 (deny signal) 不用 (deny process*)——后者连 sandbox-exec 自身
 *   exec 内层 bash 都拦（exit 71），deny signal 只拦信号发送不影响进程执行
 * - 非 macOS 平台降级为 no-op（spawnHook 原样透传），语义等价于无沙箱
 * - 环境变量 OTTER_BASH_SANDBOX=off 显式禁用（调试/排障逃生口）
 *
 * 白名单边界（可写路径）：
 * - data/workspaces/  —— 獭会话工作区
 * - .otter/worktrees/ —— 獭开发 worktree
 * - .otter/workforms/ —— 獭运行时自治区（F20261016gsbx G2 对表：与 worktrees 同性质、
 *                       口径应齐——此前在 OTTER_RUNTIME_REGIONS（write-target-evaluator）
 *                       但漏在本白名单，沙箱侧误拦反例）
 * - 真实 `.git/` 默认不写；write/edit 也不得把 Git 元数据当普通文件修改。
 *   由 spawnHook 给直接、已注册 worktree 工作流按次授最小 Git 写域。
 * - ~/.otter/alpha/   —— alpha 隔离实例数据根
 * - $TMPDIR / /tmp    —— 临时文件
 * 其余主仓路径全部 deny file-write*（只读）。
 *
 * F20261027gscv Phase 2（Git 执行域最小授权）：默认 profile 不再 allow `.git/` 整树——
 * Git 写能力由 spawnHook 按整命令 envelope 派生最小写域 profile（git-execution-policy.ts），
 * 未识别的复杂 Shell 走默认 deny。正道 worktree add/commit/fetch/push 经白名单 envelope
 * 授窄路径（worktrees/<wt>/ + objects/ + refs/...），比对整个 .git 常开更小且可验证。
 *
 * SBPL 规则优先级：顺序覆盖语义（后写胜出）——白名单 allow 写在 deny 之后才生效。
 * （检视发现 7 订正：「deny 优先级高于 allow」是错误心智模型，若真如此后写的 allow 不生效）
 */

import { platform } from "node:os";
import type { BashSpawnContext, BashSpawnHook } from "@earendil-works/pi-coding-agent";
import { createBashTool, createFindTool, createGrepTool, createLsTool, createReadTool } from "@earendil-works/pi-coding-agent";
import { assertGuardedFileToolsAssembled, createGuardedFileTools } from "./file-tool-guard";
import { allowedFileWriteRoots, createFileWritePolicy } from "./file-write-policy";
import { evaluateGitExecution, grantToProfileRules, grantFingerprint, parseGitWorktreeList } from "./git-execution-policy";
import type { GitExecutionGrant } from "./git-execution-policy";
import { otterInvokeStorage } from "./model-runtime-registry";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/** sandbox-exec profile 缓存——同一进程内 profile 不变（路径在启动时确定）。
 *  F20261027gscv Phase 2：缓存 key 扩展为授权指纹——默认 profile 与 Git envelope
 *  profile 分开缓存，同一授权语义复用同一 profile 字符串，不同授权不串权。 */
let cachedProfile: string | null = null;
let cachedProfileKey: string | null = null;
const cachedGitProfiles = new Map<string, string>();

/**
 * 转义命令字符串——防止外层无沙箱 bash 的命令替换逃逸。
 *
 * SDK 执行链：spawn(bash, ["-c", wrapped])——wrapped 会被外层 bash 再解析一遍。
 * JSON.stringify 只转义 " 和 \，不转义 $ 和 `——bash 双引号内 $() 与 ` 活跃，
 * 命令替换先于 sandbox-exec 启动、在无沙箱外层执行（检视发现 2 实测）。
 *
 * 修复：在 JSON.stringify 结果内追加 \$ 和 \` 转义——
 * 外层 bash 看到 \$ 产字面 $（不触发命令替换），内层沙箱 bash 同样看到 \$ 产字面 $。
 * 原命令的 $ 变量展开/命令替换在内层沙箱 bash 中失效——这是可接受的：
 * 沙箱内 $ 语义由 profile 控制，不需要外层展开。
 */
function escapeCommand(command: string): string {
  return JSON.stringify(command).replace(/\$/g, "\\$").replace(/`/g, "\\`");
}

/**
 * 构建 sandbox-exec profile（单行空格分隔——多行经 JSON.stringify 后 \n 变字面两字符，
 * SBPL 解析器报 unbound variable: \n 崩溃，检视发现 1 实测）。
 *
 * @param repoRoot 主仓根目录（getRepoRoot()）
 * @param dataDir  主仓 data/ 目录绝对路径
 * @returns sandbox-exec profile 字符串（单行）
 */
export function buildSandboxProfile(repoRoot: string, dataDir: string): string {
  return buildDefaultProfile(repoRoot, dataDir);
}

/**
 * 构建默认 sandbox-exec profile（单行空格分隔）。
 *
 * F20261027gscv Phase 2：默认 profile 不再包含 `.git/` 整树 allow——
 * Git 写能力由 spawnHook 按 envelope 派生（buildGitProfile），未识别命令走本默认。
 *
 * @param repoRoot 主仓根目录（getRepoRoot()）
 * @param dataDir  主仓 data/ 目录绝对路径
 * @returns sandbox-exec profile 字符串（单行）
 */
function buildDefaultProfile(repoRoot: string, dataDir: string): string {
  // repo/data 已包含派生路径；home/tmp 固定由进程环境决定。
  const key = ["default", repoRoot, dataDir].join("|");
  if (cachedProfile && cachedProfileKey === key) return cachedProfile;
  const profile = buildBaseProfile(repoRoot, dataDir).join(" ");
  cachedProfile = profile;
  cachedProfileKey = key;
  return profile;
}

/** 稳定写区由 file-write-policy 统一派生；Git 元数据在允许区覆盖之后再拒绝。 */
function buildBaseProfile(repoRoot: string, dataDir: string): string[] {
  const { repoRoot: repo, roots } = allowedFileWriteRoots({ repoRoot, dataDir });
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-write* (subpath "${repo}"))`,
    ...roots.map(({ path }) => `(allow file-write* (subpath "${path}"))`),
    // 真实 .git 也可能落在 alpha/tmp 等通用写区，不能只 deny 主仓那一棵。
    // 固定组件形态覆盖 gitdir 子路径与 worktree .git 指针，不匹配 .gitignore/.github。
    '(deny file-write* (regex #"/\\.git/"))',
    "(deny signal)",
  ];
}

/**
 * 构建 Git envelope 授权 profile——在默认白名单基础上叠加 Git 窄写域。
 *
 * @param repoRoot 主仓根目录
 * @param dataDir  主仓 data/ 目录绝对路径
 * @param grant    Git 授权（git-execution-policy evaluateGitExecution 返回）
 * @returns sandbox-exec profile 字符串（单行）
 */
function buildGitProfile(repoRoot: string, dataDir: string, grant: GitExecutionGrant): string {
  const fp = JSON.stringify([repoRoot, dataDir, grantFingerprint(grant)]);
  const cached = cachedGitProfiles.get(fp);
  if (cached) return cached;

  const profile = [
    ...buildBaseProfile(repoRoot, dataDir),
    // Git 窄写域——deny 之后追加 allow，SBPL 顺序覆盖语义生效
    ...grantToProfileRules(grant),
  ].join(" ");

  cachedGitProfiles.set(fp, profile);
  return profile;
}

/**
 * 判断当前环境是否启用 bash 沙箱。
 * - 非 macOS → 禁用（sandbox-exec 是 macOS 专属）
 * - OTTER_BASH_SANDBOX=off → 显式禁用
 */
export function isSandboxEnabled(): boolean {
  if (platform() !== "darwin") return false;
  if (process.env.OTTER_BASH_SANDBOX === "off") return false;
  return true;
}

/**
 * 2a 沙箱可用性探测（F20261016gsbx，R-2b 约束）：与 spawnHook 挂载判定同一真相源——
 * 平台 macOS 且 OTTER_BASH_SANDBOX≠off 且 profile 注入成功（buildSandboxProfile 不抛）。
 * 不缓存：每次调用现求值（env 变更即失效）；profile 本体仍按 key 缓存。
 * 消费方必须用本函数或 createSandboxedTools 返回的挂载决策——自行再探测会产生
 * 「探测报可用但挂钩未挂载=命令裸跑零告警」的最危险模式（R-2b）。
 */
export function probeSandboxAvailability(repoRoot: string, dataDir: string): boolean {
  if (!isSandboxEnabled()) return false;
  try {
    buildSandboxProfile(repoRoot, dataDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * R-2 失败引导文案（F20261016gsbx）：LLM 无路径解析能力，指引靠正道文案。
 * 实测归档（scratch-sbx-msg 实验）：SBPL (deny … (with message …)) 语法合法但消息
 * 进系统日志不进 stderr——LLM 唯一可见面是命令 stderr，故引导只能在包裹层出。
 * 仅失败时追加一行（成功零噪音）：拒写（Operation not permitted）→ 指引 worktree/
 * 对话工作区正道；exit 65 → 附条件措辞（R-2b 实测：65 与 diff(1) 等内层退出码混淆，
 * 不得单凭 65 判定沙箱失效）。 */
const FAILURE_GUIDANCE_SUFFIX = `; _sb=$?; if [ "$_sb" -ne 0 ]; then if [ "$_sb" -eq 65 ]; then echo "[bash-sandbox] exit 65：若非内层命令自身语义（diff(1) 同码），可能是沙箱 profile 解析异常——请报告服务异常，勿重试" >&2; else echo "[bash-sandbox] 命令失败（exit $_sb）。若见 Operation not permitted：落点在沙箱只读域（主仓/宿主目录 OS 级拒写）——写文件请用 worktree（.otter/worktrees/）或对话工作区（data/workspaces/）；写主仓走 PR" >&2; fi; fi; exit "$_sb"`;

/**
 * 构建 sandbox spawnHook——每条 bash 命令执行前改写 command，裹上 sandbox-exec。
 *
 * 包裹语义：`sandbox-exec -p '<profile>' /bin/bash -c '<原命令>'`
 * - profile 单行空格分隔（JSON.stringify 转义后 SBPL 可解析）
 * - 原命令通过 escapeCommand 转义（JSON.stringify + \$ + \`），防外层 bash 命令替换逃逸
 * - sandbox-exec 是 OS 层拦截，进程内无法逃逸——獭无法在 bash 内脱掉沙箱
 * - spawnHook 由 SDK 在每次 execute 时调用，獭无法跳过
 */
export function createSandboxSpawnHook(
  repoRoot: string,
  dataDir: string,
  options?: { linkedWorktrees?: Map<string, string> },
): BashSpawnHook {
  const defaultProfile = buildDefaultProfile(repoRoot, dataDir);
  // F20261027gscv Phase 2：linked worktree 清单支持显式注入（测试固定场景）
  // 或从 git worktree list --porcelain 派生（生产默认，每次 spawnHook 现解析保证新鲜）。
  const useFixedRegistry = options?.linkedWorktrees !== undefined;
  const fixedRegistry = options?.linkedWorktrees ?? null;

  return (ctx: BashSpawnContext): BashSpawnContext => {
    // F20261027gscv Phase 2：Git envelope 识别——命中则派生最小写域 profile。
    // registry 每次现解析（git worktree list 同步执行 ~10ms，Git 命令本身更慢），
    // 保证 worktree add 后立即可见——spawnHook 在命令执行前运行，无法事后刷新。
    const currentRegistry = useFixedRegistry ? fixedRegistry! : parseGitWorktreeList(repoRoot);
    const grant = evaluateGitExecution(ctx.command, ctx.cwd ?? "", {
      repoRoot,
      linkedWorktrees: currentRegistry,
    });
    const profile = grant ? buildGitProfile(repoRoot, dataDir, grant) : defaultProfile;
    // Git 只读命令注入 GIT_OPTIONAL_LOCKS=0，避免 status 因 index.lock 写失败
    const env = grant?.injectOptionalLocks
      ? { ...(ctx.env ?? {}), GIT_OPTIONAL_LOCKS: "0" }
      : ctx.env;
    return {
      ...ctx,
      env,
      // R-2 失败引导在包裹层（FAILURE_GUIDANCE_SUFFIX）——见其注释的实测依据
      command: `sandbox-exec -p ${JSON.stringify(profile)} /bin/bash -c ${escapeCommand(ctx.command)}${FAILURE_GUIDANCE_SUFFIX}`,
    };
  };
}

/** createSandboxedTools 返回值：工具集 + spawnHook 真实挂载决策（R-2b 同点求值——
 *  消费方（守卫退役开关）必须用 sandboxGuarded 本值，禁止另行探测）。 */
export interface SandboxedToolsResult {
  tools: Record<string, AgentTool>;
  sandboxGuarded: boolean;
}

/**
 * 创建沙箱包裹的完整工具集（read/write/edit/bash/grep/find/ls）。
 *
 * bash 工具用 spawnHook 裹 sandbox-exec；write/edit 走结构化接防（F20261027gscv
 * Phase 1）：guarded operations 在真实副作用前校验写区，与 bash 沙箱独立——
 * sg=false 下 write/edit 同样接防（structured 层），`sandboxGuarded` 仍只代表
 * bash 物理状态。
 *
 * 不用 SDK createAllTools（顶层未导出）——逐工具构建，语义等价。
 *
 * 已知取舍：baseToolsOverride 丢弃 SDK settings 透传（read 的 autoResizeImages、
 * bash 的 shellPath/commandPrefix）——当前项目未使用这些 settings（grep 无果），
 * 实际影响为零；若未来需要，从 settingsManager 透传（检视发现 6）。
 *
 * @param cwd 会话工作目录（对话工作区）
 * @param repoRoot 主仓根目录
 * @param dataDir 主仓 data/ 目录绝对路径
 * @returns 完整工具集（可直接传入 createAgentSession 的 baseToolsOverride）
 */
export function createSandboxedTools(cwd: string, repoRoot: string, dataDir: string): SandboxedToolsResult {
  // F20261027gscv Phase 1：write/edit 接防（structured 层，独立于 bash 沙箱）。
  // 复用 invoke 级 guardOnIntercept；无 invoke 上下文的独立测试不伪造生产落账。
  const policy = createFileWritePolicy({ repoRoot, dataDir });
  const guarded = createGuardedFileTools(cwd, {
    repoRoot,
    dataDir,
    policy,
    getInvokeContext: () => otterInvokeStorage.getStore(),
  });
  // 构造期断言（设计 §7 Phase 1）：guard 未生效时拒绝静默装配，fail-closed
  assertGuardedFileToolsAssembled(guarded, policy);
  const base = {
    read: createReadTool(cwd),
    write: guarded.write,
    edit: guarded.edit,
    grep: createGrepTool(cwd),
    find: createFindTool(cwd),
    ls: createLsTool(cwd),
  };
  // 2a（R-2b）：挂载判定与可用性探测同函数同瞬求值——挂载与否与 sandboxGuarded 报告
  // 不可能分歧（同一次 probeSandboxAvailability 结果决定两面）。
  const sandboxGuarded = probeSandboxAvailability(repoRoot, dataDir);
  if (!sandboxGuarded) {
    // 非 macOS / 显式禁用 / profile 构建失败——bash 无沙箱，有限守卫回位（Best Effort，非物理等价）
    return { tools: { ...base, bash: createBashTool(cwd) }, sandboxGuarded: false };
  }
  const spawnHook = createSandboxSpawnHook(repoRoot, dataDir);
  return { tools: { ...base, bash: createBashTool(cwd, { spawnHook }) }, sandboxGuarded: true };
}
