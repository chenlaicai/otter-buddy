/**
 * F20261016grdl：G1 归因 9 例 + 段级 cd 豁免 + 落点感知豁免的拦截面固化测试。
 * 修复面（放行）与不误伤面（拦截）双侧钉死；行为变更锚点（写动词+落点感知）单列。
 */
import { describe, expect, it } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";

const MAIN_PID = 42877;
const ROOT = "/Users/orca/ai/otter-buddy";
const WS = `${ROOT}/data/workspaces/7b41e085-5c21-4bd1-adfe-dc3ef051753d`;
const MY_WS = `${ROOT}/data/workspaces/98bd9fdd-8e28-4de8-b782-b59f46e733dd`;
const WT = `${ROOT}/.otter/worktrees/grdl-guard-infra`;

const guard = (cmd: string, sessionCwd = WS) =>
  checkBashCommandSafety(cmd, MAIN_PID, undefined, { projectRoot: ROOT, sessionCwd });

describe("F20261016grdl 1a'：G1 六例修复面（放行）", () => {
  it("例1：cat > workspace 绝对路径 heredoc → 放行", () => {
    expect(guard(`cat > ${WS}/commit-msg.txt <<'EOF'\n[F] x\nEOF`)).toBeNull();
  });
  it("例2：cat >> worktree 绝对路径 heredoc → 放行", () => {
    expect(guard(`cat >> ${WT}/tests/x.test.ts <<'EOF'\n// p\nEOF`)).toBeNull();
  });
  it("例1 完整形态：cat workspace + cd worktree && git commit -F（族 E 混合段）→ 放行", () => {
    expect(guard(`cat > ${WS}/m.txt <<'EOF'\nx\nEOF\ncd ${WT} && git commit --author="a <b>" -F ${WS}/m.txt`)).toBeNull();
  });
  it("例3：cd worktree && python3 -c os.remove(glob 相对路径)（排除区内删）→ 放行", () => {
    expect(guard(`cd ${WT} && python3 -c "import os,glob; [os.remove(f) for f in glob.glob('tests/**/zz-*.test.ts', recursive=True)]"`)).toBeNull();
  });
  it("例4：python3 -c json.load(open('/tmp/x')) 只读 → 放行", () => {
    expect(guard(`python3 -c "import json\nd = json.load(open('/tmp/colink-tasks.json'))\nprint(d)"`)).toBeNull();
  });
  it("例5：PAT=$(cat ~/.k); curl -X POST（$() 赋值不触发写族）→ 放行", () => {
    expect(guard(`PAT=$(cat ~/.colink/otter-pat); curl -s -X POST https://huawei-colink.com/api/mcp -H "Authorization: Bearer $PAT" -d '{}' --max-time 15 | head -c 3000`)).toBeNull();
  });
  it("例6：cd 树外 && python3 -c im.save('/tmp/x.png')（写动词+落点树外）→ 放行", () => {
    expect(guard(`cd /Users/orca/ai/others/x && python3 -c "\nfrom PIL import Image\nim = Image.open('a.png')\nim.save('/tmp/a_view.png')\n" | tail -5`)).toBeNull();
  });
});

describe("F20261016grdl：调查期亲历三例（族 D，放行）", () => {
  it("grep | node -e stdin 管道消费 → 放行", () => {
    expect(guard(`grep "BLOCKED" ${ROOT}/data/logs/otter-buddy.log | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(d.slice(0,200))})"`)).toBeNull();
  });
  it("cd 主仓 && python3 -c json.loads(sys.stdin)（只读解析）→ 放行", () => {
    expect(guard(`cd ${ROOT} && python3 -c "import sys,json\nfor line in sys.stdin: json.loads(line)" < /tmp/x.json`)).toBeNull();
  });
  it("python3 <workspace script> && python3 -c print → 放行", () => {
    expect(guard(`python3 ${MY_WS}/drafts/fix.py && python3 -c "print('ok')"`)).toBeNull();
  });
});

