/**
 * F20260928grv2 V9+ 真实拦截数据回放回归（搭档急讯 2026-09-28 中午）。
 *
 * 数据源：healing events 9/28 03:34-03:59 UTC（CST 11:34-11:59）的真实拦截现场——
 * 含跨獭（wxid 獭第 19-21 次、invoke-periodic-audit 獭、capability 獭）与本 session
 * 自身被拦的形态。期望值 = 逐条人工裁决：误拦类应放行（#1170/#1171 现场形态），
 * 规则内拦类保持拦（V1 防绕过语义，白名单外行为不变）。
 */
import { describe, expect, it } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";
import { evaluateWriteTargets, pathWithinMain } from "@frameworks/agent/write-target-evaluator";

const mainPid = 42877;
const projectRoot = "/Users/orca/ai/otter-buddy";
const WT = "/Users/orca/ai/otter-buddy/.otter/worktrees";

describe("V9+ 真实拦截数据回放（9/28 healing events 现场）", () => {
  it("E1: cd worktree && 赋值段链 && cp → 放行（落点可溯源：$F 同命令赋值，cp 落点 /tmp 树外）", () => {
    // F20261019f714（M-f7148deb 第 3 条）：词表命令落点参数 $VAR 同命令赋值溯源落地
    //（resolveTargetArgWord，与 cd 溯源同口径）——cp $F 的 $F 可求值，落点 /tmp/bak.tsx
    // 树外→正面 ALLOW。旧期望「拦（动态源 fail-closed）」是遗留可用性债
    //（原注释：高优记入 B 立项——求值器动态源解析增强），本次偿还，B 立项范围收窄。
    const r = checkBashCommandSafety(`${WT}/invoke-periodic-audit && F=web/src/pages/conversation/index.tsx && cp $F /tmp/bak.tsx`.replace(/^/, "cd "), mainPid, undefined, { projectRoot });
    expect(r).toBeNull();
  });
  it("E3: cd worktree && git stash push → 放行（capability 獭 03:41 现场）", () => {
    const r = checkBashCommandSafety(`cd ${WT}/capability-entries-bridge && git stash push -- tests/capability/helpers/audit-fixtures.ts`, mainPid, undefined, { projectRoot });
    expect(r).toBeNull();
  });
  it("E4: cd worktree && git commit -F ... 2>&1 | tail → 放行（本獭 03:41 第18次现场，#1170 主形态）", () => {
    const r = checkBashCommandSafety(`cd ${WT}/guard-v2-redesign && git add -A && git commit -F /tmp/commit-p3.txt 2>&1 | tail -5`, mainPid, undefined, { projectRoot });
    expect(r).toBeNull();
  });
  it("E5: cd worktree && python3 heredoc 写文件（引号定界）→ 放行（本獭 03:40 第16次现场）", () => {
    const cmd = `cd ${WT}/guard-v2-redesign && python3 - << 'PYEOF'\np = "src/x.ts"\ns = open(p).read()\nopen('/tmp/out.txt', 'w').write(s)\nPYEOF`;
    const r = checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot });
    expect(r).toBeNull();
  });
  it("E6: cd worktree && git commit -m 长消息 2>&1 | tail → 放行（wxid 獭 03:34 第21次现场）", () => {
    const r = checkBashCommandSafety(`cd ${WT}/wxid && git commit -m "[F20260928wxid][weixin][BugFix] 检视处置三处" 2>&1 | tail -3`, mainPid, undefined, { projectRoot });
    expect(r).toBeNull();
  });
  it("S1: grep -rn 引号内词样检索 → 放行（#1171 文本误伤现场）", () => {
    const r = checkBashCommandSafety("grep -rn 'k' + 'ill-segment-finder' src/ --include='*.ts' | head -20", mainPid, undefined, { projectRoot });
    expect(r).toBeNull();
  });
  it("S2: cd worktree && cmd 2>&1 | grep -v ... | head → 放行（管道杀豁免现场）", () => {
    const r = checkBashCommandSafety(`cd ${WT}/guard-v2-redesign && git commit -F /tmp/x.txt 2>&1 | grep -v notice | head -30`, mainPid, undefined, { projectRoot });
    expect(r).toBeNull();
  });
  it("E2 对照: node -e 载荷词样+PID → 放行（F20261015gsub 收敛：one-liner 军备规则已删，字符串词样+数字不再保守拦）", () => {
    // F20261015gsub：V1 防绕过语义（one-liner kill 词样+数字保守拦）已随军备规则删除失效。
    const k = "k";
    const payload = `${k}ill 42877`;
    const cmd2 = `cd ${WT}/guard-v2-redesign && node -e "console.log('${payload}')"`;
    const r = checkBashCommandSafety(cmd2, mainPid, undefined, { projectRoot });
    expect(r).toBeNull();
  });
  it("拦截面对照: kill 主PID / pkill 特征名 / bash -c 'kill $0' 主PID → 拦", () => {
    expect(checkBashCommandSafety("kill 42877", mainPid)).toBeTruthy();
    expect(checkBashCommandSafety("pkill -f otter-buddy", mainPid)).toBeTruthy();
    expect(checkBashCommandSafety("bash -c 'nohup kill $0' 42877", mainPid)).toBeTruthy();
  });
});

