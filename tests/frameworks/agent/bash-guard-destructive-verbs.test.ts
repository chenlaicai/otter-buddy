/**
 * F20261016gdfv（M-c78df9d4 + issue #1522）：破坏/写词表补齐族——rm 族破坏面 prod 洞
 * （rm -rf 主仓根/内容树 X1/X2 双层反判）+ git stash 写族子命令双层放行（pop/apply/drop/
 * clear/store/branch 真写面）+ find -delete 双层放行。两侧（prod gate / wv 判词层）同口径，
 * 修复的一侧与不能误伤的一侧都钉死（#1519 血泪教训）。
 */
import { describe, it, expect } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";
import { evaluateWriteVerdict } from "@frameworks/agent/write-verdict";

const projectRoot = "/repo";
const sessionCwd = "/repo/data/workspaces/conv-1";
const prod = (cmd: string) => checkBashCommandSafety(cmd, 42877, undefined, { projectRoot, sessionCwd });
const wv = (cmd: string) => evaluateWriteVerdict(cmd, projectRoot, sessionCwd);
const wvMain = (cmd: string) => evaluateWriteVerdict(cmd, projectRoot, projectRoot);

describe("F20261016gdfv rm 族破坏面 prod 补齐（M-c78df9d4）", () => {
  it("拦截侧：主仓根/内容树破坏面双链同判（X1/X2 反判面收口）", () => {
    expect(prod(`rm -rf /repo`)).toBeTruthy();
    expect(prod(`rm -rf /repo/src`)).toBeTruthy();
    expect(wv(`rm -rf /repo`).verdict).toBe("BLOCK");
    expect(wv(`rm -rf /repo/src`).verdict).toBe("BLOCK");
  });

  it("拦截侧：cd 跟踪形态（相对目标解析进主仓内容树）照拦", () => {
    expect(prod(`cd /repo && rm -rf src`)).toBeTruthy();
  });

  it("拦截侧：mv 双端——源被移走 / 移入主仓都是破坏面", () => {
    expect(prod(`mv /repo/src /tmp/x`)).toBeTruthy(); // 源保护（prod-strict，wv 只判目标）
    expect(prod(`mv /tmp/x /repo/y`)).toBeTruthy(); // 目标与 wv 同判
    expect(wv(`mv /tmp/x /repo/y`).verdict).toBe("BLOCK");
  });

  it("拦截侧：find -delete 双层补齐（此前双层放行）", () => {
    expect(prod(`find /repo -name x -delete`)).toBeTruthy();
    expect(wvMain(`find /repo -name x -delete`).verdict).toBe("BLOCK");
  });

  it("放行侧：运行时区/工作区/外部路径不误伤（与 wv pathWithinMain 同口径）", () => {
    expect(prod(`rm -rf /repo/.otter/worktrees/foo`)).toBeNull();
    expect(prod(`rm -rf /repo/.otter/workforms/bar`)).toBeNull();
    expect(prod(`rm -rf data`)).toBeNull(); // 工作区 cwd 清自己缓存（10/14 三连误拦实证）
    expect(prod(`rm -f file.txt`)).toBeNull();
    expect(prod(`rm -rf /tmp/x`)).toBeNull();
    expect(prod(`rm -f /repo/data/workspaces/conv-1/a.md`)).toBeNull(); // 本会话工作区子树豁免
    expect(prod(`find /repo/.otter/worktrees/wt -name tmp -delete`)).toBeNull(); // worktree 清理正道
    expect(prod(`find /repo -name x`)).toBeNull(); // find 读形态不入账
    expect(wv(`find /repo -name x`).verdict).toBe("ALLOW");
  });

  it("守恒：data/ 面既有文案与语义不动（9/17 事故面）", () => {
    const r = prod(`rm -rf /repo/data`);
    expect(r).toContain("主仓 data/");
  });
});

describe("F20261016gdfv stash 写族子命令收编（#1522）", () => {
  it("拦截侧：pop/apply/drop/clear/store/branch 真写面双层收编（此前双层放行）", () => {
    for (const c of [`git stash pop`, `git stash apply`, `git stash drop`, `git stash clear`, `git stash store x`, `git stash branch b`]) {
      expect(prod(c), c).toBeTruthy();
    }
    // wv main-cwd 形态落点入账（检视獭1519 delta 探针同款口径）
    for (const c of [`git stash pop`, `git stash drop`]) {
      expect(wvMain(c).verdict, c).toBe("BLOCK");
    }
  });

  it("拦截侧：wrapper / 子壳 / -C 形态同愈（等价性不变量）", () => {
    expect(prod(`git --no-pager stash pop`)).toBeTruthy();
    expect(prod(`(git stash pop)`)).toBeTruthy();
    expect(prod(`git -C /repo stash pop`)).toBeTruthy();
    expect(wv(`git -C /repo stash pop`).verdict).toBe("BLOCK");
  });

  it("放行侧：list/show/create 只读面双层不误伤", () => {
    for (const c of [`git stash list`, `git stash show stash@{0}`, `git stash create`]) {
      expect(prod(c), c).toBeNull();
      expect(wv(c).verdict, c).toBe("ALLOW");
    }
  });

  it("守恒：bare/push 既有写面判定不动（F20261016gwr1 第四对不变量）", () => {
    expect(prod(`git stash`) === null).toBe(prod(`git stash push`) === null);
    expect(prod(`git stash`)).toBeTruthy();
    expect(wvMain(`git stash`).verdict).toBe("BLOCK");
  });
});
