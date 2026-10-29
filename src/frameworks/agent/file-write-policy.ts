/**
 * F20261027gscv Phase 1：write/edit 结构化文件写区策略（单一事实源）。
 *
 * 设计依据：F20261027gscv-guard-bounded-convergence.md §5.1——共享写区事实源，
 * 供 bash 沙箱（bash-sandbox.ts）与 write/edit 结构化工具（file-tool-guard.ts）对齐稳定写区。
 * Git 元数据不属于通用文件写区：真实 `.git` 由 Git 执行域单独最小授权。
 *
 * 职责边界：
 * - 只做路径集合与真实落点判定，不读取文件内容、不理解命令/意图
 * - 输入必须是绝对路径（SDK operations 收到的已是 resolveToCwd 后的绝对路径，
 *   实证：pi-coding-agent 1.1.0 write.js/edit.js execute 先 resolveToCwd 再调 ops）
 * - 真实落点判定防三类穿透：`..` 归并、路径别名（/var ↔ /private/var）、
 *   普通符号链接（最近已存在祖先 realpath + 不存在剩余段拼接）
 * - 判定失败一律 fail-closed（allow=false）
 *
 * 非目标（设计 §5.2 诚实边界）：不防恶意宿主进程的 TOCTOU 竞态；
 * 不解析 bash；不复用 write-target-evaluator（后者面向 bash 字符串求值，职责不同）。
 */

