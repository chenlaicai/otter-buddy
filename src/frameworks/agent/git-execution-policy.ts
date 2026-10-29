/**
 * F20261027gscv：Git 执行域最小授权。
 *
 * 只识别封闭的单段 Git envelope，以及一个字面 `cd <path> && git ...`；
 * 不解释任意 Shell。授权来自真实 `git worktree list` 注册表，未识别命令没有
 * 主仓 .git 写 capability。spawnHook 与沙箱内的有限文本窄门共用本模块。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { allowedFileWriteRoots } from "./file-write-policy";
import { parseOnce, type Segment } from "./command-model";

export type GitWriteDomain =
  | "worktree-gitdir"
  | "objects"
  | "refs-heads"
  | "refs-remotes"
  | "logs-refs"
  | "fetch-head"
  | "orig-head"
  | "packed-refs"
  | "packed-refs-lock"
  | "worktrees-parent"
  | "config-lock";

export interface GitExecutionGrant {
  kind: "status" | "log" | "diff" | "add" | "commit" | "fetch" | "push"
    | "worktree-add" | "worktree-remove" | "worktree-list" | "merge" | "branch-delete";
  repoRoot: string;
  worktreeName?: string;
  /** 仅 worktree add：允许 Git 在声明的目标位置创建新的 .git 指针。 */
  worktreeTarget?: string;
  /** 外部仓隔离 worktree：该命令所需普通工作树写域（stage 文件读取等）。 */
  externalWorktreeRoot?: string;
  domains: GitWriteDomain[];
  injectOptionalLocks: boolean;
}

export interface GitExecutionPolicyOptions {
  repoRoot: string;
  linkedWorktrees?: Map<string, string>;
  /** 外部仓真实 worktree 注册表解析；测试可注入，生产只读 Git 查询。 */
  resolveExternalWorktree?: (targetPath: string) => { repoRoot: string; worktreeRoot: string; worktreeName: string } | null;
}

export type GitExecutionVerdict = GitExecutionGrant | null;

interface GitEnvelope {
  subcmd: string;
  args: string[];
  targetPath?: string;
}

type RepoTarget =
  | { kind: "linked"; worktreeName: string }
  | { kind: "external-linked"; repoRoot: string; worktreeRoot: string; worktreeName: string }
  | { kind: "main-tree" | "management" };

function realpath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

