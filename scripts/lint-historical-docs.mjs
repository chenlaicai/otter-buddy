#!/usr/bin/env node
/**
 * F20260831dgim: 历史特性文档不可变（commit-time gate）。
 * F20260922dfch: BYPASS 环境变量自觉制 → `.doc-fix` 声明文件显式开口（搭档决策 2026-09-22）。
 *
 * 规则：已合入的特性/研究文档是交付时点的快照，禁止在后续分支上修改（M/R/C/D）。
 * 后续特性更新一律追加新特性文档记录变化（frontmatter from/supersedes 关联前文）。
 * 判定"历史"：该文件不是本分支新建（本分支独有 commit 里没有它的 Add 记录）。
 *
 * 显式开口（仅限元数据订正：frontmatter 字段修正、id 对齐、格式订正——内容/设计修改一律走 supersede 新文档）：
 *   在仓库根目录新建 `.doc-fix` 文件并 staged 进同一个 commit，文件内容写明订正理由（≥10 字符）。
 *   声明文件随 commit 历史与 PR commits 可见（squash 合并下不进 main 净 diff）——比环境变量更不易悄悄绕过，且理由强制留痕。
 *   机械边界（F20260922dfch 严重 1 处置）：除声明文件外，每个历史文档的变更行必须全部落在 frontmatter
 *   块内（首个 --- 至次个 ---）；正文实质修改（增/删非空行）即使配 .doc-fix 也拒绝放行——「仅限元数据」
 *   是机制不是约定。提交后由使用者删除 .doc-fix（lint 仅提示；忘删 fail-closed：残留且未变更的声明不开启通道）。
 *   R 形态 rename（#1257，F20261001lrbk）：git mv 产生的 R 配对此前被双重误拦（isAddedOnBranch 按
 *   oldPath 判历史 + checkFrontmatterScope 单路径 diff 把 rename 展开成全文新增）——纯 rename
 *   （similarity 100%，内容零变化）本质是文件名级元数据订正。修复：R 配对改从全量 diff 取 hunks，
 *   无 hunks（纯 rename）放行；有 hunks 按 old/new 两侧 frontmatter 边界校验（正文编辑仍拦）；
 *   相似度 <50% 退化为 A+D 配对的仍宁拦（大改不是文件名订正）。.doc-fix 声明对 rename 通道同样强制。
 *
 * F20261009hcig（#1281）：--base <ref> CI 模式——补齐执行面缺口（本脚本此前只挂 pre-commit，
 *   git commit --no-verify 可整体绕过；其余 7 个 pre-commit lint gate 均有 CI 对应，唯本门禁缺席）。
 *   逐 commit 重放同等校验：git rev-list --parents base..HEAD 逐个 commit，对其 first-parent diff
 *   （等价于该 commit 提交时的 staged 区）跑与 pre-commit 完全相同的判定。
 *   核心语义约束——同 commit 配对：.doc-fix 声明与历史文档变更必须在**同一个 commit** 内配对
 *   （pre-commit 模式下天然成立），CI 扫 range 时禁止退化成「range 内存在 .doc-fix 就放行」
 *   （无关 commit 塞声明 + 独立 commit 改历史文档 = 新绕过面）。
 *   ref 侧切换：:file → <commit>:file、HEAD:file → <commit>^:file、isAddedOnBranch 的 log 上界
 *   HEAD → <commit>^（精确重放 pre-commit 时点语义：pre-commit 运行时 HEAD 即待提交 commit 的父）。
 *   merge commit 跳过不检查（实测修正）：曾设计按 first-parent diff 检查（封 evil merge），
 *   但实测发现误报面不可接受——本仓 CI up-to-date gate 强制 PR 分支 rebase/merge main，而
 *   main 的 squash 合入会把 .doc-fix 创建/删除对消出净 diff（如 #1375 两个 R099）：
 *   「PR merge main」时 merge commit 的 first-parent diff 会把 main 来的变更记入本 PR → 必红。
 *   邪恶 merge 的真正逃生通道（squash 对消后进 main）与普通 PR 同构，机械层在 merge 进
 *   main 环节本就无扫描；非 merge commit 仍逐个全量重放，实质拦截面不损失。取舍详见特性文档。
 *   环境异常（--base ref 不可解析 / rev-list 失败）宽松放行 exit 0——fork PR、浅克隆等场景
 *   fail-closed 会误伤；--base 缺参数属调用错误，exit 2 立即红。
 *
 * 退出码：0 通过（含宽松放行）/ 1 有违规 / 2 调用错误（--base 缺参数）。
 */
import { execFileSync } from "node:child_process";

