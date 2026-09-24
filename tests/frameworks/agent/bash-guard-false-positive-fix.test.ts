/**
 * F20260924gfpn：bash 守卫第四次误拦修复——git 只读白名单 + merge 负向断言 +
 * cd 检测跳过赋值前缀段 + heredoc 载荷剥离。
 *
 * 9/23 台账实证（healing_events a9260c50，《issue处理》对话 12:43–15:23 约 20 条连环拦）：
 * 历史三次修复（qbsw/glay/gr1f）只覆盖「该拦的拦住」一侧，放行侧系统性缺失。
 * 本文件是放行侧回归用例（PASS 断言）+ 拦截侧保持（BLOCKED 断言）的组合。
 */
import { describe, it, expect } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";

const mainPid = 42877;
const projectRoot = "/repo";
const opts = { projectRoot };

describe("F20260924gfpn：git merge-base 只读负向断言（#1 根因）", () => {
  // 台账实证：9/23 12:43 guard-test2/3.mjs 实测 `git merge-base main feature/x` → BLOCKED
  it("git merge-base main feature/x → 放行", () => {
    expect(checkBashCommandSafety("git merge-base main feature/x", mainPid, undefined, opts)).toBeNull();
  });

  it("git merge-base --all HEAD main → 放行", () => {
    expect(checkBashCommandSafety("git merge-base --all HEAD main", mainPid, undefined, opts)).toBeNull();
  });

  it("git merge-base HEAD origin/main → 放行", () => {
    expect(checkBashCommandSafety("git merge-base HEAD origin/main", mainPid, undefined, opts)).toBeNull();
  });

  it("git checkout -b x $(git merge-base main HEAD) → 放行（命令替换内的 merge-base）", () => {
    expect(checkBashCommandSafety("git checkout -b x $(git merge-base main HEAD)", mainPid, undefined, opts)).toBeNull();
  });

  it("git merge-base main HEAD | xargs git log --oneline -1 → 放行（管道链）", () => {
    expect(checkBashCommandSafety("git merge-base main HEAD | xargs git log --oneline -1", mainPid, undefined, opts)).toBeNull();
  });

  // 拦截侧保持：git merge（真写族）不回归
  it("git merge feature（真合并）→ 仍拦截", () => {
    expect(checkBashCommandSafety("git merge feature", mainPid, undefined, opts)).not.toBeNull();
  });

  it("git merge --no-ff feature → 仍拦截", () => {
    expect(checkBashCommandSafety("git merge --no-ff feature", mainPid, undefined, opts)).not.toBeNull();
  });

  // 同组其他词的前缀吞噬审计：commit-tree / rebase--helper / cherry / applypatch 等派生词不拦
  it("git commit-tree（plumbing 只读）→ 放行（前缀吞噬审计）", () => {
    expect(checkBashCommandSafety("git commit-tree $(git write-tree) -m x", mainPid, undefined, opts)).toBeNull();
  });

  it("git cherry（只读比较）→ 放行", () => {
    expect(checkBashCommandSafety("git cherry upstream feature", mainPid, undefined, opts)).toBeNull();
  });

  // 拦截侧保持：真写族不回归
  it("git commit -m x（未 cd）→ 仍拦截", () => {
    expect(checkBashCommandSafety("git commit -m x", mainPid, undefined, opts)).not.toBeNull();
  });

  it("git rebase main（未 cd）→ 仍拦截", () => {
    expect(checkBashCommandSafety("git rebase main", mainPid, undefined, opts)).not.toBeNull();
  });

  it("git stash push（未 cd）→ 仍拦截（写族字面判定先于白名单，防 stash 借壳）", () => {
    expect(checkBashCommandSafety("git stash push", mainPid, undefined, opts)).not.toBeNull();
  });

  it("git cherry-pick abc123（未 cd）→ 仍拦截", () => {
    expect(checkBashCommandSafety("git cherry-pick abc123", mainPid, undefined, opts)).not.toBeNull();
  });

  it("git apply /tmp/patch.diff（未 cd）→ 仍拦截", () => {
    expect(checkBashCommandSafety("git apply /tmp/patch.diff", mainPid, undefined, opts)).not.toBeNull();
  });

  // 链式绕过：白名单段 + 真写段 → 仍拦（安全红线：整条命令无其他写形态）
  it("git log --oneline -5 && git commit -m x（白名单段 + 真写段）→ 仍拦截", () => {
    expect(checkBashCommandSafety("git log --oneline -5 && git commit -m x", mainPid, undefined, opts)).not.toBeNull();
  });

  it("git log-f（前缀模糊变形，非真 git 子命令）→ 放行（守卫只管真实 git 形态）", () => {
    // git log-f 不是 git 子命令（git 会报错），守卫无写语义可拦——放行。
    // 白名单防御的是「真只读子命令被写族误吞」，不是拦截一切含 git 词元的命令。
    expect(checkBashCommandSafety("git log-f /tmp/x", mainPid, undefined, opts)).toBeNull();
  });

  // ── F20260924gfpn-r1（检视严重 F1 处置）：白名单不得旁路重定向防线 ──
  it("git log > /repo/hacked.txt（白名单子命令 + 重定向主仓）→ 仍拦截", () => {
    expect(checkBashCommandSafety("git log > /repo/hacked.txt", mainPid, undefined, opts)).not.toBeNull();
  });

  it("git show HEAD:src/a.ts > /repo/src/a.ts（白名单 + 重定向覆盖主仓文件）→ 仍拦截", () => {
    expect(checkBashCommandSafety("git show HEAD:src/a.ts > /repo/src/a.ts", mainPid, undefined, opts)).not.toBeNull();
  });

  it("git diff > /repo/docs/x.md && git status（白名单段含重定向 + 只读段）→ 仍拦截", () => {
    expect(checkBashCommandSafety("git diff > /repo/docs/x.md && git status", mainPid, undefined, opts)).not.toBeNull();
  });

  it("git log > /tmp/outside.txt（白名单 + 重定向主仓外绝对路径）→ 放行", () => {
    // 重定向目标绝对路径且在主仓外 → 不重定向防线命中（与 #1038 绝对路径豁免一致）。
    expect(checkBashCommandSafety("git log > /tmp/outside.txt", mainPid, undefined, opts)).toBeNull();
  });

  it("git log; rm -rf /repo/data（白名单段 + data 破坏）→ 仍拦截", () => {
    expect(checkBashCommandSafety("git log; rm -rf /repo/data", mainPid, undefined, opts)).not.toBeNull();
  });
});

