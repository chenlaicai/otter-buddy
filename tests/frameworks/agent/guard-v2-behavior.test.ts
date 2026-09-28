/**
 * F20260928grv2 V2 行为变化白名单测试 + V9 已知误拦形态回归。
 *
 * 双向锁（搭档拍板）：
 * - 白名单内新拦：kill 0（U1/#1169）、bash <file> / bash file.sh（U5）
 * - 白名单内放行（以前误拦）：#1170 管道/分号杀 cd 豁免、#1171 引号/heredoc 词样、
 *   $VAR 传参、V9 全部已知误拦形态
 * - 白名单外零变化：由 bash-safety-guard.test.ts 234 用例承担（V1 红绿双向）
 */
import { describe, expect, it } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";

const mainPid = 42877;

describe("V2 白名单新拦项（U1/U5——搭档拍板）", () => {
  describe("U1：kill 0 进程组语义（#1169）", () => {
    it("bash -c 'kill 0' 载荷内 kill 0 → 拦（进程组信号覆盖含主进程的整组）", () => {
      const r = checkBashCommandSafety("bash -c 'nohup kill 0'", mainPid);
      expect(r).toContain("进程组");
    });
    it("裸 kill 0 → 拦", () => {
      const r = checkBashCommandSafety("kill 0", mainPid);
      expect(r).toContain("进程组");
    });
    it("kill 00 前导零形态 → 拦（八进制/十进制同义）", () => {
      const r = checkBashCommandSafety("kill 00", mainPid);
      expect(r).toContain("进程组");
    });
    it("kill -9 0 → 拦", () => {
      const r = checkBashCommandSafety("kill -9 0", mainPid);
      expect(r).toContain("进程组");
    });
    it("对照：kill 12345（无关 PID）→ 放行", () => {
      expect(checkBashCommandSafety("kill 12345", mainPid)).toBeNull();
    });
  });

  describe("U5：bash 从文件读脚本（保守拦+提示改写）", () => {
    it("bash < file.sh → 拦", () => {
      const r = checkBashCommandSafety("bash < deploy.sh", mainPid);
      expect(r).toContain("从文件读取脚本");
    });
    it("sh < x.sh → 拦", () => {
      const r = checkBashCommandSafety("sh < check.sh", mainPid);
      expect(r).toContain("从文件读取脚本");
    });
    it("bash file.sh 位置参数形态 → 拦", () => {
      const r = checkBashCommandSafety("bash run.sh", mainPid);
      expect(r).toContain("从文件读取脚本");
    });
    it("对照：bash -c 'echo hi'（-c 载荷已由模型递归判定）→ 放行", () => {
      expect(checkBashCommandSafety("bash -c 'echo hi'", mainPid)).toBeNull();
    });
  });
});

describe("V2 白名单放行项（#1170/#1171 误拦归零）", () => {
  describe("#1170：管道/分号不再杀死 cd 豁免（真实误拦现场形态）", () => {
    it("cd worktree && git commit -m x | tail -3 → 放行（#1170 主形态）", () => {
      const r = checkBashCommandSafety("cd /Users/orca/ai/otter-buddy/.otter/worktrees/wt1 && git commit -m 'x' | tail -3", mainPid, undefined, { projectRoot: "/Users/orca/ai/otter-buddy" });
      expect(r).toBeNull();
    });
    it("cd worktree && cmd 2>&1 | cat → 放行", () => {
      const r = checkBashCommandSafety("cd /Users/orca/ai/otter-buddy/.otter/worktrees/wt1 && npx tsc --noEmit 2>&1 | cat", mainPid, undefined, { projectRoot: "/Users/orca/ai/otter-buddy" });
      expect(r).toBeNull();
    });
    it("cd worktree && cmd; git status → 放行", () => {
      const r = checkBashCommandSafety("cd /Users/orca/ai/otter-buddy/.otter/worktrees/wt1 && npm test; git status", mainPid, undefined, { projectRoot: "/Users/orca/ai/otter-buddy" });
      expect(r).toBeNull();
    });
    it("cd worktree | tail 形态（管道在 cd 段后）→ 放行", () => {
      const r = checkBashCommandSafety("cd /Users/orca/ai/otter-buddy/.otter/worktrees/wt1 && git log --oneline -20 | tail -5", mainPid, undefined, { projectRoot: "/Users/orca/ai/otter-buddy" });
      expect(r).toBeNull();
    });
  });

  describe("#1171：引号/heredoc 内 kill 词样字面量 → 放行", () => {
    it("sed 替换串内词样 → 放行", () => {
      expect(checkBashCommandSafety("sed 's/pkill -f otter/REDACTED/g' log.txt > out.txt", mainPid)).toBeNull();
    });
    it("测试代码字符串内词样（grep 检索）→ 放行", () => {
      expect(checkBashCommandSafety("grep -rn 'kill 42877' tests/ | head -5", mainPid)).toBeNull();
    });
    it("echo 上下文进程名词样 → 放行", () => {
      expect(checkBashCommandSafety("echo 'the pkill was blocked yesterday' >> notes.md", mainPid)).toBeNull();
    });
    it("gh --body-file 引用文本内词样 → 放行（#858 现场形态）", () => {
      expect(checkBashCommandSafety("gh pr review 123 --body-file /tmp/review.md", mainPid)).toBeNull();
    });
    it("引号定界 heredoc 正文词样 → 放行（9/3 事故现场）", () => {
      const cmd = "cat > /tmp/review.md << 'REVIEW_EOF'\n## skill 守卫分析\n结论：拦截文案里含 pkill 词样\nREVIEW_EOF";
      expect(checkBashCommandSafety(cmd, mainPid)).toBeNull();
    });
    it("裸定界 heredoc 正文纯数据词样（无展开）→ 放行（#1171 主形态）", () => {
      const cmd = "cat > /tmp/notes.md <<EOF\n历史记录：曾用 pkill -f node 清理僵尸\nEOF";
      expect(checkBashCommandSafety(cmd, mainPid)).toBeNull();
    });
  });

  describe("V9：已知真实误拦形态全量回归（搭档关切「拦的程度」）", () => {
    it("worktree 路径字样命令（含 otter-buddy）→ 放行", () => {
      expect(checkBashCommandSafety("ls /Users/orca/ai/otter-buddy/.otter/worktrees/", mainPid)).toBeNull();
    });
    it("cd worktree + echo 重定向（相对路径）→ 放行", () => {
      const r = checkBashCommandSafety("cd /Users/orca/ai/otter-buddy/.otter/worktrees/wt1 && echo done > status.txt", mainPid, undefined, { projectRoot: "/Users/orca/ai/otter-buddy" });
      expect(r).toBeNull();
    });
    it("W=worktree; cd $W && git push（赋值+变量 cd）→ 放行", () => {
      const r = checkBashCommandSafety("W=/Users/orca/ai/otter-buddy/.otter/worktrees/wt1; cd $W && git push origin HEAD", mainPid, undefined, { projectRoot: "/Users/orca/ai/otter-buddy" });
      expect(r).toBeNull();
    });
    it("echo '...' >> 绝对路径 data/workspaces/...（工作区 sandbox，F20260923hsyn）→ 放行", () => {
      const r = checkBashCommandSafety("echo log >> /Users/orca/ai/otter-buddy/data/workspaces/abc123/note.md", mainPid, undefined, { projectRoot: "/Users/orca/ai/otter-buddy" });
      expect(r).toBeNull();
    });
    it("python heredoc 写测试文件（词样在载荷内但无终止语义）→ 放行", () => {
      const cmd = "python3 - <<'PYEOF'\ncontent = open('/tmp/x.md').read().replace('kWilla', 'kWilla')\nopen('/tmp/y.md','w').write(content)\nPYEOF";
      expect(checkBashCommandSafety(cmd, mainPid)).toBeNull();
    });
  });
});

