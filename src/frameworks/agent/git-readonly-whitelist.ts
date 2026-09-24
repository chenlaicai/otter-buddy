/**
 * git 只读子命令白名单（F20260924gfpn 从 bash-safety-guard.ts 拆出）。
 *
 * 拆分离由：bash-safety-guard.ts 基线恰近 max-lines 450 上限，#gfpn 白名单快通道 +
 * r1（检视 S1）的 AMBIGUOUS_READONLY_FLAGS 第二级判定净增代码必然超限。本组
 * （白名单集合 + 歧义子命令只读 flag 判定 + git 子命令词元解析 + 全段只读判定）
 * 自包含、纯函数无状态，独立成文件后主文件回落至上限内。
 *
 * 安全不变量（本组守护）：
 * - 白名单=真只读子集（剔除带写形态的 branch/stash/tag/remote/config/reflog）
 * - 歧义子命令只读形态靠 AMBIGUOUS_READONLY_FLAGS 精确识别 flag/参数放行，写形态回落写族判定
 * - 子命令名精确匹配全称（gitSubcommandOf 取首词元全等），`git log-f` 前缀模糊变形不命中
 */

/** git 真只读子命令白名单（精确全称，非前缀匹配）。 */
const GIT_READONLY_WHITELIST = new Set([
  "log", "diff", "status", "show", "rev-parse", "rev-list", "merge-base",
  "blame", "describe", "ls-files", "ls-remote", "ls-tree",
  "shortlog", "cherry",
  "commit-tree", "cat-file", "for-each-ref", "name-rev", "var", "version",
  "count-objects", "verify-pack", "whatchanged", "archive",
]);

/** F20260924gfpn-r1（检视 S1 处置）：带写形态的 git 子命令——白名单外的第二级精确判定。
 *  这些子命令既有只读形态（git branch -a / git stash list / git tag -l / git config --get）
 *  也有写形态（git branch x / git stash push / git tag v1 / git config k v）。白名单收紧为真只读
 *  子集后，这类「只读形态」靠本函数精确识别 flag/参数来放行，写形态仍回落写族判定拦截。
 *  注意 bare 形态（git branch / git stash / git tag / git remote / git config，无参数）：
 *  git 语义里 bare 是只读列表（branch→list / stash→list / tag→list / remote→list /
 *  config→list），语义同对应的显式只读 flag，故放行；`git config k v` 等带值形态必须有
 *  flag 才放行，否则回落写族保守拦。
 *  安全不变量：识别逻辑只接受「bare 或明确只读 flag 的形态」；含写语义参数一律不放行。
 */
const AMBIGUOUS_READONLY_FLAGS: Record<string, (args: string[]) => boolean> = {
  // git branch：bare 或 -a/-r/-v/-vv/--show-current/--list 只读
  branch: (a) => a.length === 0 || a.every(x => /^-[arv]+$|^--(show-current|list|all|remotes|verbose)$/.test(x)),
  // git stash：bare（=list）或 list / show（可带 stash@{n}）
  stash: (a) => a.length === 0 || a.every(x => /^(list|show|stash@\{\d+\})$/.test(x)),
  // git tag：bare（=list）或 -l/--list/-n 只读（建/删 tag 带值 → 不在此列）
  tag: (a) => a.length === 0 || a.every(x => /^-[ln]+$|^--(list|sort|format|contains|points-at)$/.test(x)),
  // git remote：bare（=list）或 -v / show / get-url / prune-dry
  remote: (a) => a.length === 0 || a.every(x => /^-v$|^(show|get-url|prune)$/.test(x)),
  // git config：bare（=list）或 --get/--get-all/--list/-l 只读
  config: (a) => a.length === 0 || a.every(x => /^-(l|e)$|^--(get|get-all|get-regexp|list|show-origin|show-scope)$/.test(x)),
  // git reflog：bare（=show）或 show
  reflog: (a) => a.length === 0 || a.every(x => /^show$/.test(x)),
};

/** git 子命令词元序列（首个非 flag 词元为子命令名）。
 *  F20260924gfpn：剥变量赋值前缀——`FOO=1 git commit` 的赋值是 shell 前缀不是
 *  子命令；不剥会把 commit 当成「首个词元」位置错乱。 */
export function gitSubcommandOf(seg: string): string | null {
  const words = seg.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && /^[A-Za-z_]\w*=\S*$/.test(words[i])) i++; // 赋值前缀
  if (words[i] !== "git") return null;
  i++;
  while (i < words.length) {
    const w = words[i];
    if (!w.startsWith("-")) return w.replace(/^["']|["']$/g, "");
    i++;
    // 取值型全局 flag（-C / --git-dir / --work-tree）跳过值
    if (/^(-C|--git-dir|--work-tree|--namespace)$/.test(w)) i++;
  }
  return null;
}

/** 取 git 子命令后的全部参数词元（供 AMBIGUOUS_READONLY_FLAGS 判定） */
export function gitArgsOf(seg: string): string[] | null {
  const words = seg.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && /^[A-Za-z_]\w*=\S*$/.test(words[i])) i++;
  if (words[i] !== "git") return null;
  i++;
  // 跳过全局 flag（含取值型 -C/--git-dir 的值）
  while (i < words.length && words[i].startsWith("-")) {
    const isValued = /^(-C|--git-dir|--work-tree|--namespace)$/.test(words[i]);
    i++;
    if (isValued) i++;
  }
  if (i >= words.length) return []; // 无子命令
  const sub = words[i]; // 子命令名
  if (sub.startsWith("-")) return []; // 畸形（子命令位是 flag）
  return words.slice(i + 1); // 子命令之后的全部为参数
}

/** F20260924gfpn-r1（检视 S1）：段是否为「带写形态子命令的只读形态」？ */
export function isAmbiguousReadonly(seg: string, sub: string): boolean {
  const pred = AMBIGUOUS_READONLY_FLAGS[sub];
  if (!pred) return false;
  const args = gitArgsOf(seg);
  return args !== null && pred(args);
}

/** 整条命令的每个段都是「git 只读子命令」段？（链式绕过防线）
 *  非 git 段（echo/ls/rm/…）不参与本快通道——它们的写形态由重定向/data 破坏等
 *  既有判定承担，不因此放行。
 *  F20260924gfpn-r1（检视 S1 处置）：白名单=真只读子集；带写形态子命令（branch/stash/
 *  tag/remote/config/reflog）的只读形态由 isAmbiguousReadonly 精确识别 flag/参数放行，
 *  写形态不在白名单、也非只读形态 → 不命中，回落写族判定拦截。
 *  前缀模糊防御：子命令名精确匹配白名单全称（gitSubcommandOf 取首词元全等），
 *  `git log-f` 的 log-f 不在集合内 → 不命中。 */
export function allSegmentsGitReadonly(command: string): boolean {
  const segments = command.split(/&&|\|\||[;&\n|]/).map(s => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  for (const seg of segments) {
    const sub = gitSubcommandOf(seg);
    if (!sub) return false;
    if (GIT_READONLY_WHITELIST.has(sub)) continue;
    if (isAmbiguousReadonly(seg, sub)) continue;
    return false;
  }
  return true;
}