describe("F20260924gfpn：git 只读白名单快通道（#2）", () => {
  const readonlyCases = [
    "git log --oneline origin/main -1",
    "git log --oneline -1",
    "git status",
    "git diff HEAD~1",
    "git show abc123",
    "git rev-parse HEAD",
    "git rev-list --count HEAD",
    "git branch -a",
    "git branch --show-current",
    "git blame src/foo.ts",
    "git describe --tags",
    "git ls-files",
    "git ls-remote origin",
    "git stash list",
    "git stash show",
    "git remote -v",
    "git tag -l",
    "git config --get user.name",
    "git shortlog -sn",
    "git reflog -5",
  ];
  for (const c of readonlyCases) {
    it(`${c} → 放行`, () => {
      expect(checkBashCommandSafety(c, mainPid, undefined, opts)).toBeNull();
    });
  }

  it("git log; rm -rf /repo/data（链式绕过）→ 仍拦截（整条命令无其他写形态）", () => {
    expect(checkBashCommandSafety("git log; rm -rf /repo/data", mainPid, undefined, opts)).not.toBeNull();
  });

  it("git status && git commit -m x（白名单 + 写族）→ 仍拦截", () => {
    expect(checkBashCommandSafety("git status && git commit -m x", mainPid, undefined, opts)).not.toBeNull();
  });

  // 白名单后的字面量主 PID kill 不豁免（kill 族不走白名单通道）
  it("git log | xargs kill 42877（白名单段 + 真 kill 主 PID）→ 仍拦截", () => {
    expect(checkBashCommandSafety(`git log | xargs kill ${mainPid}`, mainPid, undefined, opts)).not.toBeNull();
  });
});

