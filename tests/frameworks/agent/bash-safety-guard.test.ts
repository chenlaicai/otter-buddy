/**
 * F20260830bsgr Bash 命令安全守卫测试（v2 对抗审视修正）。
 *
 * 验证：
 * - kill 字面量主进程 PID → 拦截
 * - kill 字面量无关 PID → 放行
 * - kill 非字面量目标（变量/$()/反引号/xargs/管道/base64/eval）→ 保守拦截
 * - pkill/killall + otter 模式 → 拦截
 * - pkill/killall 无关模式 → 放行
 * - .otter-buddy.pid 引用 + kill → 拦截
 * - PID 文件缺失/非法 → 放行（保守降级）
 *
 * F20260830fabt-r2: 检视獭实证的10 个绕过 PoC 全部转为回归测试
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { checkBashCommandSafety, readMainProcessPid } from "@frameworks/agent/bash-safety-guard";

describe("readMainProcessPid", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pid-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("正常 PID 文件返回数字", () => {
    fs.writeFileSync(path.join(tmpDir, ".otter-buddy.pid"), "42877\n");
    expect(readMainProcessPid(tmpDir)).toBe(42877);
  });

  it("PID 文件不存在返回 null", () => {
    expect(readMainProcessPid(tmpDir)).toBeNull();
  });

  it("PID 文件内容非法返回 null", () => {
    fs.writeFileSync(path.join(tmpDir, ".otter-buddy.pid"), "abc\n");
    expect(readMainProcessPid(tmpDir)).toBeNull();
  });

  it("PID 文件内容为 0 返回 null", () => {
    fs.writeFileSync(path.join(tmpDir, ".otter-buddy.pid"), "0\n");
    expect(readMainProcessPid(tmpDir)).toBeNull();
  });

  it("每次调用都读文件（不缓存）", () => {
    fs.writeFileSync(path.join(tmpDir, ".otter-buddy.pid"), "111\n");
    expect(readMainProcessPid(tmpDir)).toBe(111);
    // 修改 PID 文件内容
    fs.writeFileSync(path.join(tmpDir, ".otter-buddy.pid"), "222\n");
    expect(readMainProcessPid(tmpDir)).toBe(222);
  });
});

describe("checkBashCommandSafety", () => {
  const mainPid = 42877;

  // ─── 基础：字面量 PID 精确匹配 ───

  it("直接 kill 主进程 PID → 拦截", () => {
    const result = checkBashCommandSafety("kill 42877", mainPid);
    expect(result).toContain("主进程 PID");
    expect(result).toContain("主进程");
    // F20260831aksp：PID 数字脱敏——拦截文案不得回显真实 PID（堵试探链）
    expect(result).not.toContain("42877");
  });

  it("kill -9 主进程 PID → 拦截", () => {
    const result = checkBashCommandSafety("kill -9 42877", mainPid);
    expect(result).toContain("主进程 PID");
  });

  it("kill -15 主进程 PID → 拦截", () => {
    const result = checkBashCommandSafety("kill -15 42877", mainPid);
    expect(result).toContain("主进程 PID");
  });

  it("sudo kill 主进程 PID → 拦截（穿透 sudo 包装）", () => {
    const result = checkBashCommandSafety("sudo kill 42877", mainPid);
    expect(result).toContain("主进程 PID");
  });

  it("kill 主进程 + nohup 组合命令 → 拦截", () => {
    const result = checkBashCommandSafety(
      "kill 42877 2>/dev/null; sleep 2; nohup node dist/src/main.js > /tmp/otter-main.log 2>&1 &",
      mainPid,
    );
    expect(result).toContain("主进程 PID");
  });

  it("kill 无关进程 PID → 放行", () => {
    const result = checkBashCommandSafety("kill 12345", mainPid);
    expect(result).toBeNull();
  });

  it("kill -9 无关进程 PID → 放行", () => {
    const result = checkBashCommandSafety("kill -9 12345", mainPid);
    expect(result).toBeNull();
  });

  it("多个 PID 中包含主进程 → 拦截", () => {
    const result = checkBashCommandSafety("kill 12345 42877 67890", mainPid);
    expect(result).toContain("主进程 PID");
  });

  it("多个 PID 都是无关进程 → 放行", () => {
    const result = checkBashCommandSafety("kill 12345 67890", mainPid);
    expect(result).toBeNull();
  });

  it("无 PID 文件（null）→ 放行", () => {
    const result = checkBashCommandSafety("kill 42877", null);
    expect(result).toBeNull();
  });

  it("不含 kill 的命令 → 放行", () => {
    const result = checkBashCommandSafety("git status", mainPid);
    expect(result).toBeNull();
  });

  it("不含 kill 的 node 命令 → 放行", () => {
    const result = checkBashCommandSafety("node dist/src/main.js", mainPid);
    expect(result).toBeNull();
  });

  it("管道中前段 kill 主进程 → 拦截", () => {
    const result = checkBashCommandSafety("echo starting && kill 42877", mainPid);
    expect(result).toContain("主进程 PID");
  });

  it("空命令 → 放行", () => {
    const result = checkBashCommandSafety("", mainPid);
    expect(result).toBeNull();
  });

  // ─── F20260831aksp §2c：归一化检测——塔死引号/反斜杠拼接规避（R1 严重1） ───

  it("空单引号拼接 ki''ll 主 PID → 拦截（归一化后命中）", () => {
    const result = checkBashCommandSafety("ki''ll 42877", mainPid);
    expect(result).toContain("主进程 PID");
  });

  it("空双引号拼接 → 拦截（归一化后命中）", () => {
    const result = checkBashCommandSafety('ki""ll 42877', mainPid);
    expect(result).toContain("主进程 PID");
  });

  it("字母间反斜杠拼接 → 拦截（归一化后命中）", () => {
    const result = checkBashCommandSafety("k\\ill 42877", mainPid);
    expect(result).toContain("主进程 PID");
  });

  it("连续反斜杠拼接（检视 R1 发现2）→ 拦截（单遍贪婪正则会漏此形态）", () => {
    // k\i\ll 在 shell 中释为 kill；旧正则 /([a-zA-Z])\\([a-zA-Z])/g 贪婪消耗尾部字母，
    // 首遍归一化为 ki\ll（反斜杠残留）→ 二轮检测仍漏。lookbehind/lookahead 修正后单遍归一化彻底
    const result = checkBashCommandSafety("k\\i\\ll 42877", mainPid);
    expect(result).toContain("主进程 PID");
  });

  it("三重反斜杠拼接 → 拦截（归一化对任意连续形态彻底）", () => {
    const result = checkBashCommandSafety("k\\i\\l\\l 42877", mainPid);
    expect(result).toContain("主进程 PID");
  });

  it("无 PID 的拼接查询（如 grep 'ki''ll' file）→ 放行（归一化不扩大误拦面）", () => {
    const result = checkBashCommandSafety("grep 'ki''ll' file.txt", mainPid);
    expect(result).toBeNull();
  });

  it("拼接 + 无关 PID → 放行（仅归一化命中 kill 词还不够，需后续 PID 判定）", () => {
    const result = checkBashCommandSafety("ki''ll 12345", mainPid);
    expect(result).toBeNull();
  });

  it("拦截文案不含 restart 推荐（终审口径：无 restart 出口）", () => {
    const result = checkBashCommandSafety("pkill -f otter-buddy", mainPid);
    expect(result).not.toContain("otter-buddy.sh restart");
  });

  // ─── 检视 R1 发现1：无法判断型拦截的误拦退出引导 ───

  it("无法判断型拦截（间接 PID 目标）含误拦退出引导", () => {
    const result = checkBashCommandSafety("echo x | grep -q p && skill $PID", mainPid);
    expect(result).toContain("本意安全");
  });

  it("无法判断型拦截（eval 包装）含误拦退出引导", () => {
    const result = checkBashCommandSafety("eval \"echo 42877\"", mainPid);
    expect(result).toContain("本意安全");
  });

  it("管道到 shell 中 kill 在 grep 参数里 → 放行（kill 非命令位置，#698 误报回归）", () => {
    const result = checkBashCommandSafety("cat note.txt | grep -q kill && bash -c 'true'", mainPid);
    expect(result).toBeNull();
  });

  it("直接命中主进程 PID 的拦截不含误拦退出引导（不存在本意安全语义，加了自相矛盾）", () => {
    const result = checkBashCommandSafety("kill 42877", mainPid);
    expect(result).not.toContain("本意安全");
  });

  // ─── pkill/killall 精确模式匹配 ───

  it("pkill otter-buddy → 拦截", () => {
    const result = checkBashCommandSafety("pkill -f otter-buddy", mainPid);
    expect(result).toContain("pkill");
  });

  it("pkill node.*main → 拦截", () => {
    const result = checkBashCommandSafety("pkill -f 'node.*main'", mainPid);
    expect(result).toContain("pkill");
  });

  it("pkill dist/src/main.js → 拦截", () => {
    const result = checkBashCommandSafety("pkill -f dist/src/main.js", mainPid);
    expect(result).toContain("pkill");
  });

  it("pkill .otter-buddy.pid → 拦截", () => {
    const result = checkBashCommandSafety("pkill -f .otter-buddy.pid", mainPid);
    expect(result).not.toBeNull(); // 匹配跨段 PID 文件引用或 pkill 模式
  });

  it("pkill 无关进程名 → 放行", () => {
    const result = checkBashCommandSafety("pkill -f ffmpeg", mainPid);
    expect(result).toBeNull();
  });

  it("killall node → 拦截", () => {
    const result = checkBashCommandSafety("killall node", mainPid);
    expect(result).not.toBeNull();
  });

  it("killall 无关进程 → 放行", () => {
    const result = checkBashCommandSafety("killall ffmpeg", mainPid);
    expect(result).toBeNull();
  });

  // ─── 对抗 LLM 自适应变形：非字面量 kill 目标 → 保守拦截 ───

  it("PoC-1: kill $(cat .otter-buddy.pid) → 拦截（命令替换 + PID 文件引用）", () => {
    const result = checkBashCommandSafety("kill $(cat .otter-buddy.pid)", mainPid);
    expect(result).not.toBeNull();
  });

  it("PoC-2: kill `cat .otter-buddy.pid` → 拦截（反引号命令替换 + PID 文件引用）", () => {
    const result = checkBashCommandSafety("kill `cat .otter-buddy.pid`", mainPid);
    expect(result).not.toBeNull();
  });

  it("PoC-3: MAINPID=$(cat .otter-buddy.pid) && kill $MAINPID → 拦截（变量 + PID 文件引用）", () => {
    const result = checkBashCommandSafety("MAINPID=$(cat .otter-buddy.pid) && kill $MAINPID", mainPid);
    expect(result).not.toBeNull();
  });

  it("PoC-4: cat .otter-buddy.pid | xargs kill → 拦截（管道 + PID 文件引用）", () => {
    const result = checkBashCommandSafety("cat .otter-buddy.pid | xargs kill", mainPid);
    expect(result).not.toBeNull();
  });

  it("PoC-5: kill $(pgrep -f main.js) → 拦截（命令替换 + 非字面量）", () => {
    const result = checkBashCommandSafety("kill $(pgrep -f main.js)", mainPid);
    expect(result).not.toBeNull();
  });

  it("PoC-6: pkill -f main.js → 拦截（otter 进程模式）", () => {
    const result = checkBashCommandSafety("pkill -f main.js", mainPid);
    expect(result).not.toBeNull();
  });

  it("PoC-7: pkill -f dist/src → 拦截（otter 进程模式）", () => {
    const result = checkBashCommandSafety("pkill -f dist/src", mainPid);
    expect(result).not.toBeNull();
  });

  it("PoC-8: echo a2lsbCA0Mjg3Nwo= | base64 -d | sh → 已知局限（base64 编码的 kill 无法文本检测）", () => {
    // base64 编码 "kill 42877\n" → 管道到 sh 是高危模式，但文本分析看不到 kill 关键词
    // 这是纵深防御的已知盲点：管道到 shell 本身不够危险（可执行正常 base64 解码），
    // 只有结合未知编码内容才有风险——超出静态文本分析能力
    const result = checkBashCommandSafety("echo a2lsbCA0Mjg3Nwo= | base64 -d | sh", mainPid);
    expect(result).toBeNull(); // 文本层面看不到 kill，确实放行
  });

  it("PoC-9: eval \"kil\"\"l 42877\" → 拦截（eval 包装）", () => {
    const result = checkBashCommandSafety('eval "kil""l 42877"', mainPid);
    expect(result).not.toBeNull();
  });
});

// F20260902gvrd + #730：词边界收紧 / 拦截回显 / PID 脱敏——独立 describe（避免主 describe 超 max-lines-per-function 220）
describe("F20260902gvrd 词边界收紧与拦截回显", () => {
  const mainPid = 42877;

  // F20260902gvrd：eval 词边界收紧为命令位置后的误报回归用例——路径/标识符中的
  // eval-xxx（连字符是 \b 词边界）叠加任意 2-6 位数字（日期/行号）曾误拦纯 git/grep 命令
  it("路径含 eval-xxx + 日期数字 → 放行（eval 不在命令位置，F20260902gvrd 误报回归）", () => {
    const result = checkBashCommandSafety(
      "git -C /Users/orca/ai/otter-buddy/.claude/worktrees/guard-eval-fix status --short && git add docs/features/2026/09/02/x.md",
      mainPid,
    );
    expect(result).toBeNull();
  });

  it("文件名含 e.*v.*a.*l 变体路径 + 行号 → 放行（同上）", () => {
    const result = checkBashCommandSafety("sed -n '125,140p' src/frameworks/agent/bash-safety-guard.ts && grep -n 'l40' x.txt", mainPid);
    expect(result).toBeNull();
  });

  it("命令位置 eval 在操作符后仍拦截（收紧后覆盖面回归）", () => {
    const result = checkBashCommandSafety("cd /tmp && eval \"echo 42877\"", mainPid);
    expect(result).not.toBeNull();
  });

  // #730 拦截回显增强：被拦命令应带诊断块（规则名 + 片段 + 位置），不再只有静态文案
  it("拦截文案含命中详情（规则名 + 位置偏移，#730）", () => {
    const result = checkBashCommandSafety('git -C . && eval "echo 42877"', mainPid);
    expect(result).not.toBeNull();
    expect(result!).toContain("【命中详情】");
    expect(result!).toContain("@"); // 位置偏移标记
  });

  it("拦截文案含命中详情且主进程 PID 已脱敏（#730 + F20260831aksp 铁律兼容）", () => {
    const result = checkBashCommandSafety("kill 42877", mainPid);
    expect(result).not.toBeNull();
    expect(result!).toContain("【命中详情】");
    expect(result!).not.toContain("42877"); // PID 不回显
    expect(result!).toContain("<main-pid>"); // 脱敏占位符可见，位置可自定位
  });

  it("归一化路径拦截的诊断块引用原始命令（#730）", () => {
    const result = checkBashCommandSafety('e""val "echo 42877"', mainPid);
    expect(result).not.toBeNull();
    expect(result!).toContain("【命中详情】");
  });

  it("PoC-10: perl -e 'kill 15, 42877' → 拦截（perl kill 绕过）", () => {
    // perl 的 kill 不是 shell kill，但参数中有主进程 PID + kill 关键词
    const result = checkBashCommandSafety("perl -e 'kill 15, 42877'", mainPid);
    expect(result).not.toBeNull();
  });

  // ─── 边界：非字面量但无 kill → 放行 ───

  it("变量引用但无 kill 命令 → 放行", () => {
    const result = checkBashCommandSafety("echo $MAIN_PID", mainPid);
    expect(result).toBeNull();
  });

  it("$() 命令替换但无 kill → 放行", () => {
    const result = checkBashCommandSafety("echo $(cat /tmp/status)", mainPid);
    expect(result).toBeNull();
  });

  // ─── PID 实时读取（不缓存） ───

  it("PID 文件更新后立即生效", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pid-test-"));
    try {
      fs.writeFileSync(path.join(tmpDir, ".otter-buddy.pid"), "42877\n");
      expect(readMainProcessPid(tmpDir)).toBe(42877);
      // PID 热重启后变化
      fs.writeFileSync(path.join(tmpDir, ".otter-buddy.pid"), "99999\n");
      expect(readMainProcessPid(tmpDir)).toBe(99999);
      // 旧 PID 不再是主进程
      expect(checkBashCommandSafety("kill 42877", 99999)).toBeNull();
      // 新 PID 是主进程
      expect(checkBashCommandSafety("kill 99999", 99999)).not.toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── #698 误报回归：eval 词元文件名+数字即拦（模式1） ───

describe("#698 误报回归：eval 词元文件名+数字即拦（模式1）", () => {
  const mainPid = 42877;

  it("cp plans/eval-activation-v6.md <workspace UUID> → 放行（eval 在路径中，非命令）", () => {
    const result = checkBashCommandSafety(
      "cp plans/eval-activation-v6.md data/workspaces/a1b2c3d4-e5f6-7890-abcd-ef1234567890/",
      mainPid,
    );
    expect(result).toBeNull();
  });

  it("ls plans/; find . -name 'eval-activation...' → 放行（eval 在 find 参数中）", () => {
    const result = checkBashCommandSafety(
      'ls plans/; find . -name "eval-activation*"',
      mainPid,
    );
    expect(result).toBeNull();
  });

  it("grep -n 'v4.2|D1|D2|D3' workspaces/... → 放行（eval 在路径中 + 文档内容含数字）", () => {
    const result = checkBashCommandSafety(
      'grep -n "v4.2\\|D1\\|D2\\|D3" data/workspaces/a1b2c3d4/note.md',
      mainPid,
    );
    expect(result).toBeNull();
  });

  it("grep -n '不 boot 应用|git-common-dir' ... → 放行（eval 在路径中）", () => {
    const result = checkBashCommandSafety(
      'grep -n "不 boot 应用\\|git-common-dir" data/workspaces/a1b2c3d4/eval-activation-v6.md',
      mainPid,
    );
    expect(result).toBeNull();
  });

  it("cat > /tmp/test24.js << EOF → 放行（heredoc 写文件，eval 可能在内容中）", () => {
    const result = checkBashCommandSafety(
      'cat > /tmp/test24.js << EOF\neval("test")\nEOF',
      mainPid,
    );
    expect(result).toBeNull();
  });
});

// ─── #698 误报回归：进程动词词元任意位置匹配（模式2） ───

describe("#698 误报回归：进程动词词元任意位置匹配（模式2）", () => {
  const mainPid = 42877;

  it("gh pr review --comment --body 含 skill 字样 + markdown 反引号 → 放行", () => {
    const result = checkBashCommandSafety(
      "gh pr review 689 --comment --body '## 审查者 检视獭-689\n\n`skill` 文件审查通过'",
      mainPid,
    );
    expect(result).toBeNull();
  });

  it("for pr in ...; do gh pr view $pr; done # skill 文件自查 → 放行", () => {
    const result = checkBashCommandSafety(
      'for pr in 683 682 681; do gh pr view $pr; done # skill 文件自查',
      mainPid,
    );
    expect(result).toBeNull();
  });

  it("grep -rn skill .pi/skills/ → 放行（skill 在搜索词和路径中，非命令）", () => {
    const result = checkBashCommandSafety(
      'grep -rn "skill" .pi/skills/',
      mainPid,
    );
    expect(result).toBeNull();
  });

  it("echo skill | cat → 放行（skill 在 echo 参数中，非命令）", () => {
    const result = checkBashCommandSafety(
      'echo skill | cat',
      mainPid,
    );
    expect(result).toBeNull();
  });

  // ─── 管道/操作符后 kill 仍应拦截 ───

  it("cat file | xargs kill → 拦截（xargs kill 在管道后，命令位置）", () => {
    const result = checkBashCommandSafety(
      'cat file | xargs kill',
      mainPid,
    );
    expect(result).not.toBeNull();
  });

  it("echo starting && kill 42877 → 拦截（kill 在 && 后，命中主 PID）", () => {
    const result = checkBashCommandSafety(
      'echo starting && kill 42877',
      mainPid,
    );
    expect(result).not.toBeNull();
  });

  it("echo a; sudo /usr/bin/kill 42877 → 拦截（sudo + 路径穿透 kill 在 ; 后，命中主 PID）", () => {
    const result = checkBashCommandSafety(
      'echo a; sudo /usr/bin/kill 42877',
      mainPid,
    );
    expect(result).not.toBeNull();
  });
});