describe("10/13 UTC 真实拦截数据回放（#1368 固化自动化首轮）", () => {
  // 数据源：guard-replay-candidates-2026-10-13.json（108 拦截 → 92 候选 → 45 固化）
  // 裁决：固化獭 2026-10-14，探针验证于 worktree guard-replay-freeze-1013
  // ALLOW（误拦）期望 null——暴露 V1 现存误拦；BLOCK（负门）期望 truthy——回归防护
  // 映射表（45 条非 SKIP → 13 用例）见 docs/features/2026/10/14/F20261014grrf-guard-replay-round1.md

  // ── ALLOW：误拦类（V1 现存误拦，it.skip 挂 #1468，修复 PR 内解除 skip 转绿）──
  // 分支保护 required_status_checks=["check"] + enforce_admins=true——保持红物理不可合入
  // #1468 修复验收须含「解除本文件 6 处 it.skip」

  it.skip("1013-A1: python3 heredoc 读 worktree fixture（无 cd）→ 应放行（样本 c6ffc656/0676ef9d/f60d9bbf/381daca8 等）", () => {
    const cmd = `python3 - <<'PYEOF'
import json
p='${WT}/guard-eval-v2/tests/fixtures/guard-touchstone-exam-gaps.json'
d=json.load(open(p))
print(len(d))
PYEOF`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).toBeNull();
  });
  it.skip("1013-A2: python3 -c 读 worktree fixture（无 cd）→ 应放行（样本 cd4ea86f 等）", () => {
    const cmd = `python3 -c "import json; d=json.load(open('${WT}/guard-eval-v2/tests/fixtures/guard-touchstone-exam-gaps.json')); print(len(d))"`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).toBeNull();
  });
  it.skip("1013-A3: cat >> worktree test.ts（绝对路径重定向）→ 应放行（样本 572b7726）", () => {
    const cmd = `cat >> ${WT}/guard-eval-v2/tests/frameworks/agent/write-target-evaluator.test.ts << 'EOF'
it('x', () => {});
EOF`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).toBeNull();
  });
  it.skip("1013-A4: node -e 纯只读 require(package.json) → 应放行（样本 7bccfbf5，#1432 同类）", () => {
    const cmd = `node -e "const s=require('./package.json').scripts; for (const k of Object.keys(s)) console.log(k, '=>', s[k])" | head -20`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).toBeNull();
  });
  it.skip("1013-A5: git -C worktree add && git -C worktree commit → 应放行（样本 0efc13ea/3457f89c/9a07382a）", () => {
    const cmd = `git -C ${WT}/deps-upgrade-1009 add -A && git -C ${WT}/deps-upgrade-1009 commit -F /tmp/msg.txt`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).toBeNull();
  });
  it.skip("1013-A6: rm -f workspaces 内文件 → 应放行（样本 9d50f659，data_destructive 误拦 workspaces）", () => {
    const cmd = `rm -f /Users/orca/ai/otter-buddy/data/workspaces/11806e11-1cac-4d00-b263-badff1a80f2b/quota-*.mjs`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).toBeNull();
  });

  // ── BLOCK：规则内负门（回归防护，测试预期绿）──

  it("1013-B1: git stash push（cwd 主仓，无 -C）→ 拦（样本 b35d31de/5fa4f615）", () => {
    const cmd = `git stash push -m test-wip -- src/frameworks/agent/pi-session-factory.ts`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).toBeTruthy();
  });
  // 层差注记（大獭裁决 2026-10-14，M-3f8d8a0d 跨库对照；2026-10-20 落位）：双法院两案非反判——
  // 求值器法院管「写没写主仓」（远端操作零本地树写→ALLOW，见 guard-touchstone TS-smrjreg18f0c467/
  // c170d88c 层差注记同文）；本用例属策略层法院「破坏性远端操作」负门（R1.4 远端删分支→BLOCK）。
  // 两层各司其职，与 touchstone 同命令 ALLOW 不构成反判（跨产线全等命中仅此一对，2026-10-20 重核无新增）。
  it("1013-B2: git push --delete（cwd 主仓）→ 拦（样本 8ae8edb8）", () => {
    const cmd = `git push origin --delete feature/F20261012orcl-acceptance-oracle-gate`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).toBeTruthy();
  });
  it("1013-B3: git add -A && git commit --amend（cwd 主仓，无 -C）→ 拦（样本 d30aa40e 等）", () => {
    const cmd = `git add -A && git commit --amend -F /Users/orca/ai/otter-buddy/data/workspaces/11806e11-1cac-4d00-b263-badff1a80f2b/commit-msg.txt`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).toBeTruthy();
  });
  it("1013-B4: sleep 180 && ...（sleep_block 负门）→ 拦（样本 fe06ae02/84e266b8/ca165165/88712b22/127de30b/dff90d4e/6a33c4e8/1fe986c2）", () => {
    const cmd = `sleep 180 && cd ${WT}/x && gh pr checks 1451`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).toBeTruthy();
  });
  it("1013-B5: bash script.sh（script_file_exec 负门）→ 拦（样本 040c8fc8/7daea038/cadd6a06）", () => {
    // 注：7daea038 实为 main_write 拦 do-commit.sh（脚本头注释自陈把 worktree 路径移出命令行规避守卫进程名模式），与 script_file_exec 同构同判；脚本内容 git -C "$WT" add/commit，按 O-2 理想口径可议放行，但 V1 现状 = BLOCK，翻转须重裁
    // 注（2026-10-20 M-3f8d8a0d 层差注记落位，承接上注「翻转须重裁」钩子）：重裁已兑现——signal d5f2ae9a
    // + 2026-10-14 全天候选裁决构成重裁，结论=ALLOW（脚本内容 git -C "$WT" add/commit 实质安全，
    // v2 载荷判读→ALLOW，见 guard-touchstone TS-smrjregc0c9c6a6/3064857e/cb2c9109 层差注记同文）。
    // 终态以 v2 为准；本用例钉 V1 现状=BLOCK 系层差记档（两法院口径，非终局裁决），V1 链退役或翻转时本期望随之更新。
    const cmd = `bash data/workspaces/7b41e085-5c21-4bd1-adfe-dc3ef051753d/wt-test.sh tests/frameworks/agent/guard-touchstone-corpus.test.ts`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).toBeTruthy();
  });
  it("1013-B6: pkill -f（self_kill_byname 负门）→ 拦（样本 24b76637）", () => {
    // 注：V1 策略现状（按名批杀一律拦），样本实为 worktree 内 chromium 运维动作；语义可议，翻转须重裁
    const cmd = `pkill -f "user-data-dir=${WT}/fix-quota-normalize" 2>/dev/null; sleep 1; ps aux | head`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).toBeTruthy();
  });
  it("1013-B7: sqlite3 触主仓 data/qtest-*.db（data_destructive 负门）→ 拦（样本 835b22db 实拦 10-13 09:10:57）", () => {
    const cmd = `rm -f /Users/orca/ai/otter-buddy/data/qtest-1.db`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).toBeTruthy();
  });
});