describe("F20260924gfpn：cd worktree + git 写族正道（台账连环拦现场）", () => {
  // 《issue处理》15:24 大獭「卡住汇报」现场：guard-r1-fix worktree 内 commit 被连环拦
  it("cd /repo/.otter/worktrees/wt1 && git add -A && git commit -F /tmp/xx → 放行", () => {
    const cmd = "cd /repo/.otter/worktrees/wt1 && git add -A && git commit -F /tmp/commit-msg.txt";
    expect(checkBashCommandSafety(cmd, mainPid, undefined, opts)).toBeNull();
  });

  it("cd /repo/.otter/worktrees/wt1 && git commit -m x → 放行", () => {
    expect(checkBashCommandSafety("cd /repo/.otter/worktrees/wt1 && git commit -m x", mainPid, undefined, opts)).toBeNull();
  });

  it("cd worktree && git stash push → 放行", () => {
    expect(checkBashCommandSafety("cd /repo/.otter/worktrees/wt1 && git stash push", mainPid, undefined, opts)).toBeNull();
  });

  it("cd worktree && git rebase main → 放行", () => {
    expect(checkBashCommandSafety("cd /repo/.otter/worktrees/wt1 && git rebase main", mainPid, undefined, opts)).toBeNull();
  });

  it("cd worktree && git cherry-pick abc → 放行", () => {
    expect(checkBashCommandSafety("cd /repo/.otter/worktrees/wt1 && git cherry-pick abc", mainPid, undefined, opts)).toBeNull();
  });

  it("cd worktree && git apply /tmp/p.diff → 放行", () => {
    expect(checkBashCommandSafety("cd /repo/.otter/worktrees/wt1 && git apply /tmp/p.diff", mainPid, undefined, opts)).toBeNull();
  });

  // 未 cd 的 git add -A（cd 豁免只到 cd 前；git add 不在写族正则但落主仓语义——现状不拦，保持）
  it("git add -A（未 cd，add 本身不在写族判定内）→ 放行（现状保持）", () => {
    expect(checkBashCommandSafety("git add -A", mainPid, undefined, opts)).toBeNull();
  });
});

describe("F20260924gfpn：变量赋值前缀不破坏 cd 检测（#5）", () => {
  // 台账现场：`W=/path; cd $W/.otter/worktrees/x && git add -A` 被拦
  it("W=/repo; cd $W/.otter/worktrees/x && git add -A && git commit -F /tmp/xx → 放行", () => {
    const cmd = "W=/repo; cd $W/.otter/worktrees/x && git add -A && git commit -F /tmp/commit-msg.txt";
    expect(checkBashCommandSafety(cmd, mainPid, undefined, opts)).toBeNull();
  });

  it("W=/repo; cd $W && git commit -m x → 放行", () => {
    expect(checkBashCommandSafety("W=/repo; cd $W && git commit -m x", mainPid, undefined, opts)).toBeNull();
  });

  it("FOO=1 BAR=2; cd /wt && git commit -m x（多赋值前缀）→ 放行", () => {
    expect(checkBashCommandSafety("FOO=1 BAR=2; cd /wt && git commit -m x", mainPid, undefined, opts)).toBeNull();
  });

  it("FOO=1 git commit -m x（赋值前缀但无 cd）→ 仍拦截（写族字面判定不受赋值前缀影响）", () => {
    expect(checkBashCommandSafety("FOO=1 git commit -m x", mainPid, undefined, opts)).not.toBeNull();
  });

  it("FOO=1; git commit -m x（赋值独立段，无 cd）→ 仍拦截", () => {
    expect(checkBashCommandSafety("FOO=1; git commit -m x", mainPid, undefined, opts)).not.toBeNull();
  });
});