function git(args, opts = {}) {
  // 全检-5（终审严重 1）：统一禁用 quotePath——默认开启时非 ASCII 路径输出 \3xx 转义形态，
  // 本脚本的路径过滤/段匹配/show 查询全部打在原始串上恒 miss，CJK 文件名历史文档整类
  // 逃出门禁（实测：同 staged 改 CJK 文档正文 exit=0 零输出）。所有调用面一次收口。
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], { encoding: "utf8", ...opts }).trim();
}

/** 找基准分支引用（origin/main 优先，退化为 main，都无则返回 null 宽松放行） */
function baseRef() {
  for (const ref of ["origin/main", "main"]) {
    try {
      git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return ref;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** F20261009hcig（#1281）：命令行参数解析。当前仅 --base <ref>（CI 逐 commit 模式）。 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) {
        console.error("[lint:historical-docs] --base 需要一个 ref 参数（如 --base origin/main）");
        process.exit(2);
      }
      out.base = v;
      i++;
    }
  }
  return out;
}

/** 变更集上下文（F20260831dgim 的 staged 语义与 F20261009hcig 的 commit 语义统一抽象）：
 *  把「diff 来源 + 树引用 + log 上界」参数化，同一套校验逻辑可重放在 staged 区（pre-commit）
 *  或单个 commit 的 first-parent diff（--base CI 模式）上。两模式语义等价性锚点：
 *  pre-commit 运行时 HEAD = 待提交 commit 的父、index = 即将提交的内容——commitCtx 中
 *  parent/commit 分别对应这两个角色。 */
function stagedCtx() {
  return {
    where: "当前 staged 区",
    base: null, // 走 findViolations 内 baseRef() 既有解析（origin/main 优先）
    logHead: "HEAD",
    nameStatus: () => git(["diff", "--cached", "--name-status"]),
    nameOnly: () => git(["diff", "--cached", "--name-only"]),
    diffU0: (file) => git(["diff", "--cached", "-U0", "--", file]),
    diffU0M: () => git(["diff", "--cached", "-U0", "-M"]),
    newRef: (f) => `:${f}`, // index（即将提交的内容）
    oldRef: (f) => `HEAD:${f}`, // 父版本
    docFixContent: () => git(["show", ":.doc-fix"]),
  };
}

/** commit 模式 ctx：对 sha 相对其父 parent 的 diff 重放校验。nameStatus 显式 -M
 *  （CI 环境 config 干净，显式声明不依赖 diff.renames 默认值；stagedCtx 保持原样零回归）。 */
function commitCtx(sha, parent, baseSha) {
  return {
    where: `commit ${sha.slice(0, 8)}`,
    base: baseSha, // range 模式下基准即传入 base，不走 origin/main 优先解析
    logHead: parent, // isAddedOnBranch 的 log 上界 = 父（pre-commit 时点语义）
    nameStatus: () => git(["diff", parent, sha, "--name-status", "-M"]),
    nameOnly: () => git(["diff", parent, sha, "--name-only"]),
    diffU0: (file) => git(["diff", parent, sha, "-U0", "--", file]),
    diffU0M: () => git(["diff", parent, sha, "-U0", "-M"]),
    newRef: (f) => `${sha}:${f}`, // 该 commit 的树
    oldRef: (f) => `${parent}:${f}`, // 父 commit 的树
    docFixContent: () => git(["show", `${sha}:.doc-fix`]),
  };
}

/** 该文件是否为本分支新建（在 origin/main..HEAD 全部 commit 中曾出现过 Add，含新增后修改/重命名路径）
 *  边界：新增后 commit 再修改的场景，log 范围含产生 Add 的 commit，判定为分支新建
 *  F20260922rntc（#1103）：rename R 形态溯源——staged rename 未提交时，新路径在 ref..HEAD 中
 *  查不到 Add（git log --follow 对已提交历史有效，但对「索引区里尚未提交的 rename」看不到），
 *  需按旧路径查 Add。
 *  F20260922rntc delta（PR #1108 检视严重 1 + 建议 1，判定语义修订）：
 *  - R 形态（oldPath 存在）：仅按 oldPath 判定——R 行语义上内容来源是 oldPath，「任一命中」
 *    中 newPath 一侧对 R 行恒 miss（依赖 git 怪癖的偶然正确），若 git 修正行为则留误放窗口
 *  - 非 R 形态（M/D）：并集查询——`--diff-filter=A`（无 --follow）兜住高相似派生文件
 *    （--follow 与 diff-filter 交互对派生文件系统性 miss，实测坐实），`--follow --diff-filter=A`
 *    保留已提交 rename 链的溯源
 *  F20261009hcig（#1281）：head 参数——log 上界可参数化（pre-commit 传 HEAD = 待提交 commit
 *  的父；--base 逐 commit 模式传 <commit>^，精确重放同一时点语义）。
 */
