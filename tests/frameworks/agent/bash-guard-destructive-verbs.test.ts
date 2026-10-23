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

describe("M-48ac4e39 find -exec 执行体破坏词表补齐（单 B）", () => {
  it("拦截侧：-exec 破坏动词双层同判（B1/B2：\\; 终结 + + 终结）", () => {
    expect(prod(`find /repo/data -name x -exec rm {} \\;`)).toBeTruthy();
    expect(prod(`find /repo/data -name x -exec rm -rf {} +`)).toBeTruthy();
    expect(wvMain(`find /repo/data -name x -exec rm {} \\;`).verdict).toBe("BLOCK");
    expect(wvMain(`find /repo/data -name x -exec rm -rf {} +`).verdict).toBe("BLOCK");
  });
  it("拦截侧：-execdir（B5）与 -exec mv 移走主仓内容（B6）", () => {
    expect(prod(`find /repo/data -name x -execdir rm {} \\;`)).toBeTruthy();
    expect(prod(`find /repo/data -name x -exec mv {} /tmp/ \\;`)).toBeTruthy();
    expect(wvMain(`find /repo/data -name x -execdir rm {} \\;`).verdict).toBe("BLOCK");
    expect(wvMain(`find /repo/data -name x -exec mv {} /tmp/ \\;`).verdict).toBe("BLOCK");
  });
  it("拦截侧：无-name 形态（B7）与执行体路径形动词", () => {
    expect(prod(`find /repo/data -exec rm {} \\;`)).toBeTruthy();
    expect(prod(`find /repo -name x -exec /bin/rm {} \\;`)).toBeTruthy();
    expect(wvMain(`find /repo/data -exec rm {} \\;`).verdict).toBe("BLOCK");
    expect(wvMain(`find /repo -name x -exec /bin/rm {} \\;`).verdict).toBe("BLOCK");
  });
  it("拦截侧：载荷内形态同愈（复用 checkDataDirDestructive 通道）", () => {
    expect(prod(`bash -c 'find /repo/data -exec rm {} \\;'`)).toBeTruthy();
  });
  it("放行侧：读形态/非破坏执行体/外部根/worktree 清理正道不误伤", () => {
    expect(prod(`find /repo -name x`)).toBeNull();
    expect(prod(`find /repo -name x -exec cat {} \\;`)).toBeNull();
    expect(prod(`find /tmp -name x -exec rm {} \\;`)).toBeNull();
    expect(prod(`find /repo/.otter/worktrees/wt -name tmp -exec rm {} \\;`)).toBeNull(); // worktree 清理正道（与 -delete 钉同待遇）
    expect(wv(`find /tmp -name x -exec rm {} \\;`).verdict).toBe("ALLOW");
    expect(wvMain(`find /repo -name x -exec cat {} \\;`).verdict).toBe("ALLOW");
  });
  it("守恒：-delete 既有面不动（F20261016gdfv 钉）", () => {
    expect(prod(`find /repo -name x -delete`)).toBeTruthy();
    expect(prod(`find /repo/.otter/worktrees/wt -name tmp -delete`)).toBeNull();
    expect(wvMain(`find /repo -name x -delete`).verdict).toBe("BLOCK");
  });
});

describe("M-48ac4e39 delta（检视獭1630）：-ok 同族 + wrapper 对称 + 引号整词对齐", () => {
  it("严重1：-ok/-okdir 执行体破坏词表双层收编（交互确认可 echo y 喂答绕过）", () => {
    expect(prod(`find /repo/data -name x -ok rm {} \\;`)).toBeTruthy();
    expect(prod(`find /repo/data -name x -okdir rmdir {} \\;`)).toBeTruthy();
    expect(prod(`echo y | find /repo/data -ok rm {} \\;`)).toBeTruthy(); // 喂答绕过交互确认，破坏力与 -exec 等价
    expect(wvMain(`find /repo/data -name x -ok rm {} \\;`).verdict).toBe("BLOCK");
    expect(wvMain(`find /repo/data -name x -okdir rmdir {} \\;`).verdict).toBe("BLOCK");
    expect(wvMain(`echo y | find /repo/data -ok rm {} \\;`).verdict).toBe("BLOCK");
  });
  it("建议2：执行体 wrapper 剥除对称延伸（与直挂 env rm 同判，WRAPPER_SPECS 同基座）", () => {
    expect(prod(`find /repo/data -name x -exec env rm {} \\;`)).toBeTruthy();
    expect(prod(`find /repo/data -name x -exec env -i rm {} \\;`)).toBeTruthy();
    expect(prod(`find /repo/data -name x -ok nice rm {} \\;`)).toBeTruthy();
    expect(prod(`find /repo/data -name x -exec timeout 5 rm {} \\;`)).toBeTruthy();
    expect(wvMain(`find /repo/data -name x -exec env rm {} \\;`).verdict).toBe("BLOCK");
    expect(wvMain(`find /repo/data -name x -exec env -i rm {} \\;`).verdict).toBe("BLOCK");
    expect(wvMain(`find /repo/data -name x -ok nice rm {} \\;`).verdict).toBe("BLOCK");
    expect(wvMain(`find /repo/data -name x -exec timeout 5 rm {} \\;`).verdict).toBe("BLOCK");
  });
  it("建议3：引号整词动词双层同判（'mv -f' 无效程序名亦破坏意图，fail-closed）", () => {
    expect(prod(`find /repo/data -name x -exec 'mv -f' {} \\;`)).toBeTruthy();
    expect(prod(`find /repo/data -name x -exec 'rm' {} \\;`)).toBeTruthy();
    expect(wvMain(`find /repo/data -name x -exec 'mv -f' {} \\;`).verdict).toBe("BLOCK");
    expect(wvMain(`find /repo/data -name x -exec 'rm' {} \\;`).verdict).toBe("BLOCK");
  });
  it("放行侧：数据位/非破坏执行体/wrapper+非破坏动词不误伤", () => {
    expect(prod(`find /repo -name '-exec rm'`)).toBeNull(); // -name 参数值是数据位（引号整词单 token），词位判定不触发
    expect(prod(`find /repo -name x -ok echo {} \\;`)).toBeNull();
    expect(prod(`find /repo -name x -exec env cat {} \\;`)).toBeNull();
    expect(wvMain(`find /repo -name '-exec rm'`).verdict).toBe("ALLOW");
    expect(wvMain(`find /repo -name x -ok echo {} \\;`).verdict).toBe("ALLOW");
    expect(wvMain(`find /repo -name x -exec env cat {} \\;`).verdict).toBe("ALLOW");
  });
});