describe("#1432 node import/require 只读豁免回放（10-12 现场 b4471a4f/026b37ee，旧链+求值器双侧钉住）", () => {
  // 现场形态：session cwd 在主仓的裸命令（b4471a4f 无 cd 前缀）——guardOptions.sessionCwd 驱动判定
  const gopts = { projectRoot, sessionCwd: projectRoot };
  const PROBE_CMD = `node -e "const { scanStopWords } = await import('./src/usecases/signal/stop-word-scanner.ts').catch(e=>null)"`;

  it("1432-A1: 现象命令（await import 主仓相对路径只读探针）→ 放行（旧链侧钉住）", () => {
    expect(checkBashCommandSafety(PROBE_CMD, mainPid, undefined, gopts)).toBeNull();
  });

  it("1432-A2: 同命令求值器侧钉住——evaluated 且无主仓写落点", () => {
    const r = evaluateWriteTargets(PROBE_CMD, projectRoot);
    expect(r.kind).toBe("evaluated");
    if (r.kind === "evaluated") {
      expect(r.targets.filter(t => pathWithinMain(t.path, projectRoot))).toHaveLength(0);
    }
  });

  it("1432-A3: node -e require('./src/foo.ts') 纯字面量目标 → 放行（旧链侧）", () => {
    expect(checkBashCommandSafety(`node -e "const x = require('./src/foo.ts'); console.log(Object.keys(x))"`, mainPid, undefined, gopts)).toBeNull();
  });

  it("1432-B1（F20261019gses F1 修订）：require('./src/' + p) 相对字面量拼接 → 求值器字面量片段披露（evaluated+read target）整链放行——动态拼接目标不可静态判定但读面无写证据；主仓字面量拼接（import('/repo/x' + y)）由 MAIN_LIT_CONCAT_IMPORT_FACE 负门拦（写耦合信号强）", () => {
    expect(checkBashCommandSafety(`node -e "const x = require('./src/' + p)"`, mainPid, undefined, gopts)).toBeNull();
    expect(checkBashCommandSafety(`node -e "const x = require('/repo/src/' + p)"`, mainPid, undefined, gopts)).toBeTruthy();
  });

  it("1432-B2 负门: import 掩护真写 → 保持拦（写词面不因豁免失效）", () => {
    const cmd = `node -e "await import('./x'); require('fs').writeFileSync('./src/evil.txt','x')"`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeTruthy();
  });

  it("1432-B3 负门: require('child_process') 危险模块 → 保持拦（词面禁不因豁免失效）", () => {
    expect(checkBashCommandSafety(`node -e "const c = require('child_process')"`, mainPid, undefined, gopts)).toBeTruthy();
  });
});