function isAddedOnBranch(file, ref, oldPath, head = "HEAD") {
  const hasAdd = (p) => {
    try {
      const plain = git(["log", `${ref}..${head}`, "--diff-filter=A", "--format=%H", "--", p]);
      if (plain.length > 0) return true;
      const follow = git(["log", `${ref}..${head}`, "--follow", "--diff-filter=A", "--format=%H", "--", p]);
      return follow.length > 0;
    } catch {
      return false;
    }
  };
  // delta-3（链上 rename 豁免，全检獭 probeChain 实证）：R 形态先做 rename 血统判定——
  // 沿 oldPath 的 --follow 链找 R 记录，任一 rename 源路径在 base 上存在 → 血统必为历史文档，
  // 无论分支内有没有自造 Add 记录都不豁免。
  // 盲区机制：分支内 commit1 对历史文档做非 R100 rename（补内容）时，git plain（非 --follow）
  // 查询对 rename commit 拆段呈 A+D，新路径被记为「分支内 Add」；后续同分支 commit2 再 R100
  // 时 oldPath 恰好命中这条自造 Add → 被误判分支新建豁免 → 跳过 rename 通道校验。
  // 为何不用 cat-file(oldPath on base) 直接判：probeChain 的 oldPath（Fmid）就不在 base 上。
  // 为何不用 --follow 链根判：follow 对「cp 历史文档微改」的派生文档会把链根误溯到源文档
  // （相似度启发），误伤分支内合法派生迭代（rntc delta 用例实证；其链上记录是 C 非 R，
  // 用 R 记录+源存在性可机械区分 rename 血统与 copy 派生）。
  if (oldPath && oldPath !== file) {
    if (hasRenameLineageToBase(oldPath, ref)) return false;
    return hasAdd(oldPath);
  }
  return hasAdd(file);
}

/** docs 管辖树路径判定（features|research） */
function inDocsTreePath(p) {
  return /^docs\/(features|research)\//.test(p);
}

/** 路径的 --follow 改名链上是否出现过 docs/features|research 路径。
 *  #1273 delta 第二轮（严重 2）：用于「删除树外文件」的入册判定——两步逃逸链把历史文档
 *  mv 出树后留下的残留，其删除动作也是历史文档处置链的一环，不得静默放行。 */
