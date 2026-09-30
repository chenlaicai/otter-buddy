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
    it("r1-S3：bash < x.txt（换扩展名绕过）→ 拦（任意文件）", () => {
      expect(checkBashCommandSafety("bash < x.txt", mainPid)).toContain("从文件读取脚本");
      expect(checkBashCommandSafety("bash data.bin", mainPid)).toContain("从文件读取脚本");
    });
    it("r1-S3：bash $SCRIPT（不可求值位置参数）→ 拦（展开后可能是文件）", () => {
      expect(checkBashCommandSafety("bash $SCRIPT", mainPid)).toContain("从文件读取脚本");
    });
    it("对照：bash -c 'echo hi'（-c 载荷已由模型递归判定）→ 放行", () => {
      expect(checkBashCommandSafety("bash -c 'echo hi'", mainPid)).toBeNull();
    });
  });

  describe("r1-S1：kill${IFS} 形态（IFS 展开重分词）", () => {
    it("kill${IFS}42877 → 拦（间接目标——V1 归一化同口径）", () => {
      expect(checkBashCommandSafety("kill${IFS}42877", mainPid)).toBeTruthy();
    });
    it("kill${IFS}0 → 拦（U1 击穿面闭合）", () => {
      const r = checkBashCommandSafety("kill${IFS}0", mainPid);
      expect(r).toBeTruthy();
    });
    it("对照：ki${IFS}ll 42877（中缀形态）→ 放行（V1 同口径）", () => {
      expect(checkBashCommandSafety("ki${IFS}ll 42877", mainPid)).toBeNull();
    });
  });

  describe("r1-S2：裸定界 heredoc body 数据行", () => {
    it("裸定界 + body 无展开：kill 独立成行等数据词样 → 放行（V1 剥离语义对齐）", () => {
      const cmd = "cat > /tmp/notes.md <<EOF\n历史记录：曾用 pkill -f node 清理\n另一行：kill 42877 是测试词样\nEOF";
      expect(checkBashCommandSafety(cmd, mainPid)).toBeNull();
    });
    it("裸定界 + body 含展开（$）：危险通道 → 递归判定", () => {
      const cmd = "bash <<EOF\nkill $((1+1))\nEOF";
      expect(checkBashCommandSafety(cmd, mainPid)).toBeTruthy();
    });
  });

  describe("r1-S5：裸 sleep 静默检测（#1126 协同）", () => {
    it("sleep 30 → 拦（≥5s 静默，引导 wait 工具）", () => {
      const r = checkBashCommandSafety("sleep 30", mainPid);
      expect(r).toContain("wait");
    });
    it("sleep 1h → 拦", () => {
      expect(checkBashCommandSafety("sleep 1h", mainPid)).toBeTruthy();
    });
    it("sleep infinity → 拦", () => {
      expect(checkBashCommandSafety("sleep infinity", mainPid)).toBeTruthy();
    });
    it("对照：sleep 3（<5s 重试抖动）→ 放行", () => {
      expect(checkBashCommandSafety("sleep 3", mainPid)).toBeNull();
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

describe("#1207 + #760 A4：xargs 多参数 wrapper 剥除不完整致管道右段漏拦", () => {
  // 复现（2026-09-29）：echo 42877 | xargs -n1 -I{} kill {} 在 v2 放行——V1 拦。
  // 根因：effectiveCommand 对 wrapper 词（xargs）只剥「一个」旗标参数（V1
  // stripCommandPrefixes 是 while 循环连剥全部），xargs -n1 -I{} kill {}
  // 的有效 argv0 被误判为 "-I{}"，kill 段失认 → 管道右段字面参数判定
  // （hasLiteralArgs=false）误入字面量主 PID 比对 → 放行。
  // 修复：wrapper 参数剥除与 V1 对齐为循环连剥（guard ≤8 与 V1 同界）。
  it("echo 42877 | xargs -n1 -I{} kill {} → 拦（多 wrapper 参数连剥）", () => {
    expect(checkBashCommandSafety("echo 42877 | xargs -n1 -I{} kill {}", mainPid)).toBeTruthy();
  });
  it("echo 42877 | xargs -n1 kill 42877 → 拦（单参数形态不回归）", () => {
    expect(checkBashCommandSafety("echo 42877 | xargs -n1 kill 42877", mainPid)).toBeTruthy();
  });
  it("lsof -t -i :3100 | xargs kill → 拦（stdin 间接来源形态保持）", () => {
    expect(checkBashCommandSafety("lsof -t -i :3100 | xargs kill", mainPid)).toBeTruthy();
  });
  // 误伤对照（修复不得把合法形态拉黑）：非 wrapper 多参数命令正常放行
  it("git commit -F msg | tail -3 → 放行（非 kill 段不受 wrapper 修复影响）", () => {
    expect(checkBashCommandSafety("git commit -F msg | tail -3", mainPid)).toBeNull();
  });
  it("ls -n1 -I{} 形态参数的非 kill 命令 → 放行", () => {
    expect(checkBashCommandSafety("printf '%s\\n' a b", mainPid)).toBeNull();
  });
  // 连剥扩展面（F20260930l573 补充：多 wrapper 叠加/多参数形态）
  it("echo 42877 | xargs -n1 -I{} -P8 kill {} → 拦（三参数连剥）", () => {
    expect(checkBashCommandSafety("echo 42877 | xargs -n1 -I{} -P8 kill {}", mainPid)).toBeTruthy();
  });
  it("echo 42877 | nice -n 5 xargs kill 42877 → 拦（wrapper 叠加形态）", () => {
    expect(checkBashCommandSafety("echo 42877 | nice -n 5 xargs kill 42877", mainPid)).toBeTruthy();
  });
  it("kill -9 42877 → 拦（信号参数后字面主 PID，剥除不伤信号旗标语义）", () => {
    expect(checkBashCommandSafety("kill -9 42877", mainPid)).toBeTruthy();
  });
  // delta r1（检视建议 1）：wrapper 叠加超过静态判定上限 → 段不可判定 → 保守拦
  it("echo 42877 | xargs env×9 kill 42877 → 拦（wrapper 饱和保守拦，超 guard≤8 界不放行）", () => {
    expect(checkBashCommandSafety(`echo 42877 | xargs ${"env ".repeat(9)}kill 42877`, mainPid)).toBeTruthy();
  });
  it("echo hi | env A=1 node -e 'console.log(1)' → 放行（合理层数 wrapper 不受饱和拦影响）", () => {
    expect(checkBashCommandSafety("echo hi | env A=1 node -e 'console.log(1)'", mainPid)).toBeNull();
  });
});

describe("#1207 对称面：node heredoc 体级危险签名（process.kill 此前无任何判定）", () => {
  // 修复前探针实证（2026-09-29）：node - <<'EOF' process.kill(42877) 在 main 放行——
  // V2 判 heredoc 体为数据 + 文本层无 node 体规则。与 python 体判定同构补面。
  it("node heredoc 体 process.kill(42877) → 拦（对称面主形态）", () => {
    const cmd = `node - <<'EOF'\nprocess.kill(${mainPid});\nEOF`;
    expect(checkBashCommandSafety(cmd, mainPid)).toBeTruthy();
  });
  it("node heredoc 体 child_process 执行逃逸 → 拦", () => {
    const cmd = `node - <<'EOF'\nrequire('child_process').execSync('echo hi');\nEOF`;
    expect(checkBashCommandSafety(cmd, mainPid)).toBeTruthy();
  });
  it("node heredoc 体 fs.writeFileSync → 拦（fs 写族）", () => {
    const cmd = `node - <<'EOF'\nrequire('fs').writeFileSync('src/x.ts', 'x');\nEOF`;
    expect(checkBashCommandSafety(cmd, mainPid)).toBeTruthy();
  });
  it("node heredoc 体纯只读分析 → 放行（readFileSync + console.log）", () => {
    const cmd = `node - <<'EOF'\nconst fs = require('fs');\nconsole.log(fs.readFileSync('src/x.ts', 'utf8').length);\nEOF`;
    expect(checkBashCommandSafety(cmd, mainPid)).toBeNull();
  });
  it("node heredoc 体 process.pid 读取（无 kill）→ 放行", () => {
    const cmd = `node - <<'EOF'\nconsole.log(process.pid, process.platform);\nEOF`;
    expect(checkBashCommandSafety(cmd, mainPid)).toBeNull();
  });
});