describe("V2 拦截面不回归（模型层核心攻击面）", () => {
  it("kill 主 PID 直击 → 拦", () => {
    expect(checkBashCommandSafety("kill 42877", mainPid)).toContain("主进程");
  });
  it("ki''ll 拼接（归一化语义由模型 evaluated 承担）→ 拦", () => {
    expect(checkBashCommandSafety("ki''ll 42877", mainPid)).toContain("主进程");
  });
  it("k\\ill 转义拼接 → 拦", () => {
    expect(checkBashCommandSafety("k\\ill 42877", mainPid)).toContain("主进程");
  });
  it("kill $((42877)) 算术展开 → 拦", () => {
    expect(checkBashCommandSafety("kill $((42877))", mainPid)).toContain("无法判断");
  });
  it("bash -c 'nohup kill $0' 主PID（#1154 N1）→ 拦", () => {
    expect(checkBashCommandSafety("bash -c 'nohup kill $0' 42877", mainPid)).toContain("主进程");
  });
  it("bash -c 'kill $@' 主PID（r3 S1-r2）→ 拦", () => {
    expect(checkBashCommandSafety("bash -c 'nohup kill $@' 42877", mainPid)).toContain("主进程");
  });
  it("bash -c 'kill ${0}' 主PID（花括号形态）→ 拦", () => {
    expect(checkBashCommandSafety("bash -c 'nohup kill ${0}' 42877", mainPid)).toContain("主进程");
  });
  it("pkill -f otter-buddy → 拦", () => {
    expect(checkBashCommandSafety("pkill -f otter-buddy", mainPid)).toContain("批量终止");
  });
  it("bash -c 'pkill -f otter-buddy'（载荷内）→ 拦", () => {
    expect(checkBashCommandSafety("bash -c 'pkill -f otter-buddy'", mainPid)).toContain("批量终止");
  });
  it("kill $(cat .otter-buddy.pid) → 拦", () => {
    expect(checkBashCommandSafety("kill $(cat .otter-buddy.pid)", mainPid)).toBeTruthy();
  });
  it("(kill 42877) 子 shell → 拦", () => {
    expect(checkBashCommandSafety("(kill 42877)", mainPid)).toBeTruthy();
  });
  it("echo 'kill 42877' | sh → 拦（管道到 shell）", () => {
    expect(checkBashCommandSafety("echo 'kill 42877' | sh", mainPid)).toBeTruthy();
  });
  it("lsof | xargs kill → 拦（stdin 来源间接）", () => {
    expect(checkBashCommandSafety("lsof -t -i :3100 | xargs kill", mainPid)).toBeTruthy();
  });
  it("decoy 载荷遮蔽（#1154 S2）→ 拦", () => {
    expect(checkBashCommandSafety("bash -c 'nohup kill 1' 2>/dev/null; bash -c 'pkill -f otter-buddy'", mainPid)).toBeTruthy();
  });
  it("kill $$ → 拦（间接 var part）", () => {
    expect(checkBashCommandSafety("kill $$", mainPid)).toBeTruthy();
  });
});