function hasDocsTreeAncestry(p) {
  try {
    const log = git(["log", "--follow", "--format=", "--name-only", "--", p]);
    return log
      .split("\n")
      .some((l) => /^docs\/(features|research)\//.test(l.trim()));
  } catch {
    return true; // 链查询失败 → 宁可入册交由后续宁拦逻辑，不放行
  }
}

/** D 行渊源判定：该路径 --follow 改名链的「最早新增 commit」是否早于基准分支。
 *  #1273 delta 第二轮（probeC 实证）：攻击者 step1 把历史文档 mv 出树后，自己的 commit 恰好
 *  给新路径造出了「分支内 Add」记录，isAddedOnBranch 被这条自造记录骗过 → 豁免删除。
 *  解法：看链的最早新增落在哪——早于 base = 渊源是历史文档，删除无条件违规；
 *  落在本分支 = 分支内新建后删除的正常迭代，照常豁免。
 *  delta-3 起兼供 isAddedOnBranch 的 R 分支做链根血统判定（同一盲区：自造 Add 骗过 plain 查询）。 */
function hasHistoricalAncestry(p, ref) {
  try {
    const adds = git(["log", "--follow", "--diff-filter=A", "--format=%H", "--", p])
      .split("\n")
      .filter(Boolean);
    if (adds.length === 0) return false; // 从未提交过 → 无渊源可言
    const root = adds[adds.length - 1]; // 最早新增（log 逆时序，末位即链根）
    try {
      git(["merge-base", "--is-ancestor", root, ref]);
      return true; // root 是 base 祖先 → 历史文档血统
    } catch (e) {
      // merge-base --is-ancestor 用退出码表意：root 非 base 祖先 → 本分支新增（正常路径，非查询错误）
      if (e.status === 1) return false;
      return true; // 其他异常（128 等）→ 宁拦
    }
  } catch {
    return true; // 查询失败宁拦
  }
}

/** rename 血统判定：oldPath 自身在 base 存在，或其 --follow 链上任一 R 记录的源路径在 base 存在。
 *  #1273 delta-3（probeChain 实证）：封「链上 rename 自造 Add 豁免」——分支内非 R100 rename 的
 *  目标被 plain 查询记为分支内 Add，后续 R100 的 oldPath 命中它即被误豁免；rename 源在 base 的
 *  存在性是攻击链伪造不了的。C 记录（copy 派生）不算 rename 血统——cp 派生是分支内新文档（rntc）。
 *  查询异常宁拦（返回 true 交后续边界校验拦截）。 */
function hasRenameLineageToBase(oldPath, ref) {
  try {
    git(["cat-file", "-e", `${ref}:${oldPath}`]);
    return true; // oldPath 本身在 base 存在 → 历史 rename 血统
  } catch {
    /* 不在 base，继续查链 */
  }
  try {
    // 注意用 --pretty=format: 前缀（裸 @ 开头的 --format= 值被 git 当非法 pretty 名拒掉）
    const log = git(["log", "--follow", "--name-status", "--pretty=format:@BOUNDARY@", "--", oldPath]);
    for (const line of log.split("\n")) {
      if (!/^R\d{2,3}\t/.test(line)) continue; // 只认 rename 记录（C 拷贝/A 新建不算）
      const cols = line.split("\t");
      const src = cols[cols.length - 2]; // R 记录：src \t dst
      try {
        git(["cat-file", "-e", `${ref}:${src}`]);
        return true; // rename 源在 base 存在 → 历史 rename 血统
      } catch {
        /* 该源不在 base，继续扫链 */
      }
    }
  } catch {
    return true; // 链查询失败宁拦
  }
  return false;
}

/** 解析 staged 状态行（git diff --cached --name-status），返回 {status, path, oldPath} */
function parseStatusLine(line) {
  const [rawStatus, ...rest] = line.split("\t");
  // 重命名/复制格式："R100\told\tnew" —— 目标路径是最后一列，旧路径是倒数第二列
  const filePath = rest[rest.length - 1];
  const oldPath = rest.length >= 2 ? rest[rest.length - 2] : undefined;
  return { status: rawStatus[0], filePath, oldPath };
}

export function findViolations(ctx = stagedCtx()) {
  let staged;
  try {
    staged = ctx.nameStatus();
  } catch {
    return { errors: [], degraded: true };
  }
  if (!staged) return { errors: [], degraded: false };

  const tracked = staged
    .split("\n")
    .filter(Boolean)
    .map(parseStatusLine)
    // #1273 delta（严重 2）第二轮：rename 配对的旧路径也要测（r1 修法）；
    // 另对「删除树外文件」补渊源入册——两步逃逸链的 step2 会以「删除树外残留」形态出现，
    // 该文件 --follow 链上有 docs 树内路径（源自历史文档）时纳入管辖；
    // 删除真树外文件（tmp/笔记等，链上无 docs 路径）不受影响
    .map((e) =>
      e.status === "D" && !inDocsTreePath(e.filePath) && e.oldPath === undefined
        ? { ...e, docsAncestry: hasDocsTreeAncestry(e.filePath) }
        : e
    )
    .filter((e) => {
      if (inDocsTreePath(e.filePath)) return true;
      if (e.oldPath !== undefined && inDocsTreePath(e.oldPath)) return true;
      if (e.status === "D" && e.docsAncestry) return true;
      return false;
    });

  if (tracked.length === 0) return { errors: [], degraded: false };

  const modified = tracked.filter((e) => e.status !== "A");
  if (modified.length === 0) return { errors: [], entries: {}, degraded: false };

  const ref = ctx.base ?? baseRef();
  if (!ref) {
    console.warn("[lint:historical-docs] 找不到基准分支（origin/main/main），宽松放行");
    return { errors: [], entries: {}, degraded: true };
  }

  const entries = Object.fromEntries(
    modified.map((e) => [e.filePath, { status: e.status, oldPath: e.oldPath }])
  );
  const errors = modified
    .filter((e) => {
      // 历史文档血统的删除：无条件违规——isAddedOnBranch 会被攻击者自造的 step1 Add 骗过
      //（probeC 实证）；正常分支内新建后删除的文档链根在 base 之后，走下面原有豁免
      if (e.status === "D" && e.docsAncestry && hasHistoricalAncestry(e.filePath, ref)) return true;
      return !isAddedOnBranch(e.filePath, ref, e.oldPath, ctx.logHead);
    })
    .map((e) => e.filePath);
  return { errors, entries, degraded: false };
}

function main() {
  const { errors, entries } = findViolations();
  const ctx = stagedCtx();
  if (errors.length === 0) process.exit(0);

  // 显式开口：staged 区存在 .doc-fix 声明文件（内容≥10字符）+ 每个历史文档变更均在 frontmatter 块内
  const declaration = readDocFixDeclaration(ctx);
  if (declaration.ok) {
    const scope = checkFrontmatterScope(errors, entries, ctx);
    if (scope.ok) {
      console.warn(`[lint:historical-docs] .doc-fix 声明文件存在且变更均在 frontmatter 块内，放行 ${errors.length} 个历史文档修改：`);
      for (const f of errors) console.warn(`  M ${f}`);
      console.warn(`  声明理由：${sanitize(declaration.reason)}`);
      console.warn(`  提示：.doc-fix 为一次性声明文件，提交后请删除（git rm .doc-fix；忘删 fail-closed 不构成绕过）。`);
      process.exit(0);
    }
    console.error(`[lint:historical-docs] .doc-fix 声明存在，但以下历史文档的变更超出 frontmatter 块（正文实质修改）：`);
    for (const f of scope.outOfScope) console.error(`  M ${f}`);
    console.error(`
.doc-fix 开口仅限元数据订正（frontmatter 块内）。正文内容/设计修改禁止回改——
请新建特性文档记录变化（frontmatter from/supersedes 关联前文），或将本次正文改动撤销后重新提交。`);
    process.exit(1);
  }

  console.error(`[lint:historical-docs] 检测到修改历史特性/研究文档（${errors.length} 个）：`);
  for (const f of errors) console.error(`  M ${f}`);
  console.error(`
错误：已合入的特性文档是交付时点的快照，禁止修改使其反映"当前状态"。

正当通道（二选一）：
  ① 元数据订正（frontmatter 字段修正 / id 对齐 / 格式订正）：
     在仓库根目录新建 .doc-fix 文件并 staged 进同一个 commit，内容写清订正理由（≥10 字符）。
     声明文件随 commit 历史与 PR commits 可见（squash 合并下不进 main 净 diff）；提交后删除该文件。
     变更行须全部落在 frontmatter 块内——正文修改即使配 .doc-fix 也会被拒。
  ② 内容/设计修改：
     禁止回改历史文档——新建特性文档记录变化（frontmatter from/supersedes 关联前文）。
${declaration.hint}`);
  process.exit(1);
}

/** F20261009hcig（#1281）：--base <ref> CI 模式——逐 commit 重放 pre-commit 同等校验。
 *
 *  为什么逐 commit 而不是对 range 整体 diff 一次：.doc-fix 配对语义。pre-commit 模式下
 *  声明与历史文档变更天然同 commit（同一 staged 区）；range 整体扫描时若退化成「range 内
 *  存在 .doc-fix 就放行」，则「无关 commit 塞声明 + 独立 commit 改历史文档」即可绕过——
  * 逐 commit 对每个触历史文档的 commit 单独校验（该 commit 自己的 diff 里须同时含 .doc-fix
 *  且 fm 边界合规）才能保真配对语义。
 *
 *  环境异常（base ref 不可解析 / rev-list 失败）宽松放行 exit 0：fork PR 的 base、浅克隆等
 *  场景 fail-closed 会误伤非恶意场景；此时 pre-commit 门禁仍在本仓内生效，缺口不会重新打开。
 *
 *  merge commit 跳过不检查（实测修正，语义与取舍见文件头注）：merge commit 的 first-parent
 *  diff 会把「main 来的合法历史文档变更」记入本 PR（squash 对消 .doc-fix 的必然误报）；
 *  非merge commit 仍逐个全量重放。 */
function runBaseMode(baseRefArg) {
  let baseSha;
  try {
    baseSha = git(["rev-parse", "--verify", "--quiet", `${baseRefArg}^{commit}`]);
  } catch {
    baseSha = "";
  }
  if (!baseSha) {
    console.warn(
      `[lint:historical-docs] --base ${baseRefArg} 无法解析（不存在或非 commit），宽松放行。` +
        "fork PR / 特殊克隆形态会走到这里，非恶意场景不阻断（pre-commit 门禁仍在本仓生效）。"
    );
    process.exit(0);
  }

  let commits;
  try {
    // --parents：每行 "sha parent1 [parent2...]"——merge commit 直接识别（≥2 父）
    commits = git(["rev-list", "--parents", `${baseSha}..HEAD`]).split("\n").filter(Boolean);
  } catch {
    console.warn("[lint:historical-docs] rev-list 失败，宽松放行");
    process.exit(0);
  }

  for (const line of commits) {
    const [sha, ...parents] = line.split(" ");
    const parent = parents[0];
    const isMerge = parents.length >= 2;
    if (isMerge) {
      // 语义与取舍见文件头注：merge commit 跳过（实测「PR merge main + squash 对消 .doc-fix」
      // 误报面不可接受）；邪恶 merge 逃生通道与 squash 对消同构，属 review 层保护面
      console.warn(
        `[lint:historical-docs] 跳过 merge commit ${sha.slice(0, 8)}（非 merge commit 逐个全量校验，F20261009hcig）`
      );
      continue;
    }
    const ctx = commitCtx(sha, parent, baseSha);

    // 环境异常（某 commit diff 不可读）→ 宽松放行该 commit（与 pre-commit degraded 同语义）
    const r = findViolations(ctx);
    if (r.degraded) {
      console.warn(`[lint:historical-docs] ${ctx.where} 环境异常，宽松放行`);
      continue;
    }
    if (r.errors.length === 0) continue;

    const declaration = readDocFixDeclaration(ctx);
    if (declaration.ok) {
      const scope = checkFrontmatterScope(r.errors, r.entries, ctx);
      if (scope.ok) {
        console.warn(
          `[lint:historical-docs] ${ctx.where}: .doc-fix 声明存在且变更均在 frontmatter 块内，放行 ${r.errors.length} 个历史文档修改：`
        );
        for (const f of r.errors) console.warn(`  M ${f}`);
        console.warn(`  声明理由：${sanitize(declaration.reason)}`);
        continue;
      }
      console.error(
        `[lint:historical-docs] ${ctx.where}: .doc-fix 声明存在，但以下历史文档的变更超出 frontmatter 块（正文实质修改）：`
      );
      for (const f of scope.outOfScope) console.error(`  M ${f}`);
      process.exit(1);
    }

    console.error(`[lint:historical-docs] ${ctx.where}: 检测到修改历史特性/研究文档（${r.errors.length} 个）：`);
    for (const f of r.errors) console.error(`  M ${f}`);
    console.error(`
错误：已合入的特性文档是交付时点的快照，禁止修改使其反映"当前状态"。
（CI 模式：本 commit 未携带配对的 .doc-fix 声明——声明必须与历史文档变更在同一个 commit 内。）

正当通道（二选一）：
  ① 元数据订正（frontmatter 字段修正 / id 对齐 / 格式订正）：
     .doc-fix 声明文件与历史文档变更必须进同一个 commit（内容写清订正理由，≥10 字符）。
  ② 内容/设计修改：
     新建特性文档记录变化（frontmatter from/supersedes 关联前文）。
${declaration.hint}`);
    process.exit(1);
  }
  process.exit(0);
}

// 直接执行（非被 import 测试）时跑 main（F20261009hcig：--base 优先路由到 CI 模式）
if (process.argv[1] && process.argv[1].endsWith("lint-historical-docs.mjs")) {
  const args = parseArgs(process.argv.slice(2));
  if (args.base) {
    runBaseMode(args.base);
  } else {
    main();
  }
}

/** 终端输出消毒：strip ANSI 转义序列与回车，防理由文本污染终端（检视建议 4）
 *  eslint no-control-regex 规避：用 u001b 构造而非字面 \x1b */
function sanitize(s) {
  const esc = String.fromCharCode(27);
  const ansi = new RegExp(esc + "\\[[0-9;]*[a-zA-Z]", "g");
  return s.replace(ansi, "").replace(/[\r\n]+/g, " ");
}

/** 读 git 引用（index `:<path>`、commit 树 `<sha>:<path>` 等）内容的 frontmatter 结束行号
 *  （1-based，含第二个 ---）。无合法 frontmatter 块或读取失败返回 -1（调用方宁拦）。 */
function frontmatterLastLineOf(ref) {
  let content;
  try {
    content = git(["show", ref]);
  } catch {
    return -1;
  }
  const lines = content.split("\n");
  if (!(lines[0] && lines[0].trim() === "---")) return -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return i + 1; // 1-based
  }
  return -1;
}

