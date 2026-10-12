/**
 * F20261012gesw：main_write 换岗（求值器主判）切换测试。
 *
 * 三态主判 + 回退开关 + BC 项 + #1395 家族负门（观察期 23 条已裁决形态的
 * 代表性子集——换岗价值的直接证据）+ 旧链防线完整性（负门不破）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";

const ROOT = "/repo";
const WT = "/repo/.otter/worktrees/wt";
const PID = 42877;

function run(cmd: string): string {
  const r = checkBashCommandSafety(cmd, PID, undefined, { projectRoot: ROOT });
  return r === null ? "ALLOW" : "BLOCK";
}

// 回退开关测试用例需独占进程 env——vitest 单进程内 process.env 读写可行（守卫每判读）
afterEach(() => {
  delete process.env.OTTER_GUARD_EVAL_SWITCH;
});

describe("F20261012gesw：求值器主判三态（顶层平面命令）", () => {
  it("evaluated 真写落主仓 → BLOCK（求值器主判生效）", () => {
    expect(run(`git commit -m x`)).toBe("BLOCK");
  });

  it("evaluated 真写落 worktree → ALLOW（#1170 主形态，cd 豁免语义由落点事实继承）", () => {
    expect(run(`cd ${WT} && git add -A && git commit -m x -F /tmp/m.txt`)).toBe("ALLOW");
  });

  it("evaluated 真写落外部项目/tmp → ALLOW（观察期 23 条误拦家族：colink 操作、curl -o /tmp）", () => {
    expect(run(`curl -sL https://x.com/a -o /tmp/out.json`)).toBe("ALLOW");
    expect(run(`touch /tmp/probe.txt`)).toBe("ALLOW");
  });

  it("BC-1 预注册：cd 主仓 && git commit → BLOCK（显式意图豁免退役）", () => {
    expect(run(`cd /repo && git commit -m x`)).toBe("BLOCK");
  });

  it("BC-3 预注册：npm install（无写 token）→ 回落旧链，现状 ALLOW（基线实测：现役旧链本就不拦 npm install——预注册「保守拦」假设不成立，判据实维现状；node_modules 运行时写不属静态落点面）", () => {
    expect(run(`npm install`)).toBe("ALLOW");
  });

  it("只读脚本载荷（write=false 披露）不构成拦截：python open 读主仓 data → ALLOW（#1416 家族不回归）", () => {
    expect(run(`python3 -c "print(open('data/x.json').read())"`)).toBe("ALLOW");
  });

  it("脚本写调用落主仓 → BLOCK（Form A 窄提取写侧）", () => {
    expect(run(`node -e "require('fs').writeFileSync('data/x','y')"`)).toBe("BLOCK");
  });

  it("脚本载荷无写 token（os.remove 等未枚举面）→ 回落旧链白名单兜底（fail-closed 不旁路）", () => {
    expect(run(`python3 -c "import os; os.remove('data/x')"`)).toBe("BLOCK");
  });
});

describe("F20261012gesw：段级 cwd 语义（实测修复回归钉死）", () => {
  it("git commit && cd /tmp（写在前）→ BLOCK（旧算法误把 commit 算到 /tmp——段级 cwd 修复）", () => {
    expect(run(`git commit -m x && cd /tmp`)).toBe("BLOCK");
  });

  it("cd /wt & git commit（& 右段不继承左侧 cd）→ BLOCK（并发右段在主仓跑）", () => {
    expect(run(`cd ${WT} & git commit -m y`)).toBe("BLOCK");
  });

  it("cd /wt | git commit（管道右段不继承左侧 cd）→ BLOCK", () => {
    expect(run(`cd ${WT} | git commit -m y`)).toBe("BLOCK");
  });
});

describe("F20261012gesw：嵌套载荷不接主判（data 载荷感知不旁路）", () => {
  it("bash -c 'mv data/metrics /tmp/' → BLOCK（judgeShellCSegment data 感知保留——实测回归钉死）", () => {
    expect(run(`bash -c 'mv data/metrics /tmp/'`)).toBe("BLOCK");
  });

  it("bash -c 'cd wt && touch a' → 旧链判定（cd 豁免面）ALLOW", () => {
    expect(run(`bash -c 'cd ${WT} && touch a'`)).toBe("ALLOW");
  });

  it("#1240 heredoc 负门：cd /tmp && python heredoc 写主仓 → BLOCK（体级负门保持）", () => {
    expect(run(`cd /tmp && python3 - <<'PY'\nopen("/repo/data/x","w")\nPY`)).toBe("BLOCK");
  });
});

describe("F20261012gesw：旧链防线完整性（换岗不破负门）", () => {
  it("重定向落主仓 cwd → BLOCK", () => {
    expect(run(`git log > /repo/hacked.txt`)).toBe("BLOCK");
  });

  it("#1363 灰区闭合：cd wt 后写主仓绝对路径 → BLOCK（EVAL_GAIN 转正）", () => {
    expect(run(`cd ${WT} && git add /repo/docs/x.md`)).toBe("BLOCK");
    expect(run(`cd ${WT} && node -e "require('fs').writeFileSync('/repo/hacked.txt','x')"`)).toBe("BLOCK");
  });

  it("$W/.. 爬升（#1381 负门）→ 回落旧链（保守面保持）", () => {
    expect(run(`W=${WT}; cd $W/../../../main && touch foo`)).toBe("ALLOW"); // 旧链放（#1363 灰区家族）——但 #1381 求值器回落，非主判终局
  });

  it("工作区 sandbox 豁免保留：重定向落 data/workspaces/ → ALLOW（F20260923hsyn 口径）", () => {
    expect(run(`tail -5 /tmp/x.log >> ${ROOT}/data/workspaces/conv1/report.log`)).toBe("ALLOW");
  });
});

describe("F20261012gesw：#1395 家族负门（观察期 23 条裁决形态代表——换岗价值证据）", () => {
  it("colink/kelp 外部项目操作（cd 外部仓 && npm run / git 操作）→ ALLOW", () => {
    expect(run(`cd /Users/x/ai/others/colink && npm run build`)).toBe("ALLOW");
    expect(run(`cd /Users/x/ai/others/kelp && git status`)).toBe("ALLOW");
  });

  it("worktree 内跑测试 → ALLOW（观察期 2 条形态）", () => {
    expect(run(`cd ${WT} && npx vitest run tests/a.test.ts 2>&1 | tail -5`)).toBe("ALLOW");
  });

  it("纯 HTTP 请求 + 读临时文件（无 cd 无写）→ ALLOW（观察期典型条）", () => {
    expect(run(`curl -s http://localhost:3000/api/health | head -20 && cat /tmp/rhi_open.json | head -3`)).toBe("ALLOW");
  });

  it("node -e 写 worktree | tail → BLOCK（delta eba7c738：载荷面禁终局放，回落旧链——换岗修复的直接证据改由非载荷面语料 rescue 承担）", () => {
    expect(run(`cd ${WT} && node -e "require('fs').writeFileSync('${WT}/data/x','1')" | tail -1`)).toBe("BLOCK");
  });
});

describe("F20261012gesw：回退开关（预注册回退条件）", () => {
  it("OTTER_GUARD_EVAL_SWITCH=0 → 旧链全量判定（BC-1 形态回退为放行）", () => {
    process.env.OTTER_GUARD_EVAL_SWITCH = "0";
    expect(run(`cd /repo && git commit -m x`)).toBe("ALLOW"); // 旧链显式意图豁免
    expect(run(`git commit -m x`)).toBe("BLOCK"); // 旧链词面判定仍拦
    expect(run(`cd ${WT} && git add -A`)).toBe("ALLOW");
  });

  it("开关默认开（缺省 '1'）→ 求值器主判生效", () => {
    expect(run(`cd /repo && git commit -m x`)).toBe("BLOCK");
  });
});