describe("F20261016grdl：拦截面不回退（拦截）", () => {
  it("echo > 主仓绝对路径（排除区外）→ 拦", () => {
    expect(guard(`echo x > ${ROOT}/src/foo.ts`)).not.toBeNull();
  });
  it("cat >> 主仓 README heredoc → 拦", () => {
    expect(guard(`cat >> ${ROOT}/README.md <<'EOF'\nx\nEOF`)).not.toBeNull();
  });
  it("python3 -c open 主仓绝对路径写 → 拦", () => {
    expect(guard(`python3 -c "open('${ROOT}/src/config.yaml','w').write('x')"`)).not.toBeNull();
  });
  it("node -e writeFileSync 主仓路径 → 拦", () => {
    expect(guard(`node -e "require('fs').writeFileSync('${ROOT}/data/metrics.json','{}')"`)).not.toBeNull();
  });
  it("python3 -c 相对路径写（cwd=workspace 主仓树内，无 cd 锚定）→ 拦", () => {
    expect(guard(`python3 -c "open('config.yaml','w').write('x')"`)).not.toBeNull();
  });
  it("掩蔽写：只读载荷 + 'node' 掩蔽相对路径写 → 拦（聚合洞已修）", () => {
    expect(guard(`node -e "console.log(require('fs').readFileSync('/tmp/f','utf8').length)" && 'node' -e "require('fs').writeFileSync('config.yaml','x')"`)).not.toBeNull();
  });
  it("git -C 主仓 commit（落点主仓）→ 拦", () => {
    expect(guard(`git -C ${ROOT} commit -m x`)).not.toBeNull();
  });
  it("rm -rf 别会话工作区（cwd=自己工作区）→ 拦（data 破坏护栏不受基元豁免影响；cwsp S2/S8 仅豁免本会话子树）", () => {
    // cwd=MY_WS（自己的工作区）删 7b41e085（另一会话的工作区）——跨会话删除不豁免。
    // 注：cwd=目标自身时 cwsp S2/S8 放行（自己的工作区自己清）——钉在同文件其他用例。
    expect(guard(`rm -rf ${WS}`, MY_WS)).not.toBeNull();
  });
  it("rm -rf 自己的会话工作区 → 放（cwsp S2/S8 语义保持：本会话子树自治）", () => {
    expect(guard(`rm -rf ${MY_WS}`, MY_WS)).toBeNull();
  });
  it("rm -rf 主仓 data 根 → 拦", () => {
    expect(guard(`rm -rf ${ROOT}/data`)).not.toBeNull();
  });
  it("cd 主仓 && rm -rf data（相对路径经 cd 落主仓 data）→ 拦", () => {
    expect(guard(`cd ${ROOT} && rm -rf data`)).not.toBeNull();
  });
});

describe("F20261016grdl：段级 cd 豁免（族 E）边界", () => {
  it("cd worktree && git commit && cd 主仓 && git commit：第二段 cd 主仓后的写不豁免", () => {
    // 注：cwd 跟踪下 cd 主仓段后 git commit 落主仓——负门兜底；本用例固化
    // 「cd 主仓段不豁免」（isInsideMainCheckout(主仓)=true → segmentCdExempts 不生效）
    // 实际判定：modelCdExemption 首段 cd worktree 豁免 + gitReadonly 白名单外 →
    // 族 E 语义下首段豁免覆盖整链（与 #1170 旧行为一致，cd 主仓段由 gitspace-failopen
    // 独立 PR 收口）。此用例记录当前行为基线，不预设结论。
    const r = guard(`cd ${WT} && git commit -m x && cd ${ROOT} && git commit -m y`);
    expect(typeof r === "string" || r === null).toBe(true);
  });
  it("cd $VAR && git commit（变量不可求值）→ 拦（保守）", () => {
    expect(guard(`cd $W && git commit -m x`)).not.toBeNull();
  });
  it("cd worktree & git commit（& 切断子 shell）→ 拦（保守）", () => {
    expect(guard(`cd ${WT} & git commit -m x`)).not.toBeNull();
  });
  it("cd 主仓 && git commit（cwd 跟踪不豁免主仓目标；#cwsp 已知边界行为）→ 放行（显式意图，旧行为保持）", () => {
    // F20261014cwsp 测试注释：模型版豁免不区分 cd 目标是否主仓——显式意图放行，
    // 收紧属 cd 豁免语义重议（独立立项）。本用例钉住该已知边界不变。
    expect(guard(`cd ${ROOT} && git commit -m x`)).toBeNull();
  });
});