/** 逐 hunk 校验：新增行（+）用 new-side 行号比对新边界；删除行（-）用 old-side 行号比对旧边界。
 *  位置判定对两类行统一生效（delta-严重 1：形状判定有洞已退役）。
 *  hunk 体从头行行尾（第二个 @@ 之后）开始，下一 hunk 边界用行首 "\n@@" 锚定。
 *  全检-严重 1 处置修正（#1273）：原实现把 body 起点定在正则匹配串尾，即 hunk 头
 *  `@@ -a,b +c,d @@ <节尾上下文>` 的尾部上下文（-U0 下 git 会附节尾相邻行）被当首行
 *  计入坐标——幻影 +1 使 fm 边界附近（尤其 fm 末行插入）的合法元数据编辑被误拦
 *  （假阳性，over-blocking；实测 8 探针变体中 fm 末插行/fm 删行+插行均被误拦）。
 *  修复后坐标与 git 语义精确对齐：+行比 newFmLastLine，-行比 oldFmLastLine，
 *  -U0 下两侧坐标各自真实，插入导致的坐标平移不会让删除行逃出判定（全检报告的
 *  「删行前移逃逸」方向实测 8 变体均拦，不可复现；真正存在的是反向幻影误拦）。
 *  全检-5（终审严重 2）新增第三道闸：**闭合标记位移一致性**——head/--- 位移守恒（见下），
 *  两步攻击的 step1（把闭合 --- 移到 H1 后吞入正文）在此被拦。
 *  返回 { ok, fmDelta }；fmDelta = fm 区域内净增行数（插入-删除），供位移守恒校验。 */