describe("F20260924gfpn：python3 heredoc 载荷剥离（#4，失败代价放大器修复）", () => {
  // 台账现场：测试用例文本里含 kill 字样被当真实终止命令（abort 整个 invoke + 重试刷屏）。
  // 语义边界：heredoc 是 python 的 stdin 数据通道——`python3 - <<EOF` 本身是主仓写形态
  // （patch 语义静态不可分），守卫对该命令头保守拦；但 cd worktree 后（落点即 worktree）
  // 载荷体内 kill 字样数据不得再触发 cmdLevel 拦截——这才是台账连环拦的失效层。
  it("cd /wt && python3 - <<EOF（载荷含 kill 字样测试文本）→ 放行", () => {
    const cmd = 'cd /wt && python3 - <<EOF\nimport subprocess\n# test: kill 12345 signal handling\nprint("ok")\nEOF';
    expect(checkBashCommandSafety(cmd, mainPid, undefined, opts)).toBeNull();
  });

  it("cd /wt && python3 - <<'EOF'（引号定界符形态 + kill 字样）→ 放行", () => {
    const cmd = "cd /wt && python3 - <<'EOF'\nimport os\n# kill 99999 comment\nprint('done')\nEOF";
    expect(checkBashCommandSafety(cmd, mainPid, undefined, opts)).toBeNull();
  });

  it("cd /wt && python3 - <<\"EOF\"（双引号定界符形态 + kill 字样）→ 放行", () => {
    const cmd = 'cd /wt && python3 - <<"EOF"\nx = "kill 55555 text"\nprint(x)\nEOF';
    expect(checkBashCommandSafety(cmd, mainPid, undefined, opts)).toBeNull();
  });

  it("cd /wt && python3 - <<EOF（载荷含 pkill 字样）→ 放行", () => {
    const cmd = 'cd /wt && python3 - <<EOF\n# pkill otter-buddy in test fixture text\npass\nEOF';
    expect(checkBashCommandSafety(cmd, mainPid, undefined, opts)).toBeNull();
  });

  it("cd /wt && python3 - <<EOF（载荷含 eval 字样）→ 放行", () => {
    const cmd = 'cd /wt && python3 - <<EOF\n# eval bypass notes\npass\nEOF';
    expect(checkBashCommandSafety(cmd, mainPid, undefined, opts)).toBeNull();
  });

  it("cd /wt && python3 - <<EOF（载荷含项目路径词元）→ 放行", () => {
    const cmd = 'cd /wt && python3 - <<EOF\nimport json\nd = json.load(open("/repo/data/workspaces/abc/x.json"))\nprint(d)\nEOF';
    expect(checkBashCommandSafety(cmd, mainPid, undefined, opts)).toBeNull();
  });

  // heredoc 命令头是主仓写形态（未 cd 时落主仓）——静态保守拦是对的（不放行侧）
  it("python3 - <<EOF（未 cd，命令头即写形态）→ 仍拦截", () => {
    const cmd = 'python3 - <<EOF\nimport subprocess\n# test: kill 12345 signal handling\nprint("ok")\nEOF';
    expect(checkBashCommandSafety(cmd, mainPid, undefined, opts)).not.toBeNull();
  });

  // cd worktree 后未闭合 heredoc 载荷含 kill 字样：cd 豁免判定在最前（落点即 worktree），
  // 豁免后 kill 检测不再跑——与 F20260923glay「cd 豁免优先于脚本 one-liner 载荷字符串规则」
  // 同型（bash-guard-layered-detect.test.ts 已有 `cd wt && node -e kill 字样` 放行固例）。
  // 即：cd 是正道的根豁免，危险载荷检测只管「未 cd（落点主仓）」形态。
  it("cd /wt && python3 - <<EOF（未闭合，载荷含 kill 字样 + 数字）→ 放行（cd 豁免优先）", () => {
    const cmd = 'cd /wt && python3 - <<EOF\nimport os\nos.kill(42877, 9)';
    expect(checkBashCommandSafety(cmd, mainPid, undefined, opts)).toBeNull();
  });

  // 纯未闭合 heredoc（无 kill 字样）在 cd 豁免下放行——fail-closed 只针对含危险词元的载荷
  it("cd /wt && python3 - <<EOF（未闭合但载荷无危险词元）→ 放行（cd 豁免优先）", () => {
    const cmd = 'cd /wt && python3 - <<EOF\nimport json\nprint("ok")';
    expect(checkBashCommandSafety(cmd, mainPid, undefined, opts)).toBeNull();
  });

  // cd worktree 后真 patch 仍执行（守卫不管 python 运行时语义）——但真在主仓 patch 未 cd 拦
  it("python3 - <<EOF（真 patch 主仓文件，未 cd）→ 仍拦截", () => {
    const cmd = 'python3 - <<EOF\nwith open("src/foo.ts", "w") as f: f.write("x")\nEOF';
    expect(checkBashCommandSafety(cmd, mainPid, undefined, opts)).not.toBeNull();
  });
});