import { realpathSync as fsRealpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** 允许写区标签——稳定部署写区；bash 默认白名单另由 Git 执行域按需收窄 .git */
export type FileWriteRegion = "workspaces" | "worktrees" | "workforms" | "alpha" | "tmp" | "external-worktrees";

/** 外部仓 worktree 动态判定器：复用 Git 执行域同语义（真实注册表成员 + 父目录必须为该仓 .otter/worktrees/）。
 *  以注入方式接入（file-write-policy 不 import git-execution-policy——依赖方向为后者依赖前者），
 *  装配点（bash-sandbox.ts / 测试）负责绑定 resolveExternalGitWorktree 或仿制实现。 */
export type ExternalWorktreeResolver = (resolvedPath: string) => { repoRoot: string; worktreeRoot: string; worktreeName: string } | null;

/** 允许写区根路径（realpath 展开后） */
export interface FileWriteRegionRoot {
  region: FileWriteRegion;
  /** realpath 后的根路径；ENOENT/ENOTDIR 时回退原样，其他解析错误禁止建 policy */
  path: string;
}

/** 策略注入参数 */
export interface FileWritePolicyOptions {
  /** 主仓根目录 */
  repoRoot: string;
  /** 主仓 data/ 目录绝对路径（workspaces 根的父目录） */
  dataDir: string;
  /**
   * 测试用写区根覆盖：按区替换根路径。生产装配不传（用真实 tmpdir/homedir）。
   * 设计 §5.1「根路径统一注入」的落点——测试 fixture 无需伪造绝对主仓路径。
   * tmp 区覆盖为单值替换（整体替换三根为 fixture 根）。
   */
  rootsOverride?: Partial<Record<Exclude<FileWriteRegion, "external-worktrees">, string | null>>;
  /** #1695：外部仓 worktree 动态判定器。静态白名单 miss 后对落点做真实 Git 注册表
   *  判定（与 git 执行域 resolveExternalGitWorktree 同语义）；生产由装配点注入，
   *  缺省 null = 该区关闭（保持既有行为，不新增敞口）。 */
  resolveExternalWorktree?: ExternalWorktreeResolver | null;
}

/** 单次写目标判定结果 */
export interface FileWritePolicyVerdict {
  allowed: boolean;
  /** 允许时命中的写区；拒绝时 undefined */
  region?: FileWriteRegion;
  /** 真实落点判定路径（realpath 展开后；解析失败时为输入原样） */
  resolvedPath: string;
  /** 拒绝时的 ruleId（healing/审计落账锚点） */
  ruleId?: string;
  /** 拒绝原因（人可读，不含文件内容） */
  reason?: string;
}

/** 可复用的写区策略实例 */
export interface FileWritePolicy {
  /** 判定一个绝对路径的真实落点是否在允许写区（fail-closed） */
  checkWriteTarget(absolutePath: string): FileWritePolicyVerdict;
  /** 允许写区清单（诊断/测试用） */
  allowedRoots(): readonly FileWriteRegionRoot[];
}

/** 派生允许写区根清单——结构化 write/edit 与 bash 共用稳定区域定义，Git 执行域单独授权 */
function deriveAllowedRoots(
  options: FileWritePolicyOptions,
  realpathSync: RealpathSync,
): FileWriteRegionRoot[] {
  const repo = toRealPath(options.repoRoot, realpathSync);
  const defaults: Record<Exclude<FileWriteRegion, "external-worktrees">, string> = {
    // 獭会话工作区——write/edit 最常见合法落点（獭 cwd 即 data/workspaces/<对话ID>/）
    workspaces: join(options.dataDir, "workspaces"),
    // 獭开发 worktree
    worktrees: join(repo, ".otter", "worktrees"),
    // 獭运行时自治区（F20261016gsbx G2 对表口径：与 worktrees 同性质）
    workforms: join(repo, ".otter", "workforms"),
    // 真实 Git 元数据不开通用文件写面：worktree `.git` 指针与真实 gitdir 都由
    // checkWriteTarget 的精确路径组件闸拒绝，只能由 Git 自身修改。
    // alpha 隔离实例数据根
    alpha: join(homedir(), ".otter", "alpha"),
    // 系统临时目录（#1695：多根覆盖 macOS 别名形态——os.tmpdir() 本机为
    // /var/folders/.../T，与常识 /tmp（realpath → /private/tmp）、/var/tmp 互为不同目录，
    // 单根会把 write /tmp/x.md 误拒。实际根在 deriveAllowedRoots 内多根展开，
    // 此处不用 defaults["tmp"]，占位串仅保类型完整）。
    tmp: "",
  };
  const override = options.rootsOverride ?? {};
  const roots: FileWriteRegionRoot[] = [];
  for (const region of Object.keys(defaults) as FileWriteRegion[]) {
    if (region === "external-worktrees") continue; // 动态判定区，无静态根
    if (region === "tmp") {
      // #1695：tmp 区多根展开（os.tmpdir() + /tmp + /var/tmp），realpath 归一去重
      const tmpOverride = override.tmp;
      const tmpRoots = tmpOverride === null
        ? []
        : tmpOverride !== undefined
          ? [tmpOverride]
          : [tmpdir(), "/tmp", "/var/tmp"];
      for (const rawRoot of tmpRoots) {
        pushRoot(roots, "tmp", toRealPath(rawRoot, realpathSync));
      }
      continue;
    }
    const overridden = override[region];
    // 显式 null = 测试排除该区（如排除真实 tmpdir 防 fixture 落入）
    if (overridden === null) continue;
    pushRoot(roots, region, toRealPath(overridden ?? defaults[region], realpathSync));
  }
  return roots;
}

/** 同区多根去重压入（realpath 归一后可能重合，如 /tmp 与 /private/tmp） */
function pushRoot(roots: FileWriteRegionRoot[], region: FileWriteRegion, path: string): void {
  if (!roots.some(root => root.region === region && root.path === path)) {
    roots.push({ region, path });
  }
}

type RealpathSync = (path: string) => string;

interface FileSystemError extends Error {
  code?: string;
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as FileSystemError)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** root 不存在可保守保留原路径；EACCES/EIO 等不能伪装成不存在继续授权 */
function toRealPath(p: string, realpathSync: RealpathSync): string {
  try {
    return realpathSync(p);
  } catch (error) {
    if (isMissingPathError(error)) return p;
    throw error;
  }
}

/**
 * 解析输入绝对路径的真实落点：
 * - 已存在：realpath 展开（符号链接、路径别名全部归一）
 * - 不存在：找最近已存在祖先 realpath，再拼接剩余不存在段
 *   （剩余段尚不存在，其中不可能有符号链接——POSIX 要求祖先存在才能建子路径；
 *    最终组件由 OS 在创建时解析，普通创建对不存在段无链接可跟）
 * - 完全无法解析（如根不存在）：fail-closed 语义由调用方以原样路径保守判定
 */
function resolveTargetPath(absolutePath: string, realpathSync: RealpathSync): string {
  const merged = resolve(absolutePath);
  const suffix: string[] = [];
  let cursor = merged;
  for (;;) {
    try {
      const realExisting = realpathSync(cursor);
      return suffix.length > 0 ? join(realExisting, ...suffix) : realExisting;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) {
        // 根也只可能因不存在/非目录而失败；保留归并路径，最终按白名单拒绝。
        return merged;
      }
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function isWithin(target: string, root: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 精确组件匹配，不误伤 .gitignore/.github；不存在段也参与判定。
 *  #1695：动态区（external-worktrees）内部同样拒绝 .git 元数据写——动态判定
 *  不重开元数据写面，与静态区同闸。 */
function containsGitMetadataComponent(target: string): boolean {
  return resolve(target).split(/[\\/]+/).includes(".git");
}

/** 从文件落点向上找最近的 `.otter/worktrees/<name>` 边界（#1695 动态区辅助）。
 *  只做形态归约（返回候选 worktree 根），真实性由注入的 resolver 判定（真实 Git
 *  注册表成员才认）——伪造的 .otter/worktrees/x 目录没有注册表成员资格，仍拒。 */
function nearestExternalWorktreeRoot(target: string): string | null {
  const segments = resolve(target).split(/[\\/]+/).filter(Boolean);
  for (let i = segments.length - 2; i >= 1; i--) {
    if (segments[i - 1] === "worktrees" && segments[i - 2] === ".otter") {
      return "/" + segments.slice(0, i + 1).join("/");
    }
  }
  return null;
}

/** 允许测试包装 policy 的 realpath；生产直接传绑定后的 fs.realpathSync */
export function createFileWritePolicyWithRealpath(
  options: FileWritePolicyOptions,
  realpathSync: RealpathSync,
): FileWritePolicy {
  const roots = deriveAllowedRoots(options, realpathSync);
  const resolveExternal = options.resolveExternalWorktree ?? null;

  const policy: FileWritePolicy = {
    checkWriteTarget(absolutePath: string): FileWritePolicyVerdict {
      // 输入契约：SDK operations 层保证绝对路径；非绝对输入属判前失败，fail-closed
      if (typeof absolutePath !== "string" || absolutePath.length === 0 || !isAbsolute(absolutePath)) {
        return {
          allowed: false,
          resolvedPath: absolutePath,
          ruleId: "file-tool-guard/path-resolve-failed",
          reason: "路径不是可判定的绝对路径",
        };
      }
      let target: string;
      try {
        target = resolveTargetPath(absolutePath, realpathSync);
      } catch {
        return {
          allowed: false,
          resolvedPath: absolutePath,
          ruleId: "file-tool-guard/path-resolve-failed",
          reason: "路径真实落点解析失败",
        };
      }
      if (containsGitMetadataComponent(target)) {
        return {
          allowed: false,
          resolvedPath: target,
          ruleId: "file-tool-guard/git-metadata-write",
          reason: "Git 元数据（含 worktree .git 指针与真实 gitdir）只能由 Git 自身修改",
        };
      }
      for (const root of roots) {
        if (isWithin(target, root.path)) {
          return { allowed: true, region: root.region, resolvedPath: target };
        }
      }
      // #1695 缺口 A：外部仓真实注册 worktree 的动态判定区（注入式，见类型注释）。
      // 静态白名单全部 miss 后才尝试；不认非 Git 注册表目录（伪造 .git/普通目录均拒）。
      // 注意：传入的是文件落点——生产 resolver（resolveExternalGitWorktree）只认
      // worktree 根直接命中，这里先归到最近的 worktree 根再问（父目录逐级向上找
      // .otter/worktrees/<name> 形态），与 git 执行域 resolveTarget 的语义对齐。
      if (resolveExternal) {
        const externalRoot = nearestExternalWorktreeRoot(target);
        if (externalRoot && resolveExternal(externalRoot)) {
          return { allowed: true, region: "external-worktrees", resolvedPath: target };
        }
      }
      return {
        allowed: false,
        resolvedPath: target,
        ruleId: "file-tool-guard/main-repo-write",
        reason: "目标不在任何允许写区（主仓源树与主仓受保护路径默认只读）",
      };
    },
    allowedRoots() {
      return roots;
    },
  };
  return policy;
}

export function createFileWritePolicy(options: FileWritePolicyOptions): FileWritePolicy {
  return createFileWritePolicyWithRealpath(options, (path) => fsRealpathSync(path));
}

/** 与 bash 沙箱共享同一份稳定写区；生产路径仍由两侧各自在执行前校验。 */
export function allowedFileWriteRoots(options: FileWritePolicyOptions): {
  repoRoot: string;
  roots: readonly FileWriteRegionRoot[];
} {
  const realpath = (path: string) => fsRealpathSync(path);
  return {
    repoRoot: toRealPath(options.repoRoot, realpath),
    roots: deriveAllowedRoots(options, realpath),
  };
}