function hunksWithinBounds(diffText, oldFmLastLine, newFmLastLine) {
  const hunks = [...diffText.matchAll(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/g)];
  let pos = 0;
  let fmDelta = 0; // fm 界内 +行数 - -行数（fm 净增行）
  for (const hm of hunks) {
    const hunkStartInDiff = diffText.indexOf(hm[0], pos);
    const headerLineEnd = diffText.indexOf("\n", hunkStartInDiff); // 头行行尾（跳过 @@ 后的节尾上下文后缀）
    const bodyStart = headerLineEnd === -1 ? diffText.length : headerLineEnd + 1;
    pos = bodyStart;
    const nextHunk = diffText.indexOf("\n@@", pos);
    const body = diffText.slice(bodyStart, nextHunk === -1 ? undefined : nextHunk + 1);
    let oldLine = Number(hm[1]);
    let newLine = Number(hm[3]);
    for (const raw of body.split("\n")) {
      if (raw.startsWith("+")) {
        // delta-5（空行记账）：空行同样移动边界，fmDelta 计数含空行；
        // bounds 拦截面保持只拒非空行（空行在界外不构成正文篡改信号，但边界位移必须能解释它）
        if (newLine <= newFmLastLine) fmDelta++; // 界内插入（含空行）：计入 fm 净增
        else if (raw.slice(1).trim() !== "") return { ok: false, fmDelta };
        newLine++;
      } else if (raw.startsWith("-")) {
        // 对称：界内删除（含空行）计入 fm 净减；界外仅非空行拦
        if (oldLine <= oldFmLastLine) fmDelta--;
        else if (raw.slice(1).trim() !== "") return { ok: false, fmDelta };
        oldLine++;
      } else {
        // 上下文行（-U0 下应无，防御）
        oldLine++;
        newLine++;
      }
    }
  }
  return { ok: true, fmDelta };
}

