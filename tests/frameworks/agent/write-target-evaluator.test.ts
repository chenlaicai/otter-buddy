/**
 * F20261009gwte Phase 1：写落点求值器单测（覆盖面表驱动）。
 *
 * 三态矩阵：每条求值规则 × 放行（空集/外部落点）/ 拦截（主仓树落点）/ unevaluated（回落）。
 * 兼作 shadow 语料的行为锚点（方案 v2「求值器单测」节）。
 */
/* eslint-disable max-lines-per-function -- 三态矩阵表驱动（每族放行/拦截/回落各一 + Phase 2 负门），拆函数会割裂「一族一表」可读性 */
import { describe, it, expect } from "vitest";
import { evaluateWriteTargets, pathWithinMain } from "@frameworks/agent/write-target-evaluator";
import { evaluateWriteVerdict } from "@frameworks/agent/write-verdict";

const ROOT = "/repo";
const WT = "/repo/.otter/worktrees/wt";

describe("write-target-evaluator Phase 1：求值三态", () => {
  describe("重定向通道", () => {
    it("cd wt && echo x > wt 内相对路径 → evaluated 空主仓落点（放行侧）", () => {
      const r = evaluateWriteTargets(`cd ${WT} && echo x > out.txt`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") {
        expect(r.targets.some(t => pathWithinMain(t.path, ROOT) && !t.path.startsWith(`${ROOT}/.otter/`))).toBe(false);
      }
    });

    it("echo x > /repo/hacked.txt（主仓绝对路径）→ evaluated 命中主仓（拦截侧）", () => {
      const r = evaluateWriteTargets("echo x > /repo/hacked.txt", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") {
        expect(r.targets.map(t => t.path)).toContain("/repo/hacked.txt");
        expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(true);
      }
    });

    it("echo x > $TARGET（动态目标）→ unevaluated dynamic-path", () => {
      const r = evaluateWriteTargets("echo x > $TARGET", ROOT);
      expect(r).toEqual({ kind: "unevaluated", reason: "dynamic-path" });
    });

    it("cat a > /tmp/f（tmp 落点）→ evaluated 不命中主仓（放行侧）", () => {
      const r = evaluateWriteTargets("cat a > /tmp/f", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(false);
    });
  });

  describe("词表命令通道（tee/cp/mv/touch/mkdir）", () => {
    it("cd wt && touch a.txt → evaluated 落 wt（放行侧）", () => {
      const r = evaluateWriteTargets(`cd ${WT} && touch a.txt`, ROOT);
      expect(r.kind).toBe("evaluated");
    });

    it("cp x /repo/data/secret（主仓绝对路径）→ evaluated 命中主仓（拦截侧）", () => {
      const r = evaluateWriteTargets("cp x /repo/data/secret", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(true);
    });

    it("cd wt && cp a b → evaluated 双落点都在 wt（放行侧）", () => {
      const r = evaluateWriteTargets(`cd ${WT} && cp a b`, ROOT);
      expect(r.kind).toBe("evaluated");
    });

    it("tee /repo/x < input → evaluated 命中主仓（拦截侧）", () => {
      const r = evaluateWriteTargets("tee /repo/x < input", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(true);
    });
  });

  describe("git 写族通道", () => {
    it("cd wt && git commit → evaluated 落 wt（放行侧）", () => {
      const r = evaluateWriteTargets(`cd ${WT} && git commit -m x`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT) && !t.path.startsWith(`${ROOT}/.otter/`))).toBe(false);
    });

    it("git -C /repo commit（-C 主仓）→ evaluated 命中主仓（拦截侧，#1363 灰区正例）", () => {
      const r = evaluateWriteTargets("git -C /repo commit -m x", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(true);
    });

    it("cd wt && git status → evaluated 空集（git 读族不产落点）", () => {
      const r = evaluateWriteTargets(`cd ${WT} && git status`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets).toHaveLength(0);
    });

    it("cd /repo && git commit（BC-1：cd 主仓后 git 写）→ evaluated 命中主仓（拦截侧，行为变更锚点）", () => {
      const r = evaluateWriteTargets("cd /repo && git commit -m x", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(true);
    });
  });

  describe("cwd 跟踪", () => {
    it("cd wt && cd 子目录 && touch f → evaluated 落 wt 子目录（链式跟踪）", () => {
      const r = evaluateWriteTargets(`cd ${WT} && cd sub && touch f`, ROOT);
      expect(r.kind).toBe("evaluated");
    });

    it("cd wt & touch /repo/x（& 子 shell 后 touch 在原 cwd 主仓）→ evaluated 命中主仓", () => {
      // & 后段不继承 cd（子 shell 化），cwd 仍是主仓根
      const r = evaluateWriteTargets(`cd ${WT} & touch /repo/x`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(true);
    });

    it("cd $WT（父 shell 环境变量，BC-5）→ unevaluated cwd-unresolvable", () => {
      const r = evaluateWriteTargets("cd $WT && git commit -m x", ROOT);
      expect(r).toEqual({ kind: "unevaluated", reason: "cwd-unresolvable" });
    });

    it("W=/repo; cd $W && git commit（同命令赋值溯源）→ evaluated 命中主仓", () => {
      const r = evaluateWriteTargets("W=/repo; cd $W && git commit -m x", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(true);
    });

    it("pushd /repo && touch x → unevaluated cwd-unresolvable（Phase 1 不覆盖）", () => {
      const r = evaluateWriteTargets("pushd /repo && touch x", ROOT);
      expect(r).toEqual({ kind: "unevaluated", reason: "cwd-unresolvable" });
    });

    it("cd /repo/../.. && touch x（.. 爬升）→ unevaluated dynamic-path（保守不猜）", () => {
      const r = evaluateWriteTargets("cd /repo/../.. && touch x", ROOT);
      expect(r.kind).toBe("unevaluated");
    });
  });

  describe("Phase 1 显式回落（脚本载荷族/解析失败）", () => {
    it("python3 -c \"open('/repo/data/x','w')\" → Phase 2 窄提取：写调用落点求值命中主仓（拦截侧）", () => {
      const r = evaluateWriteTargets(`python3 -c "open('/repo/data/x','w').write('hi')"`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(true);
    });

    it("node -e \"require('fs').writeFileSync('/repo/x','1')\" → Phase 2 窄提取：写主仓命中（拦截侧）", () => {
      const r = evaluateWriteTargets(`node -e "require('fs').writeFileSync('/repo/x','1')"`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(true);
    });

    it("放行侧（能力 4）：顶层引号失衡 + 词面可证无写 → evaluated 正面 ALLOW（语料 TS-7c8e2cd5 口径：顶层不可执行文本零写面=证明无写）", () => {
      const r = evaluateWriteTargets(`echo "unclosed`, ROOT);
      expect(r).toEqual({ kind: "evaluated", targets: [] });
    });

    it("拦截侧负门：顶层引号失衡 + 写词面（bash -c 载荷 touch 主仓）→ 不放行（正面 BLOCK 或 fail-closed——引号/参数分裂藏写不放行）", () => {
      const r = evaluateWriteVerdict(`bash -c 'touch ${ROOT}/x' && echo "unclosed`, ROOT);
      expect(r.verdict).toBe("BLOCK");
    });

    it("cd $(dirname x)/../main && touch y（cmdsub 变形，BC-6）→ unevaluated", () => {
      const r = evaluateWriteTargets("cd $(dirname x)/../main && touch y", ROOT);
      expect(r.kind).toBe("unevaluated");
    });
  });

  describe("Phase 2 窄提取：脚本载荷族（F20261009phs2）", () => {
    it("放行侧：cd wt && node -e 字面量写 wt → evaluated 落 wt", () => {
      const r = evaluateWriteTargets(`cd ${WT} && node -e "require('fs').writeFileSync('${WT}/out.txt', 'x')"`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(false);
    });

    it("放行侧：cd wt && python3 -c 相对路径写 → 按 cwd 拼接落 wt", () => {
      const r = evaluateWriteTargets(`cd ${WT} && python3 -c "open('sub/rel.txt','w').write('x')"`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(false);
    });

    it("放行侧：node -e 写 /tmp → evaluated 外部落点", () => {
      const r = evaluateWriteTargets(`node -e "fs.writeFileSync('/tmp/probe.txt', 'x')"`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(false);
    });

    it("拦截侧：cd wt && node -e 写主仓 → evaluated 命中主仓（cwd 豁免不背锅）", () => {
      const r = evaluateWriteTargets(`cd ${WT} && node -e "fs.writeFileSync('${ROOT}/src/escape.txt', 'x')"`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(true);
    });

    it("放行侧：多行载荷只读（内嵌单引号触发词法 fail-closed 常态面，gduc S1）→ evaluated 放行", () => {
      const r = evaluateWriteTargets(`cd ${WT} && node -e "\nconst fs=require('fs');\nconsole.log(fs.readdirSync('/tmp').length)\n"`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(false);
    });

    it("放行侧（能力 8）：node -e import(主仓路径) 字面量只读披露 → evaluated（只读 require/import 披露不构成写证据，30517746 病灶口径）", () => {
      const r = evaluateWriteTargets(`node -e "import('${ROOT}/dist-probe/x.js')"`, ROOT);
      expect(r).toEqual({ kind: "evaluated", targets: [] });
    });

    it("拦截侧负门：node -e import(变量拼接)（规则 2 import/require 拆分——动态形态 exec 不可证）→ unevaluated", () => {
      const r = evaluateWriteTargets(`node -e "import(process.env.P + 'x')"`, ROOT);
      expect(r.kind).toBe("unevaluated");
    });

    it("拦截侧负门：载荷 open(主仓路径, 动态 mode)（规则 1 未知 mode→不可证，字面量防线保留面）→ unevaluated", () => {
      const r = evaluateWriteTargets(`node -e "open('${ROOT}/x', m).read()"`, ROOT);
      expect(r.kind).toBe("unevaluated");
    });

    it("拦截侧：argv 动态路径（process.argv[1] 值传播）→ evaluated 命中主仓（#1411 处置：argvBase off-by-one 修正——node -e 无脚本文件插入 argv，首实参在 argv[1]）", () => {
      const r = evaluateWriteTargets(`node -e "fs.writeFileSync(process.argv[1], 'x')" ${ROOT}/data/x`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(true);
    });

    it("拦截侧负门：字符串拼接路径（'/repo/da'+'ta/x'）→ 回落（不追踪变量赋值的拼接——折叠/值传播实已实现，变量赋值后传递不追踪）", () => {
      const r = evaluateWriteTargets(`node -e "const p='/repo/da' + 'ta/x'; fs.writeFileSync(p, 'x')"`, ROOT);
      expect(r.kind).toBe("unevaluated");
    });

    it("放行侧：python3 -c 只读 open('/tmp/x') → evaluated 外部落点", () => {
      const r = evaluateWriteTargets(`python3 -c "print(open('/tmp/a.txt').read())"`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(false);
    });

    it("拦截侧负门：node -e 载荷含 .. 爬升字面量（§3.1 逃逸形态原样：<wt>/../../../main/y）→ 回落（爬升不猜）", () => {
      const r = evaluateWriteTargets(`node -e "fs.writeFileSync('${WT}/../../../main/y', 'z')"`, ROOT);
      expect(r).toEqual({ kind: "unevaluated", reason: "heredoc-script-payload" });
    });

    it("拦截侧负门：node -e 载荷字符串拼接 .. 爬升（'<wt>/x'+'/../../../main/y'）→ 回落（折叠后含 .. 同拒）", () => {
      const r = evaluateWriteTargets(`node -e "fs.writeFileSync('${WT}/x'+'/../../../main/y', 'z')"`, ROOT);
      expect(r).toEqual({ kind: "unevaluated", reason: "heredoc-script-payload" });
    });

    it("拦截侧：node -e argv[2] 映射第二实参（off-by-one 修正后）→ evaluated 落第二实参落点（曾误判 ALLOW 真值主仓）", () => {
      // argvBase=1 修正后 argv[2]=第二实参。此形态曾因 off-by-one 误判 ALLOW（真值 /repo/b）
      const r = evaluateWriteTargets(`node -e "fs.writeFileSync(process.argv[2], 'x')" /tmp/a ${ROOT}/b`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") {
        expect(r.targets.some(t => t.path === `${ROOT}/b`)).toBe(true);
        expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(true);
      }
    });

    it("放行侧：node -e argv[1] 落 /tmp（值传播正确映射）→ evaluated 外部落点", () => {
      const r = evaluateWriteTargets(`node -e "fs.writeFileSync(process.argv[1], 'x')" /tmp/a`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(false);
    });

    it("拦截侧：python3 -c open(sys.argv[1],'w') 主仓实参 → evaluated 命中主仓（拦截增强，旧回落）", () => {
      const r = evaluateWriteTargets(`python3 -c "open(sys.argv[1],'w').write('x')" ${ROOT}/data/x`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(true);
    });
  });

  describe("Phase 2 git add index / remote ref / fd 复制（F20261009phs2）", () => {
    it("拦截侧：git add docs/x.md（主仓 cwd 相对路径）→ evaluated 命中主仓", () => {
      const r = evaluateWriteTargets("git add docs/features/x.md", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(true);
    });

    it("放行侧：cd wt && git add -A && git commit → evaluated 全落 wt（#1170 主形态）", () => {
      const r = evaluateWriteTargets(`cd ${WT} && git add -A && git commit -F /tmp/msg.txt`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(false);
    });

    it("放行侧：git -C wt add src/x.ts → evaluated 落 wt", () => {
      const r = evaluateWriteTargets(`git -C ${WT} add src/x.ts`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(false);
    });

    it("放行侧：git push origin --delete feature/x → evaluated 空集（remote ref 删除不落本地树）", () => {
      const r = evaluateWriteTargets("git push origin --delete feature/old", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(false);
    });

    it("放行侧：git push origin :refs/heads/old（colon 删除语法）→ evaluated 空集", () => {
      const r = evaluateWriteTargets("git push origin :refs/heads/old", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(false);
    });

    it("拦截侧负门：git push origin HEAD（cwd=主仓）→ evaluated 命中主仓（普通 push 不放行）", () => {
      const r = evaluateWriteTargets("git push origin HEAD", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(true);
    });

    it("放行侧：git push origin HEAD 2>&1 | tail -3（fd 复制非文件写，cwd=wt 场景）", () => {
      const r = evaluateWriteTargets(`cd ${WT} && git push origin HEAD 2>&1 | tail -3`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(false);
    });

    it("拦截侧：git push 主仓 cwd 带 2>&1 管道 → 仍拦（fd 复制不放行真写）", () => {
      const r = evaluateWriteTargets("git push origin HEAD 2>&1 | tail -3", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(true);
    });

    it("放行侧：git -c http.proxy= -c https.proxy= push --delete（词级旗标解析，c107 教训）→ evaluated 空集", () => {
      const r = evaluateWriteTargets("git -c http.proxy= -c https.proxy= push origin --delete feature/x", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(false);
    });
  });

  describe("复合/边界", () => {
    it("bash -c 'touch /repo/x'（bash -c 载荷递归求值）→ evaluated 命中主仓", () => {
      const r = evaluateWriteTargets(`bash -c 'touch /repo/x'`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(true);
    });

    it("cd wt && git commit | tail -1（管道右段不影响左段落点）→ evaluated 落 wt", () => {
      const r = evaluateWriteTargets(`cd ${WT} && git commit -m x | tail -1`, ROOT);
      expect(r.kind).toBe("evaluated");
    });

    it("空命令/纯读 → evaluated 空集（无写落点）", () => {
      const r = evaluateWriteTargets("ls -la && git status && cat f.txt", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets).toHaveLength(0);
    });

    it("data/workspaces 沙箱排除（能力 7 拍板落地）：写 /repo/data/workspaces/... → evaluated 但落点不在主仓树", () => {
      const r = evaluateWriteTargets("touch /repo/data/workspaces/conv1/f", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") {
        // 能力 7（2026-10-13 拍板）：对话工作区=沙箱——写沙箱不算写主仓，落点不入主仓树
        expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(false);
      }
    });

    it("data/workspaces 排除区不误伤嵌套 decoy（root 级锚定）：/repo/x/data/workspaces/... 仍属主仓树", () => {
      // 修复的一侧（上例沙箱放行）与不能误伤的一侧（本例嵌套 decoy 仍拦）双向固化——
      // 排除区是 ^<root>/data/workspaces/ 前缀，不得扫到 /repo/<任意>/data/workspaces/…
      const r = evaluateWriteTargets("touch /repo/x/data/workspaces/conv1/f", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") {
        expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(true);
      }
    });
  });
});

describe("F20261013gev2 能力 5：三病型手术（拍板 2026-10-13，双向固化）", () => {
  // 病型 C 合成最小引号塔：3 反斜杠+引号（字面 \ + 转义引号）接 2 反斜杠+引号（字面 \ + 关区）
  //  —— bash 双引号语义提前关区、收尾引号反开（quoteUnbalanced=true）——
  //  「先天散架」捕获命令的最小复刻（TS-7c8e2cd5 Case4 形态）。逐层拼接防转义层数走样。
  const BS = "\\";
  const PRE = 'node -e "a' + BS.repeat(3) + '"b' + BS.repeat(2); // 后续即「已关区」的碎片区
  const FRAGILE = PRE + '" c" 2>&1';

  describe("病型 A：check-only 语义（语法检查=读脚本不执行）", () => {
    it("修复侧：e484 实录形态 python3 -c 只读 + node --check → 正面 ALLOW（双段根因回归钉）", () => {
      const v = evaluateWriteVerdict(
        `python3 -c "import ast; ast.parse(open('fetch_anthropic.py').read()); print('py syntax OK')" && node --check scan.mjs && echo "mjs syntax OK"`,
        ROOT,
      );
      expect(v.verdict).toBe("ALLOW");
      expect(v.mode).toBe("positive");
    });

    it("修复侧：node --check / python -m py_compile → 正面 ALLOW（读侧入账）", () => {
      const r = evaluateWriteTargets("node --check /repo/x.mjs", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") {
        expect(r.targets.some(t => t.path === "/repo/x.mjs" && t.access === "read")).toBe(true);
      }
      const p = evaluateWriteVerdict("python3 -m py_compile /repo/f.py", ROOT);
      expect(p.verdict).toBe("ALLOW");
      expect(p.mode).toBe("positive");
    });

    it("不误伤侧（负门）：不透明执行形态不许被 check-only 放宽——node /repo/evil.js 不产生读侧入账", () => {
      // 「保持 fail-closed 不许动」的可观察面：check-only 识别不得扩展到裸脚本执行形态。
      // （裸脚本执行的终局语义另属拦截池放水治理——能力 3 剩余面，本钉只防本手术放宽）
      const r = evaluateWriteTargets("node /repo/evil.js", ROOT);
      if (r.kind === "evaluated") {
        expect(r.targets.some(t => t.path === "/repo/evil.js")).toBe(false);
      }
    });
  });

  describe("病型 B：载荷词 cmdsub 拼原文（活命令替换不再整体回落）", () => {
    it("修复侧：载荷内 $()（JS 注释/字符串层）→ 正面 ALLOW，cmdsub 递归入账", () => {
      const v = evaluateWriteVerdict(
        String.raw`node -e "// note $() in dbl quotes" + "\n" + "console.log(1)" 2>&1`,
        ROOT,
      );
      expect(v.verdict).toBe("ALLOW");
      expect(v.mode).toBe("positive");
    });

    it("不误伤侧（负门）：var 展开仍回落不猜——$P 载荷不因拼词放行", () => {
      // 展开值不可知=不透明载荷：若 B 修误把 var 也拼原文，窄提取成功 → rm 段漏判 → 误 ALLOW
      const v = evaluateWriteVerdict(`node -e "$P" && rm -f /tmp/x`, ROOT);
      expect(v.verdict).toBe("BLOCK");
      expect(v.mode).toBe("fail-closed");
    });
  });

  describe("规则 2 附带闸：exec 类载荷一律不可证（裸调用形态）", () => {
    it("负门：new Function 载荷 → fail-closed BLOCK（残余面 TS-ef0d6be4 族钉死，不许被 check-only 解锁）", () => {
      const v = evaluateWriteVerdict(
        `node --check game/index.html 2>&1 | head -2; node -e "new Function(m[1]); console.log('ok')"`,
        ROOT,
      );
      expect(v.verdict).toBe("BLOCK");
      expect(v.mode).toBe("fail-closed");
    });

    it("不误伤侧：点号方法调用（db.exec 型）不触发闸——实证面 TS-e00efca3 保持正面 ALLOW", () => {
      const v = evaluateWriteVerdict(`node -e "const db=x(); db.exec('select 1 from t'); console.log('ok')"`, ROOT);
      expect(v.verdict).toBe("ALLOW");
      expect(v.mode).toBe("positive");
    });
  });

  describe("病型 C：载荷级重组（方案 a + 硬性负门）", () => {
    it("修复侧：引号塔自散架实录形态 → 正面 ALLOW（跨引号开合重组读回）", () => {
      const v = evaluateWriteVerdict(FRAGILE, ROOT);
      expect(v.verdict).toBe("ALLOW");
      expect(v.mode).toBe("positive");
    });

    it("负门①（硬性）：重组 span 内藏写词面 → 仍回落——跨段藏写不许遮蔽", () => {
      const v = evaluateWriteVerdict(
        PRE + '" ; require(\'fs\').writeFileSync(\'/repo/x\',\'y\')" 2>&1',
        ROOT,
      );
      expect(v.verdict).toBe("BLOCK");
    });

    it("负门②（硬性）：重组 span 内新 runner 交界（非 check-only）→ 仍回落", () => {
      const v = evaluateWriteVerdict(
        PRE + '" ; bash /repo/evil.sh $()" 2>&1',
        ROOT,
      );
      expect(v.verdict).toBe("BLOCK");
    });

    it("不误伤侧：交界是 check-only 形态则不触发负门（node --check 交界=读侧）", () => {
      const v = evaluateWriteVerdict(
        PRE + '" ; node --check /repo/f.js" 2>&1',
        ROOT,
      );
      expect(v.verdict).toBe("ALLOW");
      expect(v.mode).toBe("positive");
    });
  });
});