describe("#1635 主仓只读 grep 引号参数误拦回放（10-23/10-24 现场，isKillAtCommandPosition 引号盲区）", () => {
  // 现场形态：cd 主仓 + 只读检索管道。危险词（rm / find -delete）出现在 grep 引号
  // 模式参数内（数据位），被 checkDataDirDestructive → isKillAtCommandPosition 的
  // VALID_CMD_PRECEDERS 把引号内 \|（grep alternation 转义竖线）当 shell 管道误判
  // 命令位（healing 987a40c3=rm 命中 / af548d08=find -delete 命中，日志锚
  // otter-buddy.log L2259621 / L2238313）。
  const gopts = { projectRoot, sessionCwd: `${projectRoot}/data/workspaces/3241317b-99d6-4d78-9248-ff208a7461bc` };

  it("1635-A1: 10-24 现场命令（grep -i \"write\\|rm\\|destruct\" 引号内 rm）原样回放 → 放行", () => {
    const cmd = `cd ${projectRoot} && grep -rn "main_write" src/frameworks/agent/bash-safety-guard.ts | head -10; grep -n "grep" src/frameworks/agent/bash-safety-guard.ts | grep -i "write\\|rm\\|destruct" | head -5`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeNull();
  });

  it("1635-A2: 10-23 现场命令（grep 模式引号内 find -delete 词面）原样回放 → 放行", () => {
    const cmd = `cd ${projectRoot} && grep -n "find" src/frameworks/agent/bash-safety-guard.ts | grep -iv "finding\\|defined\\|refind" | head -15 && echo ===WV=== && grep -n "\\"find\\"\\|'find'\\|find -delete\\|" src/frameworks/agent/bash-safety-guard.ts | head -5`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeNull();
  });

  it("1635-A3: gh issue create heredoc 正文含 find -delete 字样（文档数据体）→ 放行", () => {
    const cmd = `cd ${projectRoot} && gh issue create --title "[guard] 只读检索被误拦" --body "$(cat <<'EOF'\n## 案发现场\n\n\`find -delete\` 词面出现在 grep 引号参数里被误拦。\nEOF\n)"`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeNull();
  });

  it("1635-A4: issue 关闭标准形态 grep -n \"find\" src/... 纯净形 → 放行", () => {
    const cmd = `cd ${projectRoot} && grep -n "find" src/frameworks/agent/bash-safety-guard.ts | head -5`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeNull();
  });

  it("1635-B1 负例: 命令位真 rm 主仓文件 → 仍拦", () => {
    const cmd = `cd ${projectRoot} && rm -f src/test.txt`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeTruthy();
  });

  it("1635-B2 负例: 命令位真 find -delete 主仓树 → 仍拦", () => {
    const cmd = `cd ${projectRoot} && find src -name "*.tmp" -delete`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeTruthy();
  });

  it("1635-B3 负例: 双引号内 $() 展开的真命令位写 → 仍拦（引号感知不豁免命令替换）", () => {
    const cmd = `cd ${projectRoot} && echo "$(rm -f src/x.txt)"`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeTruthy();
  });

  it("1635-B4 负例: 引号内真 rm 执行体（bash -c 载荷）→ 仍拦", () => {
    const cmd = `cd ${projectRoot} && bash -c "rm -f src/x.txt"`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeTruthy();
  });

  it("1635-B5 负例: heredoc shell 体执行真 rm → 仍拦（剥体不豁免 shell 体判定）", () => {
    const cmd = `cd ${projectRoot} && bash <<'SH'\nrm -f src/x.txt\nSH`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeTruthy();
  });
});