/** 全检-5（终审严重 2）：闭合标记位移一致性校验。
 *  frontmatter 闭合 --- 是行号语义的锚点，锚点自身可被移动：step1 删原闭合（行 3）+ 在
 *  正文 H1 后插新闭合（行 5）→ HEAD 边界(3)与索引边界(5)各自「真实」，所有变更行都在各自
 *  边界内 → 原判定全绿放行，但正文 H1 已被吞进 fm（渲染侧消失）。后续 commit 即可直接改写
 *  原正文，两步绕过完成。
 *  守恒律：newFmLastLine 必须 = oldFmLastLine + fmDelta（fm 内净增删行数完全解释边界位移）。
 *  位移攻击中 fm 内删 1 行（原闭合）+界外插 1 行（新闭合，不计入 fmDelta）→ oldFm(3)+(-1)=2
 *  ≠ newFm(5) → 拒绝。合法 fm 内增删行（含合法增行）恒满足守恒 → 不误伤。 */
function fmBoundaryShiftConsistent(oldFmLastLine, newFmLastLine, fmDelta) {
  return oldFmLastLine + fmDelta === newFmLastLine;
}

/** R 形态 rename 的 frontmatter 边界校验（#1257，F20261001lrbk）。
 *  rename 配对只在全量 staged diff 中呈现（pathspec 单路径过滤会抑制 rename 检测，实测坐实），
 *  故从全量 diff 提取本文件的 rename 段再解析：
 *  - similarity index 100% 且无 hunk且无 Binary 标记：纯 rename（内容零变化，文件名级元数据订正）→ 放行
 *    （#1273 严重 1：零 hunk 单独不充分——含 NUL 字节的文件 diff 呈 Binary 零 hunk，会把整段正文重写
 *    伪装成纯 rename 绕过；三者同验才放行）
 *  - 有 hunk：rename + 编辑——按 old/new 两侧 frontmatter 边界校验，正文编辑仍拦
 *  - 未匹配到 rename 配对（相似度低于阈值退化为 A+D）：宁拦（大改不是文件名订正）
 *  - 旧路径在 docs 管辖树外的 R 配对：不进本通道，退回宁拦（#1273 严重 2 跨树逃逸链封口）
 *  .doc-fix 声明在调用侧同样强制（rename 通道不是无声明后门）。 */