describe("F20260924gfpn：node -e 载荷字符串剥离（#4 延伸）", () => {
  // glay 已让 node -e 字符串里的 > | & 不误触重定向判定；本组补 kill 字样数据。
  // node -e 是脚本 one-liner 读形态（非写形态），未 cd 也不落主仓——但与 heredoc 不同，
  // 它不命中 python heredoc 写族正则，因此未 cd 也应放行（现状 glay 语义保持）。
  it("node -e（载荷字符串含 kill 字样测试文本）→ 仍拦截（glay 保守拦语义不回退）", () => {
    // glay 固化语义：node -e 字符串内 kill 字样 + 数字保守拦（cmdLevel 脚本 one-liner）。
    // 分析脚本要绕开：写成 .mjs 文件（node scripts/x.mjs）或 cd worktree 后跑，不走 one-liner。
    // 台账连环拦的解决路径是「载荷整体剥离防误触主仓写」+「kill 检测看原文」，
    // node -e 的 kill 字样保守拦是既定取舍（本测试固化防误放行）。
    const cmd = 'node -e \'const t = "kill 12345 fixture"; console.log(t)\'';
    expect(checkBashCommandSafety(cmd, mainPid, undefined, opts)).not.toBeNull();
  });

  it("node -e（载荷字符串含项目路径）→ 放行", () => {
    const cmd = 'node -e \'const p = "/repo/data/workspaces/abc/x.json"; console.log(p)\'';
    expect(checkBashCommandSafety(cmd, mainPid, undefined, opts)).toBeNull();
  });

  it("node -e（载荷字符串含 kill 但无数字）→ 放行（kill 检测需数字条件）", () => {
    // cmdLevel 脚本 one-liner 规则要求 kill 词元 + 数字（2-6 位）同现；纯 kill 字样无数字不放行也不拦。
    const cmd = 'node -e \'const t = "kill signal handling"; console.log(t)\'';
    expect(checkBashCommandSafety(cmd, mainPid, undefined, opts)).toBeNull();
  });

  // 拦截侧保持：process.kill 调用位仍拦（glay 语义不回退）
  it("node -e process.kill(42877)（真调用）→ 仍拦截", () => {
    expect(checkBashCommandSafety('node -e "process.kill(42877)"', mainPid, undefined, opts)).not.toBeNull();
  });

  it("node -e 载荷含 kill + 数字（保守拦语义不回退）→ 仍拦截", () => {
    // 与 glay 固化语义一致：字符串内 kill 字样 + 数字保守拦（测试固化防误放行）
    expect(checkBashCommandSafety('node -e "console.log(\'kill 12345\')"', mainPid, undefined, opts)).not.toBeNull();
  });
});