describe("#1641-r1 检视回退探针（Review-1641 初轮：$() 引号世界/闭合判定/cat-heredoc-管道-shell 体）", () => {
  const gopts = { projectRoot, sessionCwd: `${projectRoot}/data/workspaces/ws` };

  // 发现 1：双引号内 $() 是真实执行位，$() 内的 | 是真管道 → rm/kill 是命令位 → 应拦
  it("1641-Q1: echo \"$(printf x | rm -f src/x)\" → 仍拦", () => {
    const cmd = `echo "$(printf x | rm -f ${projectRoot}/src/x.txt)"`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeTruthy();
  });

  it("1641-Q5: $()内管道 rm data/ → 仍拦", () => {
    const cmd = `echo "$(printf x | rm -f ${projectRoot}/data/x.txt)"`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeTruthy();
  });

  it("1641-Q1n: 嵌套 $() 内管道 rm → 仍拦（depth 递归时引号世界重置）", () => {
    const cmd = `echo "$(echo $(printf x | rm -f ${projectRoot}/src/x.txt))"`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeTruthy();
  });

  it("1641-Q6: $()内 kill 主 PID → 仍拦", () => {
    const cmd = `echo "$(printf x | kill -9 ${mainPid})"`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeTruthy();
  });

  // 对照：单引号内 $() POSIX 不展开（字面量）→ 放行
  it("1641-Q1s: 单引号内 $() 字面量 → 放行", () => {
    const cmd = `echo '$(printf x | rm -f ${projectRoot}/src/x)'`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeNull();
  });

  // 发现 2：闭合判定——单引号内 \\ 不转义（'x\\' 实际闭合）；双引号 \\\\ 偶数反斜杠后闭合
  it("1641-Q3: printf 'x\\' | rm 真管道 → 仍拦（单引号已闭合，rm 命令位）", () => {
    const cmd = `printf 'x\\' | rm -f ${projectRoot}/src/x.txt`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeTruthy();
  });

  it("1641-Q4: printf \"x\\\\\" | rm 真管道 → 仍拦（偶数反斜杠，双引号闭合）", () => {
    const cmd = `printf "x\\\\" | rm -f ${projectRoot}/src/x.txt`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeTruthy();
  });

  // 发现 3：cat <<'EOF' | bash——体经管道喂真 shell，是执行面非数据面 → 应拦
  it("1641-H1: cat <<'EOF' | bash 体 rm src → 仍拦", () => {
    const cmd = `cd ${projectRoot} && cat <<'EOF' | bash\nrm -f src/x.txt\nEOF`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeTruthy();
  });

  it("1641-H1b: cat <<'EOF' | bash 体 rm data → 仍拦", () => {
    const cmd = `cd ${projectRoot} && cat <<'EOF' | bash\nrm -f data/x.txt\nEOF`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeTruthy();
  });

  it("1641-H1c: cat <<'EOF' | bash 体 kill 主 PID → 仍拦", () => {
    const cmd = `cd ${projectRoot} && cat <<'EOF' | bash\nkill -9 ${mainPid}\nEOF`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeTruthy();
  });

  it("1641-H1sh: cat <<'EOF' | sh 体 rm → 仍拦（sh/zsh 同族）", () => {
    const cmd = `cd ${projectRoot} && cat <<'EOF' | sh\nrm -f src/x.txt\nEOF`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeTruthy();
  });

  // 对照：R4 现场不回归 + 数据体 heredoc 不误拦
  it("1641-R4: 现场 grep BRE \\| 引号模式 → 放行（不回归）", () => {
    const cmd = `cd ${projectRoot} && grep -i "write\\|rm\\|destruct" src/frameworks/agent/bash-safety-guard.ts | head -5`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeNull();
  });

  it("1641-H5: cat 数据体（无管道）find -delete 字样 → 放行（不回归）", () => {
    const cmd = `cd ${projectRoot} && cat <<EOF\nfind -delete 文档字样\nEOF`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, gopts)).toBeNull();
  });
});