function checkRenameScope(oldPath, newPath, outOfScope, ctx = stagedCtx()) {
  let diff;
  try {
    diff = ctx.diffU0M();
  } catch {
    outOfScope.push(newPath);
    return;
  }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 终点：下一段段头（\n diff --git）或串尾（git() 输出被 trim，末段无尾随换行，$ 不得依赖 \n）
  const seg = diff.match(
    new RegExp(`diff --git a/${esc(oldPath)} b/${esc(newPath)}\\n[\\s\\S]*?(?:(?=\\n(?:diff --git ))|$)`)
  );
  if (!seg) {
    outOfScope.push(newPath); // rename 配对未出现（退化 A+D）→ 宁拦
    return;
  }
  const section = seg[0];
  const inDocsTree = (p) => /^docs\/(features|research)\//.test(p);
  // #1273 delta 第二轮（严重 2，r1 建议的双侧校验）：R 配对任一侧不在 docs 管辖树内即拒——
  // 「树内→树外」的移出语义=删除历史文档（step1），「树外→树内」的移入语义=来源不明（step2 回迁），
  // 都不是「文件名级元数据订正」；只查 oldPath 会漏掉移出方向（delta 复核 probeD 实测坐实）
  if (!inDocsTree(oldPath) || !inDocsTree(newPath)) {
    outOfScope.push(newPath);
    return;
  }
  const hunks = [...section.matchAll(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/g)];
  if (hunks.length === 0) {
    // #1273 delta 修复（严重 1）：零 hunk ≠ 内容零变化。git 对含 NUL 字节的文件输出
    // "Binary files ... differ"（零 hunk），二进制渲染绕过会把整段正文重写伪装成纯 rename。
    // 放行必须同时满足：显式 similarity index 100% + 无 Binary 标记 + 零 hunk。
    if (/^similarity index 100%$/m.test(section) && !/^Binary files /m.test(section)) return;
    outOfScope.push(newPath);
    return;
  }
  // F20261009hcig：ref 侧由 ctx 提供（pre-commit: HEAD:/index:；--base: commit^:/commit:）
  const oldFmLastLine = frontmatterLastLineOf(ctx.oldRef(oldPath));
  const newFmLastLine = frontmatterLastLineOf(ctx.newRef(newPath));
  if (oldFmLastLine === -1 || newFmLastLine === -1) {
    outOfScope.push(newPath); // 两侧任一无合法 frontmatter 块 → 宁拦
    return;
  }
  const r = hunksWithinBounds(section, oldFmLastLine, newFmLastLine);
  if (!r.ok || !fmBoundaryShiftConsistent(oldFmLastLine, newFmLastLine, r.fmDelta)) {
    outOfScope.push(newPath); // 界外变更或闭合标记位移不可由 fm 内增删解释（终审严重 2）
  }
}

/** 校验每个历史文档的变更行全部落在 frontmatter 块内（首个 --- 至次个 ---）。
 *  判定口径（宁拦勿放）：变更行（+/- 开头、非 +++/--- 头）trim 后非空，且行号在 frontmatter 块外 → 超出。
 *  读新版本树引用拿新 frontmatter 边界，与 -U0 diff 的 hunk 行号比对。
 *  #1257：entries 携带 name-status 元数据，R 形态 rename 走 checkRenameScope（全量 diff 解析 rename 对）。
 *  F20261009hcig：ref 侧由 ctx 提供（pre-commit: index:/HEAD:；--base: commit:/commit^:）。 */
function checkFrontmatterScope(files, entries = {}, ctx = stagedCtx()) {
  const outOfScope = [];
  for (const file of files) {
    const entry = entries[file] ?? {};
    if (entry.oldPath && entry.oldPath !== file) {
      checkRenameScope(entry.oldPath, file, outOfScope, ctx);
      continue;
    }
    const newFmLastLine = frontmatterLastLineOf(ctx.newRef(file));
    // 无合法 frontmatter 块 / 读取失败（如纯删除）→ 无法证明变更是元数据级 → 宁拦
    if (newFmLastLine === -1) { outOfScope.push(file); continue; }
    const oldFmLastLine = frontmatterLastLineOf(ctx.oldRef(file));
    // 旧版本边界——删除行用 old-side 位置判定（delta-严重 1：形状判定有洞，
    // 正文行 "Note: important" 形状像 key:value 曾被误放；纯位置判定无此洞）；
    // 旧版本读不到（理论边角）→ 宁拦
    if (oldFmLastLine === -1) { outOfScope.push(file); continue; }

    let diff;
    try {
      diff = ctx.diffU0(file);
    } catch {
      outOfScope.push(file);
      continue;
    }
    const r = hunksWithinBounds(diff, oldFmLastLine, newFmLastLine);
    if (
      !r.ok ||
      !fmBoundaryShiftConsistent(oldFmLastLine, newFmLastLine, r.fmDelta)
    ) {
      outOfScope.push(file); // 界外变更或闭合标记位移不可由 fm 内增删解释（终审严重 2）
    }
  }
  return { ok: outOfScope.length === 0, outOfScope };
}

/** 读当前变更集的 .doc-fix 声明文件（pre-commit: 索引区；--base: 该 commit 的树） */
function readDocFixDeclaration(ctx = stagedCtx()) {
  let staged;
  try {
    staged = ctx.nameOnly();
  } catch {
    return { ok: false, hint: "" };
  }
  if (!staged.split("\n").includes(".doc-fix")) {
    return { ok: false, hint: "（当前变更集无 .doc-fix 声明文件）" };
  }
  let content;
  try {
    content = ctx.docFixContent();
  } catch {
    return { ok: false, hint: "（.doc-fix 已在变更集中但读取失败）" };
  }
  const reason = content.trim();
  if (reason.length < 10) {
    return { ok: false, hint: `（.doc-fix 存在但理由不足 10 字符："${sanitize(reason)}"）` };
  }
  return { ok: true, reason };
}