function within(target: string, root: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function validWord(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasNoShellEffects(segment: Segment | undefined): segment is Segment {
  return Boolean(segment && !segment.subshell && segment.redirects.length === 0 &&
    segment.heredocs.length === 0 && segment.assignments.length === 0);
}

function consumeCFlag(
  words: Array<string | null>, index: number, cwd: string, state: { targetPath?: string }, word: string,
): number | null {
  const value = word === "-C" ? words[index + 1] : word.slice(2);
  if (!validWord(value)) return null;
  state.targetPath = isAbsolute(value) ? value : resolve(cwd, value);
  return index + (word === "-C" ? 2 : 1);
}

function consumeConfigFlag(words: Array<string | null>, index: number, word: string): number | null {
  const value = word === "-c" ? words[index + 1] : word.slice(2);
  return validWord(value) && safeConfig(value) ? index + (word === "-c" ? 2 : 1) : null;
}

/** 只放行 commit 身份配置，避免 alias/hooks 配置把授权变成另一段程序。 */
function safeConfig(value: string): boolean {
  return /^user\.(?:name|email)=/i.test(value);
}

/** 返回下一个 argv 索引；null 表示不属于封闭 envelope。 */
function consumeGlobalFlag(
  words: Array<string | null>, index: number, cwd: string, state: { targetPath?: string },
): number | null {
  const word = words[index];
  if (!validWord(word)) return null;
  if (word === "-C" || (word.startsWith("-C") && word.length > 2)) {
    return consumeCFlag(words, index, cwd, state, word);
  }
  if (word === "-c" || (word.startsWith("-c") && word.length > 2)) {
    return consumeConfigFlag(words, index, word);
  }
  return null; // --git-dir/--work-tree/未知全局旗标均不授权
}

/** 从一个已词法化的 git 段提取封闭 envelope；不重建 argv 字符串。 */
function parseGitSegment(segment: Segment | undefined, cwd: string): GitEnvelope | null {
  if (!segment || segment.argv0 !== "git" || !hasNoShellEffects(segment)) return null;
  const words = segment.words.map(word => word.evaluated);
  const state: { targetPath?: string } = {};
  let i = 1;
  while (i < words.length && words[i]?.startsWith("-")) {
    const next = consumeGlobalFlag(words, i, cwd, state);
    if (next === null) return null;
    i = next;
  }
  const subcmd = words[i];
  if (!validWord(subcmd)) return null;
  const rest = words.slice(i + 1);
  if (rest.some(word => word === null)) return null;
  return { subcmd, args: rest as string[], targetPath: state.targetPath };
}

/** 解析字面 cd && git；其他复合命令一律无授权。 */
function parseCdAndGit(segments: Segment[], cwd: string): GitEnvelope | null {
  if (segments.length !== 2 || segments[1].joiner !== "&&") return null;
  const [cd, git] = segments;
  if (cd.argv0 !== "cd" || !hasNoShellEffects(cd) || cd.words.length !== 2) return null;
  const destination = cd.words[1]?.evaluated;
  if (!validWord(destination)) return null;
  const effectiveCwd = isAbsolute(destination) ? destination : resolve(cwd, destination);
  const envelope = parseGitSegment(git, effectiveCwd);
  return envelope ? { ...envelope, targetPath: envelope.targetPath ?? effectiveCwd } : null;
}

/** 单 git，或一个字面 cd && git；cd 目标作为随后 git 的真实 cwd。 */
function parseEnvelope(command: string, cwd: string): GitEnvelope | null {
  const model = parseOnce(command);
  if (!model.parseOk || model.payloads.length > 0 || model.segments.length === 0) return null;
  return model.segments.length === 1
    ? parseGitSegment(model.segments[0], cwd)
    : parseCdAndGit(model.segments, cwd);
}

function metadataName(worktreeRoot: string): string {
  // worktree 目录名并不保证等于 .git/worktrees/<id>（rename/历史命名）。
  // 优先读 .git 指针的真实 gitdir；不可读才退回目录名（测试 mock 兼容）。
  try {
    const pointer = readFileSync(resolve(worktreeRoot, ".git"), "utf8").trim();
    const match = /^gitdir:\s*(.+)$/.exec(pointer);
    if (match) return basename(realpath(match[1]));
  } catch { /* fallback below */ }
  return basename(worktreeRoot);
}

/** 真实注册表。使用 -z 避免带空格/特殊字符路径的 porcelain 引号歧义。 */
export function parseGitWorktreeList(repoRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    // Why: -z 每个字段以 NUL 结尾。绝不能把路径内换行当记录分隔符，
    // 否则外部仓注册表中的换行路径可注入伪造 worktree 行。
    for (const field of out.split("\0")) {
      if (!field.startsWith("worktree ")) continue;
      const root = field.slice("worktree ".length);
      // eslint-disable-next-line no-control-regex -- 外部注册表控制字符必须 fail-closed
      if (/[\x00-\x1f\x7f]/.test(root)) continue;
      const normalized = realpath(root);
      if (normalized !== realpath(repoRoot)) map.set(normalized, metadataName(root));
    }
  } catch {
    // 注册表不可知 = 无 linked worktree 授权；默认 deny 仍保留。
  }
  return map;
}

function linkedAt(path: string, registry: Map<string, string>): string | undefined {
  const normalized = realpath(path);
  for (const [root, name] of registry) {
    if (within(normalized, root)) return name;
  }
  return undefined;
}

/**
 * #1682：只承认真实 Git 注册表中的外部隔离 worktree。
 * 探测目标向上至仓库根，再读取该仓 `git worktree list`；同时要求目标是其
 * `.otter/worktrees/` 的直接子目录，排除主目录、普通目录与伪造 .git 文件夹。
 */
export function resolveExternalGitWorktree(targetPath: string): { repoRoot: string; worktreeRoot: string; worktreeName: string } | null {
  const target = realpath(targetPath);
  try {
    const commonDir = realpath(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: target, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim());
    const repoRoot = dirname(commonDir);
    if (dirname(target) !== realpath(resolve(repoRoot, ".otter/worktrees"))) return null;
    for (const [root, worktreeName] of parseGitWorktreeList(repoRoot)) {
      if (root === target) return { repoRoot, worktreeRoot: root, worktreeName };
    }
  } catch {
    // 目标不存在、不是 Git worktree 或注册表不可读：均无授权。
  }
  return null;
}

function resolveTarget(
  targetPath: string | undefined, cwd: string, repoRoot: string, registry: Map<string, string>,
  resolveExternal: GitExecutionPolicyOptions["resolveExternalWorktree"],
): RepoTarget | null {
  const target = realpath(targetPath ?? cwd);
  const linked = linkedAt(target, registry);
  if (linked) return { kind: "linked", worktreeName: linked };
  const repo = realpath(repoRoot);
  const gitDir = resolve(repo, ".git");
  if (within(target, gitDir)) return { kind: "management" };
  if (within(target, repo)) return { kind: "main-tree" };
  const external = (resolveExternal ?? resolveExternalGitWorktree)(target);
  return external ? { kind: "external-linked", ...external } : null;
}

function grant(
  kind: GitExecutionGrant["kind"], repoRoot: string, target: RepoTarget,
  domains: GitWriteDomain[], injectOptionalLocks = false,
): GitExecutionGrant {
  return {
    kind, repoRoot: target.kind === "external-linked" ? target.repoRoot : repoRoot,
    domains, injectOptionalLocks,
    ...(target.kind === "linked" || target.kind === "external-linked" ? { worktreeName: target.worktreeName } : {}),
    ...(target.kind === "external-linked" ? { externalWorktreeRoot: target.worktreeRoot } : {}),
  };
}

const READ_DOMAINS: GitWriteDomain[] = [];
const INDEX_DOMAINS: GitWriteDomain[] = ["worktree-gitdir", "objects"];
const COMMIT_DOMAINS: GitWriteDomain[] = [...INDEX_DOMAINS, "refs-heads", "logs-refs", "packed-refs-lock"];
const FETCH_DOMAINS: GitWriteDomain[] = ["objects", "refs-remotes", "logs-refs", "fetch-head", "packed-refs-lock"];
const PUSH_DOMAINS: GitWriteDomain[] = ["objects", "refs-remotes", "logs-refs", "packed-refs-lock"];
const WORKTREE_DOMAINS: GitWriteDomain[] = ["worktrees-parent", "objects", "refs-heads", "packed-refs-lock", "logs-refs", "config-lock"];

function evaluateReadOnly(subcmd: string, args: string[], repoRoot: string, target: RepoTarget): GitExecutionGrant | null {
  const readOnly = subcmd === "status" || subcmd === "log" || subcmd === "diff" ||
    (subcmd === "worktree" && args[0] === "list");
  return readOnly
    ? grant(subcmd === "worktree" ? "worktree-list" : subcmd as "status" | "log" | "diff", repoRoot, target, READ_DOMAINS, true)
    : null;
}

function evaluateTreeWrite(subcmd: string, repoRoot: string, target: RepoTarget): GitExecutionGrant | null {
  if (subcmd !== "add" && subcmd !== "commit" && subcmd !== "merge") return null;
  if (target.kind !== "linked" && target.kind !== "external-linked") return null;
  const domains = subcmd === "add" ? INDEX_DOMAINS
    : subcmd === "commit" ? COMMIT_DOMAINS : [...COMMIT_DOMAINS, "orig-head" as const];
  return grant(subcmd, repoRoot, target, domains);
}

/** worktree add 受控旗标：值旗标 -b/-B；开关旗标 detach/no-checkout/force/quiet。其余旗标（--lock 等）不授权。 */
const WORKTREE_ADD_VALUE_FLAGS = new Set(["-b", "-B"]);
const WORKTREE_ADD_BOOL_FLAGS = new Set(["--detach", "--no-checkout", "-f", "--force", "--quiet", "-q"]);
/** worktree remove 受控旗标（任意位置）：-f/--force/-q/--quiet。 */
const WORKTREE_REMOVE_FLAGS = new Set(["-f", "--force", "-q", "--quiet"]);

/**
 * worktree add 位置参数解析：旗标与位置参数可混排（对齐 git parse-options 语义），
 * 位置参数 = <target> [<commit-ish>]，目标必须是第一个位置参数；未知旗标/多余位置参数不授权。
 */
function parseWorktreeAddTarget(args: string[]): string | null {
  let target: string | null = null;
  let positionals = 0;
  for (let i = 1; i < args.length; i++) {
    const word = args[i];
    if (!validWord(word)) return null;
    if (word.startsWith("-")) {
      if (WORKTREE_ADD_VALUE_FLAGS.has(word)) {
        i += 1;
        if (i >= args.length || !validWord(args[i])) return null;
      } else if (!WORKTREE_ADD_BOOL_FLAGS.has(word)) return null;
      continue;
    }
    positionals += 1;
    if (positionals === 1) target = word;
  }
  return positionals >= 1 && positionals <= 2 ? target : null;
}

/** worktree remove 参数解析：旗标任意位置，恰好一个目标。 */
function parseWorktreeRemoveTarget(args: string[]): string | null {
  let target: string | null = null;
  for (let i = 1; i < args.length; i++) {
    const word = args[i];
    if (!validWord(word)) return null;
    if (word.startsWith("-")) {
      if (!WORKTREE_REMOVE_FLAGS.has(word)) return null;
      continue;
    }
    if (target !== null) return null;
    target = word;
  }
  return target;
}

/**
 * 目标路径解析：相对路径按 git 语义解析——即 git 进程的有效 cwd（-C/cd 目标目录），
 * 而非宿主 bash 工具的进程 cwd（两者不一致曾致常用形态拿不到授权，2026-10-28 实证）。
 */
function resolveWorktreePath(target: string, evalCwd: string): string {
  return realpath(isAbsolute(target) ? target : resolve(evalCwd, target));
}

function parseWorktreeTarget(target: string, evalCwd: string, repoRoot: string): string | null {
  const canonical = resolveWorktreePath(target, evalCwd);
  const parent = realpath(dirname(canonical));
  const worktreeRoot = allowedFileWriteRoots({ repoRoot, dataDir: resolve(repoRoot, "data") }).roots.find(root => root.region === "worktrees")?.path;
  return worktreeRoot && parent === worktreeRoot ? canonical : null;
}

function evaluateWorktreeWrite(args: string[], repoRoot: string, target: RepoTarget, evalCwd: string): GitExecutionGrant | null {
  if (args[0] === "add") {
    const parsed = parseWorktreeAddTarget(args);
    const worktreeTarget = parsed ? parseWorktreeTarget(parsed, evalCwd, repoRoot) : null;
    return worktreeTarget ? { ...grant("worktree-add", repoRoot, target, WORKTREE_DOMAINS), worktreeTarget } : null;
  }
  if (args[0] === "prune") return grant("worktree-remove", repoRoot, target, WORKTREE_DOMAINS);
  if (args[0] !== "remove") return null;
  const targetPath = parseWorktreeRemoveTarget(args);
  if (!targetPath) return null;
  const worktreeTarget = resolveWorktreePath(targetPath, evalCwd);
  if (dirname(worktreeTarget) !== realpath(resolve(repoRoot, ".otter/worktrees"))) return null;
  return { ...grant("worktree-remove", repoRoot, target, WORKTREE_DOMAINS), worktreeTarget };
}

function evaluateManagementWrite(envelope: GitEnvelope, repoRoot: string, target: RepoTarget, evalCwd: string): GitExecutionGrant | null {
  // #1682 只授权外部已登记 worktree 的 add/commit；管理写面保持原拒绝边界。
  if (target.kind === "external-linked") return null;
  const { subcmd, args } = envelope;
  if (subcmd === "fetch") {
    const domains = [...(target.kind === "linked" ? ["worktree-gitdir" as const] : []), ...FETCH_DOMAINS];
    return grant("fetch", repoRoot, target, domains);
  }
  if (subcmd === "push") return grant("push", repoRoot, target, PUSH_DOMAINS);
  if (subcmd === "worktree") return evaluateWorktreeWrite(args, repoRoot, target, evalCwd);
  if (subcmd === "branch" && args.includes("-d") && !args.includes("-D")) {
    return grant("branch-delete", repoRoot, target, ["refs-heads", "logs-refs", "packed-refs-lock"]);
  }
  return null;
}

function evaluateSubcommand(
  envelope: GitEnvelope, repoRoot: string, target: RepoTarget, evalCwd: string,
): GitExecutionGrant | null {
  return evaluateReadOnly(envelope.subcmd, envelope.args, repoRoot, target)
    ?? evaluateTreeWrite(envelope.subcmd, repoRoot, target)
    ?? evaluateManagementWrite(envelope, repoRoot, target, evalCwd);
}

export function evaluateGitExecution(
  command: string, cwd: string, opts: GitExecutionPolicyOptions,
): GitExecutionVerdict {
  const envelope = parseEnvelope(command, cwd);
  if (!envelope) return null;
  const repoRoot = realpath(opts.repoRoot);
  const target = resolveTarget(
    envelope.targetPath, cwd, repoRoot, opts.linkedWorktrees ?? new Map(), opts.resolveExternalWorktree,
  );
  // git 语义：-C/cd 之后的相对参数按该目录解析，而非宿主进程 cwd（2026-10-28 实证两者不一致曾致授权丢失）。
  if (!target) return null;
  const verdict = evaluateSubcommand(envelope, repoRoot, target, envelope.targetPath ?? cwd);
  // S1 收口：grant 路径含白名单外字符时不授权（fail-closed → 默认 deny profile）。
  if (verdict && !grantPathsSafe(verdict)) return null;
  return verdict;
}

/** 校验 grant 中所有路径字段是否通过 SBPL 白名单（S1 防注入）。 */
function grantPathsSafe(grant: GitExecutionGrant): boolean {
  return isSafeProfilePath(grant.repoRoot)
    && (grant.worktreeName === undefined || isSafeProfilePath(grant.worktreeName))
    && (grant.worktreeTarget === undefined || isSafeProfilePath(grant.worktreeTarget))
    && (grant.externalWorktreeRoot === undefined || isSafeProfilePath(grant.externalWorktreeRoot));
}

/**
 * SBPL profile 路径白名单（S1 收口）：路径内容只允许 [A-Za-z0-9._/-]。
 * 反引号/`$` 可经外层 bash 命令替换逃出沙箱（检视 S1 实证），`"` 破坏 SBPL
 * 字符串语法（检视 A1），`\` 双层转义语义脆弱——一律在授权入口拒绝
 * （fail-closed，不生成规则）。白名单外字符（空格/中文等）拿不到窄域授权。
 */
const SAFE_PROFILE_PATH = /^[A-Za-z0-9._/-]+$/;

function isSafeProfilePath(path: string): boolean {
  return SAFE_PROFILE_PATH.test(path);
}

export function escapePath(path: string): string {
  // SBPL 单行 profile 不允许控制字符；拒绝而不是生成多行 profile。
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) throw new Error("Git profile path contains control characters");
  if (!isSafeProfilePath(path)) throw new Error("Git profile path contains unsafe characters (whitelist: A-Za-z0-9._/-)");
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * SBPL regex 字面量（ICU 语法）中的路径转义：转义正则元字符防扩大匹配面。
 * `.git` 窄写域一律用 regex 形态而非 literal/subpath——2026-10-28 语义实证：
 * regex-deny 之后的路径形态 allow 对**删除类操作（unlink/rmdir）无效**（创建类有效），
 * 同一形态的 regex allow 创建/删除双通（sbx-lab3 判别实验）。故 .git 窄域用 regex 形态
 * 锚定全路径（^…），既压过通用 `.git` regex deny，又不扩大到其他仓的 .git。
 */
function escapeRegexPath(path: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) throw new Error("Git profile path contains control characters");
  if (!isSafeProfilePath(path)) throw new Error("Git profile path contains unsafe characters (whitelist: A-Za-z0-9._/-)");
  return path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function worktreeTargetRules(grant: GitExecutionGrant): string[] {
  if (!grant.worktreeTarget) return [];
  const rules: string[] = [];
  const repoRoot = realpath(grant.repoRoot);
  let parent = dirname(grant.worktreeTarget);
  while (within(parent, repoRoot) && parent !== "/") {
    rules.push(`(allow file-write* (literal "${escapePath(parent)}"))`);
    if (parent === repoRoot) break;
    parent = dirname(parent);
  }
  // 目标树与父链：面向主仓 subpath deny（路径 vs 路径，后写胜出，创建/删除双通）。
  rules.push(
    `(allow file-write* (literal "${escapePath(grant.worktreeTarget)}") (subpath "${escapePath(grant.worktreeTarget)}"))`,
  );
  // .git 指针：regex 形态（压过通用 .git regex deny 的删除面），锚定全路径防误开。
  rules.push(`(allow file-write* (regex #"^${escapeRegexPath(grant.worktreeTarget)}/\\.git$"))`);
  return rules;
}

export function grantToProfileRules(grant: GitExecutionGrant): string[] {
  // 窄写域用 regex 形态（见 escapeRegexPath 注释的语义实证）；^ 锚定 + 全路径字面防扩大。
  const gitDir = `${escapeRegexPath(grant.repoRoot)}/\\.git`;
  const re = (pattern: string) => `(allow file-write* (regex #"^${pattern}"))`;
  return grant.domains.map(domain => {
    if (domain === "worktree-gitdir") return re(`${gitDir}/worktrees/${escapeRegexPath(grant.worktreeName ?? "")}(/|$)`);
    if (domain === "objects") return re(`${gitDir}/objects(/|$)`);
    if (domain === "refs-heads") return re(`${gitDir}/refs/heads(/|$)`);
    if (domain === "refs-remotes") return re(`${gitDir}/refs/remotes(/|$)`);
    if (domain === "logs-refs") return re(`${gitDir}/logs(/|$)`);
    if (domain === "worktrees-parent") {
      return [re(`${gitDir}/worktrees(/|$)`), ...worktreeTargetRules(grant)].join(" ");
    }
    if (domain === "config-lock") return re(`${gitDir}/config\\.lock$`);
    if (domain === "packed-refs-lock") return re(`${gitDir}/packed-refs(\\.lock)?$`);
    const file = domain === "fetch-head" ? "FETCH_HEAD" : domain === "orig-head" ? "ORIG_HEAD" : "packed-refs";
    return re(`${gitDir}/${file}$`);
  });
}

export function grantFingerprint(grant: GitExecutionGrant): string {
  return JSON.stringify([grant.repoRoot, grant.worktreeName ?? null, grant.worktreeTarget ?? null, grant.externalWorktreeRoot ?? null, [...grant.domains].sort()]);
}