describe("F20260924gfpn：gh issue create --body 含项目路径（台账现场）", () => {
  it("gh issue create --body 含 /repo/data/workspaces/ 路径 → 放行", () => {
    const cmd = 'gh issue create --title "x" --body "现场：/repo/data/workspaces/abc/x.json 的内容"';
    expect(checkBashCommandSafety(cmd, mainPid, undefined, opts)).toBeNull();
  });

  it("gh issue create --body 含 worktree 路径 → 放行", () => {
    const cmd = 'gh issue create --title "x" --body "worktree：/repo/.otter/worktrees/wt1"';
    expect(checkBashCommandSafety(cmd, mainPid, undefined, opts)).toBeNull();
  });

  it("gh issue create --body 含 kill 字样 + 项目路径 → 放行（#858 脱敏管道）", () => {
    const cmd = 'gh issue create --title "x" --body "复现：kill 12345 后 /repo/data 状态异常"';
    expect(checkBashCommandSafety(cmd, mainPid, undefined, opts)).toBeNull();
  });
});

describe("F20260924gfpn：拦截侧总回归（该拦的仍拦）", () => {
  it("kill <mainPid> → 拦截", () => {
    expect(checkBashCommandSafety(`kill ${mainPid}`, mainPid, undefined, opts)).not.toBeNull();
  });

  it("git commit 未 cd → 拦截", () => {
    expect(checkBashCommandSafety("git commit -m x", mainPid, undefined, opts)).not.toBeNull();
  });

  it("git merge-base（无 projectRoot 保守退化）→ 仍放行（纯只读语义不变）", () => {
    expect(checkBashCommandSafety("git merge-base main HEAD", mainPid)).toBeNull();
  });

  it("git merge feature（无 projectRoot）→ 放行（与既有保守降级语义一致）", () => {
    // projectRoot 缺失时 checkMainCheckoutWrite 整体保守放行（F20260922scwd 锁定语义）。
    expect(checkBashCommandSafety("git merge feature", mainPid)).toBeNull();
  });

  it("git commit -m x（无 projectRoot）→ 放行（与既有保守降级语义一致）", () => {
    // 既有 F20260922scwd 用例「projectRoot 缺失时主仓写命令 → 放行（保守降级）」锁定的语义：
    // 写族判定依赖 projectRoot（cd 豁免/落点解析），缺失时整体放行。
    expect(checkBashCommandSafety("git commit -m x", mainPid)).toBeNull();
  });

  it("eval kill → 拦截", () => {
    expect(checkBashCommandSafety('eval "kill 42877"', mainPid, undefined, opts)).not.toBeNull();
  });

  it("pkill -f otter-buddy → 拦截", () => {
    expect(checkBashCommandSafety("pkill -f otter-buddy", mainPid, undefined, opts)).not.toBeNull();
  });

  it("bash -c 'kill 42877' → 拦截", () => {
    expect(checkBashCommandSafety("bash -c 'kill 42877'", mainPid, undefined, opts)).not.toBeNull();
  });

  it("kill $(lsof -ti :3102) → 拦截", () => {
    expect(checkBashCommandSafety("kill $(lsof -ti :3102)", mainPid, undefined, opts)).not.toBeNull();
  });

  it("rm -rf /repo/data → 拦截", () => {
    expect(checkBashCommandSafety("rm -rf /repo/data", mainPid, undefined, opts)).not.toBeNull();
  });

  it("echo x > file.txt（未 cd 重定向主仓）→ 拦截", () => {
    expect(checkBashCommandSafety("echo x > file.txt", mainPid, undefined, opts)).not.toBeNull();
  });
});
