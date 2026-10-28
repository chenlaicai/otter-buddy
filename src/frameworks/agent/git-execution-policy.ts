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
  domains: GitWriteDomain[];
  injectOptionalLocks: boolean;
}

export interface GitExecutionPolicyOptions {
  repoRoot: string;
  linkedWorktrees?: Map<string, string>;
}

export type GitExecutionVerdict = GitExecutionGrant | null;

interface GitEnvelope {
  subcmd: string;
  args: string[];
  targetPath?: string;
}

type RepoTarget =
  | { kind: "linked"; worktreeName: string }
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
    for (const record of out.split("\0")) {
      const first = record.split("\n", 1)[0];
      if (!first.startsWith("worktree ")) continue;
      const root = first.slice("worktree ".length);
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

function resolveTarget(
  targetPath: string | undefined, cwd: string, repoRoot: string, registry: Map<string, string>,
): RepoTarget | null {
  const target = realpath(targetPath ?? cwd);
  const linked = linkedAt(target, registry);
  if (linked) return { kind: "linked", worktreeName: linked };
  const repo = realpath(repoRoot);
  const gitDir = resolve(repo, ".git");
  if (within(target, gitDir)) return { kind: "management" };
  if (within(target, repo)) return { kind: "main-tree" };
  return null; // 外部独立仓不由本项目的 Git 写域授权
}

function grant(
  kind: GitExecutionGrant["kind"], repoRoot: string, target: RepoTarget,
  domains: GitWriteDomain[], injectOptionalLocks = false,
): GitExecutionGrant {
  return {
    kind, repoRoot, domains, injectOptionalLocks,
    ...(target.kind === "linked" ? { worktreeName: target.worktreeName } : {}),
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
  if (target.kind !== "linked") return null;
  const domains = subcmd === "add" ? INDEX_DOMAINS
    : subcmd === "commit" ? COMMIT_DOMAINS : [...COMMIT_DOMAINS, "orig-head" as const];
  return grant(subcmd, repoRoot, target, domains);
}

function worktreeTargetPosition(args: string[]): number {
  const noValue = new Set(["--detach", "--no-checkout", "-f", "--force", "--quiet", "-q"]);
  let position = 1;
  while (position < args.length && args[position].startsWith("-")) {
    const flag = args[position];
    if (flag === "-b" || flag === "-B") position += 2;
    else if (noValue.has(flag)) position += 1;
    else return -1;
  }
  return position;
}

function parseWorktreeTarget(args: string[], cwd: string, repoRoot: string): string | null {
  const position = worktreeTargetPosition(args);
  if (position < 0) return null;
  const target = args[position];
  if (!validWord(target) || target.startsWith("-") || args.length - position > 2) return null;
  const canonical = realpath(isAbsolute(target) ? target : resolve(cwd, target));
  const parent = realpath(dirname(canonical));
  const worktreeRoot = allowedFileWriteRoots({ repoRoot, dataDir: resolve(repoRoot, "data") }).roots.find(root => root.region === "worktrees")?.path;
  const allowed = worktreeRoot && (parent === worktreeRoot || (dirname(canonical) === worktreeRoot && parent === dirname(canonical)));
  return allowed ? canonical : null;
}

function evaluateWorktreeWrite(args: string[], repoRoot: string, target: RepoTarget, cwd: string): GitExecutionGrant | null {
  if (args[0] === "add") {
    const worktreeTarget = parseWorktreeTarget(args, cwd, repoRoot);
    return worktreeTarget ? { ...grant("worktree-add", repoRoot, target, WORKTREE_DOMAINS), worktreeTarget } : null;
  }
  if (args[0] === "prune") return grant("worktree-remove", repoRoot, target, WORKTREE_DOMAINS);
  if (args[0] !== "remove") return null;
  const targetPath = args[1];
  if (!validWord(targetPath) || args.length > 3) return null;
  const worktreeTarget = realpath(isAbsolute(targetPath) ? targetPath : resolve(cwd, targetPath));
  if (dirname(worktreeTarget) !== realpath(resolve(repoRoot, ".otter/worktrees"))) return null;
  return { ...grant("worktree-remove", repoRoot, target, WORKTREE_DOMAINS), worktreeTarget };
}

function evaluateManagementWrite(envelope: GitEnvelope, repoRoot: string, target: RepoTarget, cwd: string): GitExecutionGrant | null {
  const { subcmd, args } = envelope;
  if (subcmd === "fetch") {
    const domains = [...(target.kind === "linked" ? ["worktree-gitdir" as const] : []), ...FETCH_DOMAINS];
    return grant("fetch", repoRoot, target, domains);
  }
  if (subcmd === "push") return grant("push", repoRoot, target, PUSH_DOMAINS);
  if (subcmd === "worktree") return evaluateWorktreeWrite(args, repoRoot, target, cwd);
  if (subcmd === "branch" && args.includes("-d") && !args.includes("-D")) {
    return grant("branch-delete", repoRoot, target, ["refs-heads", "logs-refs", "packed-refs-lock"]);
  }
  return null;
}

function evaluateSubcommand(
  envelope: GitEnvelope, repoRoot: string, target: RepoTarget, cwd: string,
): GitExecutionGrant | null {
  return evaluateReadOnly(envelope.subcmd, envelope.args, repoRoot, target)
    ?? evaluateTreeWrite(envelope.subcmd, repoRoot, target)
    ?? evaluateManagementWrite(envelope, repoRoot, target, cwd);
}

export function evaluateGitExecution(
  command: string, cwd: string, opts: GitExecutionPolicyOptions,
): GitExecutionVerdict {
  const envelope = parseEnvelope(command, cwd);
  if (!envelope) return null;
  const repoRoot = realpath(opts.repoRoot);
  const target = resolveTarget(envelope.targetPath, cwd, repoRoot, opts.linkedWorktrees ?? new Map());
  return target ? evaluateSubcommand(envelope, repoRoot, target, cwd) : null;
}

function escapePath(path: string): string {
  // SBPL 单行 profile 不允许控制字符；拒绝而不是生成多行 profile。
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) throw new Error("Git profile path contains control characters");
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
  rules.push(
    `(allow file-write* (literal "${escapePath(grant.worktreeTarget)}") (subpath "${escapePath(grant.worktreeTarget)}"))`,
    `(allow file-write* (literal "${escapePath(resolve(grant.worktreeTarget, ".git"))}"))`,
  );
  return rules;
}

export function grantToProfileRules(grant: GitExecutionGrant): string[] {
  const gitDir = `${escapePath(grant.repoRoot)}/.git`;
  const subpath = (path: string) => `(allow file-write* (subpath "${escapePath(path)}"))`;
  return grant.domains.map(domain => {
    if (domain === "worktree-gitdir") return subpath(`${gitDir}/worktrees/${grant.worktreeName}`);
    if (domain === "objects") return subpath(`${gitDir}/objects`);
    if (domain === "refs-heads") return subpath(`${gitDir}/refs/heads`);
    if (domain === "refs-remotes") return subpath(`${gitDir}/refs/remotes`);
    if (domain === "logs-refs") return subpath(`${gitDir}/logs`);
    if (domain === "worktrees-parent") {
      return [subpath(`${gitDir}/worktrees`), ...worktreeTargetRules(grant)].join(" ");
    }
    if (domain === "config-lock") {
      return `(allow file-write* (literal "${escapePath(`${gitDir}/config.lock`)}"))`;
    }
    if (domain === "packed-refs-lock") {
      return `(allow file-write* (literal "${escapePath(`${gitDir}/packed-refs`)}") (literal "${escapePath(`${gitDir}/packed-refs.lock`)}"))`;
    }
    const file = domain === "fetch-head" ? "FETCH_HEAD" : domain === "orig-head" ? "ORIG_HEAD" : "packed-refs";
    return `(allow file-write* (literal "${escapePath(`${gitDir}/${file}`)}"))`;
  });
}

export function grantFingerprint(grant: GitExecutionGrant): string {
  return JSON.stringify([grant.repoRoot, grant.worktreeName ?? null, grant.worktreeTarget ?? null, [...grant.domains].sort()]);
}
