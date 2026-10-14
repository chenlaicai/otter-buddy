/**
 * F20261009gwte Phase 1：写落点求值器单测（覆盖面表驱动）。
 *
 * 三态矩阵：每条求值规则 × 放行（空集/外部落点）/ 拦截（主仓树落点）/ unevaluated（回落）。
 * 兼作 shadow 语料的行为锚点（方案 v2「求值器单测」节）。
 */
/* eslint-disable max-lines-per-function -- 三态矩阵表驱动（每族放行/拦截/回落各一 + Phase 2 负门），拆函数会割裂「一族一表」可读性 */
import { describe, it, expect } from "vitest";
import { evaluateWriteTargets, pathWithinMain, resolveCwdAt } from "@frameworks/agent/write-target-evaluator";
import { parseOnce } from "@frameworks/agent/command-model";
import { SCRIPT_EXEC_FACE, dotExecCommandHits, proveNoWrite } from "@frameworks/agent/write-word-face";
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

    it("放行侧：git push origin HEAD（远端目标）→ evaluated 空集（双签口径 2026-10-12：外部写不落本地树）", () => {
      // 【期望变更（已废：普通 push 主仓 cwd 判写）】双签口径明文「git push（远端目标）归非写放行」
      // （TS-6a5cc1b2「gh issue comment（外部写不落本地树）」同族；语料 10 条 push 条目同判）
      const r = evaluateWriteTargets("git push origin HEAD", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(false);
    });

    it("拦截侧负门：git push 本地路径目标（push /repo/x）→ 按落点判命中主仓（本地例外不随远端口径放行）", () => {
      const r = evaluateWriteTargets("git push /repo/x feature/y", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(true);
    });

    it("放行侧：git push origin HEAD 2>&1 | tail -3（fd 复制非文件写，cwd=wt 场景）", () => {
      const r = evaluateWriteTargets(`cd ${WT} && git push origin HEAD 2>&1 | tail -3`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(false);
    });

    it("拦截侧：git commit 主仓 cwd 带 2>&1 管道 → 仍拦（fd 复制不放行真写）", () => {
      // 【期望变更（已废：push 版）】命令体换真写写族（commit）——原用例以 push 为写载体，
      //  push 远端=非写后该载体不再构成真写；负门语义（fd 复制不救真写）由 commit 写族继续钉住。
      const r = evaluateWriteTargets("git commit -m x 2>&1 | tail -3", ROOT);
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

describe("F20261013gev2 能力 1：heredoc 体脚本投递（stdin 载荷=脚本，双向固化）", () => {
  describe("放行侧（正面 ALLOW）", () => {
    it("python3 - <<'EOF' 只读体（无写调用）→ 正面 ALLOW（TS-76af6ee1 形态）", () => {
      const cmd = "cd /repo/.otter/worktrees/wt && python3 - <<'EOF'\nimport subprocess\nr = subprocess.run(['node', '/tmp/launch.mjs', '/tmp/app.log'], cwd='/tmp', capture_output=True, text=True)\nprint('launcher:', r.stdout.strip()[:50])\nEOF";
      const v = evaluateWriteVerdict(cmd, ROOT);
      expect(v.verdict).toBe("ALLOW");
      expect(v.mode).toBe("positive");
    });

    it("cd wt && python3 - <<'EOF' 体写 worktree 相对路径 → 正面 ALLOW（落点随调用 cwd）", () => {
      const cmd = `cd ${WT} && python3 - <<'EOF'\nwith open('out.txt', 'w') as f:\n    f.write('x')\nEOF`;
      const v = evaluateWriteVerdict(cmd, ROOT);
      expect(v.verdict).toBe("ALLOW");
      expect(v.mode).toBe("positive");
    });

    it("bash - <<'EOF' 体写 /tmp → 正面 ALLOW（shell 体递归求值，体外落点不拦）", () => {
      const v = evaluateWriteVerdict("bash - <<'EOF'\ntouch /tmp/x\nEOF", ROOT);
      expect(v.verdict).toBe("ALLOW");
      expect(v.mode).toBe("positive");
    });

    it("数据 heredoc 负门：cat > /tmp/d.txt <<'EOF' 体含 touch 主仓 → 仍正面 ALLOW（体=数据不执行，#1171 语义保持）", () => {
      const v = evaluateWriteVerdict("cat > /tmp/d.txt <<'EOF'\ntouch /repo/x\nEOF", ROOT);
      expect(v.verdict).toBe("ALLOW");
      expect(v.mode).toBe("positive");
    });

    it("sh -n <<'EOF'（语法检查不执行体）→ 正面 ALLOW（体写词面不构成写事实）", () => {
      const v = evaluateWriteVerdict("sh -n <<'EOF'\ntouch /repo/x\nEOF", ROOT);
      expect(v.verdict).toBe("ALLOW");
      expect(v.mode).toBe("positive");
    });
  });

  describe("拦截侧（主仓落点/回落均 BLOCK）", () => {
    it("bash - <<'EOF' 体 touch 主仓 → BLOCK 落点证据（TS-c047 放水面钉回）", () => {
      const v = evaluateWriteVerdict("bash - <<'EOF'\ntouch /repo/x\nEOF", ROOT);
      expect(v.verdict).toBe("BLOCK");
      if (v.verdict === "BLOCK" && v.mode === "positive") {
        expect(v.mainHits.map(t => t.path)).toContain("/repo/x");
      } else {
        throw new Error(`expected positive BLOCK, got ${JSON.stringify(v)}`);
      }
    });

    it("cd wt && python3 - <<'EOF' 体写主仓绝对路径 → BLOCK 落点证据", () => {
      const cmd = `cd ${WT} && python3 - <<'EOF'\nopen('/repo/x', 'w').write('y')\nEOF`;
      const v = evaluateWriteVerdict(cmd, ROOT);
      expect(v.verdict).toBe("BLOCK");
      if (v.verdict === "BLOCK" && v.mode === "positive") {
        expect(v.mainHits.map(t => t.path)).toContain("/repo/x");
      } else {
        throw new Error(`expected positive BLOCK, got ${JSON.stringify(v)}`);
      }
    });

    it("node <<'EOF' 体 writeFileSync 主仓 → BLOCK 落点证据（JS 体同判据）", () => {
      const v = evaluateWriteVerdict("node <<'EOF'\nrequire('fs').writeFileSync('/repo/x', 'y')\nEOF", ROOT);
      expect(v.verdict).toBe("BLOCK");
    });

    it("条件双态：bash - <<'EOF' touch out.txt——cwd=主仓 BLOCK / cwd=wt ALLOW（相对落点随调用 cwd）", () => {
      const cmd = "bash - <<'EOF'\ntouch out.txt\nEOF";
      const main = evaluateWriteVerdict(cmd, ROOT, ROOT);
      expect(main.verdict).toBe("BLOCK");
      const wt = evaluateWriteVerdict(cmd, ROOT, WT);
      expect(wt.verdict).toBe("ALLOW");
      expect(wt.mode).toBe("positive");
    });
  });

  describe("回落负门（不可证不猜）", () => {
    it("裸定界体含展开（$/`）→ fail-closed（展开值不猜）", () => {
      const v = evaluateWriteVerdict("python3 - <<EOF\nopen('$F', 'w')\nEOF", ROOT);
      expect(v.verdict).toBe("BLOCK");
      if (v.verdict === "BLOCK" && v.mode === "fail-closed") {
        expect(v.reason).toBe("heredoc-script-payload");
      } else {
        throw new Error(`expected fail-closed, got ${JSON.stringify(v)}`);
      }
    });

    it("体含 exec 裸调用 → fail-closed（规则 2 附带闸对 heredoc 体同效）", () => {
      const v = evaluateWriteVerdict("python3 - <<'EOF'\neval('x')\nEOF", ROOT);
      expect(v.verdict).toBe("BLOCK");
      if (v.verdict === "BLOCK" && v.mode === "fail-closed") {
        expect(v.reason).toBe("heredoc-script-payload");
      } else {
        throw new Error(`expected fail-closed, got ${JSON.stringify(v)}`);
      }
    });

    it("体含主仓路径字面量 + 全词面证不成立（带写重定向）→ fail-closed（字面量闸同判据，不因投递形态破防）", () => {
      const v = evaluateWriteVerdict("python3 - <<'EOF' > /tmp/log\nimport json\nd = json.load(open('/repo/data/cfg.json'))\nprint(d)\nEOF", ROOT);
      expect(v.verdict).toBe("BLOCK");
      if (v.verdict === "BLOCK" && v.mode === "fail-closed") {
        expect(v.reason).toBe("heredoc-script-payload");
      } else {
        throw new Error(`expected fail-closed, got ${JSON.stringify(v)}`);
      }
    });

    it("体只读主仓字面量但全词面无写 → 词面证正面 ALLOW（能力 4 豁免对 heredoc 体同效）", () => {
      const v = evaluateWriteVerdict("python3 - <<'EOF'\nimport json\nd = json.load(open('/repo/data/cfg.json'))\nprint(d)\nEOF", ROOT);
      expect(v.verdict).toBe("ALLOW");
      expect(v.mode).toBe("positive");
    });
  });
});

describe("F20261014smrj 黑盒外置脚本三牙（工单②，裁决 signal d5f2ae9a）", () => {
  const DO_COMMIT = `#!/bin/sh
WT=/repo/.otter/worktrees/wt
MSG=/tmp/m.txt
git -C "$WT" add src/x.ts
git -C "$WT" commit --author "守卫修复獭 <otter-buddy>" -F "$MSG"
echo "=== commit exit: $? ==="`;

  describe("放行侧（不误伤面）", () => {
    it("静态脚本路径无载荷信息 → 缺席语义零写面正面 ALLOW（「文件不存在→放行」校正口径）", () => {
      const v = evaluateWriteVerdict("bash /tmp/does-not-exist.sh", ROOT);
      expect(v.verdict).toBe("ALLOW");
      expect(v.mode).toBe("positive");
    });

    it("delta2：perl 无括号列表式/字符串式 exec + ruby exec → 拦（SCRIPT_EXEC_FACE 无括号形态）", () => {
      expect(evaluateWriteVerdict(`perl -e "exec 'touch', '/repo/data/pwn'"`, ROOT).verdict).toBe("BLOCK");
      expect(evaluateWriteVerdict(`perl -e "exec 'touch /repo/data/pwn'"`, ROOT).verdict).toBe("BLOCK");
      expect(evaluateWriteVerdict(`ruby -e "exec 'touch /repo/data/pwn'"`, ROOT).verdict).toBe("BLOCK");
    });

    it("delta2：点号方法按参数形态区分——含命令实参→拦；纯 SQL→放（TS-e00efca3 口径不回退）", () => {
      expect(evaluateWriteVerdict(`node -e "require('child_process').exec('touch /repo/data/pwn')"`, ROOT).verdict).toBe("BLOCK");
      expect(evaluateWriteVerdict(`node -e "db.exec('touch /repo/x')"`, ROOT).verdict).toBe("BLOCK");
      const ok = evaluateWriteVerdict(`node -e "const db=x(); db.exec('SELECT a, b FROM t'); console.log('ok')"`, ROOT);
      expect(ok.verdict).toBe("ALLOW");
    });

    it("delta2：未提供载荷且脚本存在 → fail-closed（未接线≠缺席）；/dev/null 为「存在文件」稳定替身", () => {
      expect(evaluateWriteVerdict("bash /dev/null", ROOT)).toMatchObject({ verdict: "BLOCK", mode: "fail-closed", reason: "script-payload-unreadable" });
    });

    it("delta2：显式声明 absent=证明源 → 放（声明+记档校验面，不做 fs 复核）", () => {
      const v = evaluateWriteVerdict("bash /dev/null", ROOT, ROOT, { status: "absent" });
      expect(v.verdict).toBe("ALLOW");
      expect(v.mode).toBe("positive");
    });

    it("载荷缺席显式记档 → 同缺席语义正面 ALLOW", () => {
      const v = evaluateWriteVerdict("sh /tmp/f1fx-commit.sh 2>&1 | tail -4", ROOT, ROOT, { status: "absent" });
      expect(v.verdict).toBe("ALLOW");
      expect(v.mode).toBe("positive");
    });

    it("载荷 content 按重组判读：do-commit 脚本（git -C \"$WT\" 赋值溯源）→ worktree 落点正面 ALLOW（不盲放）", () => {
      const v = evaluateWriteVerdict("bash /tmp/do-commit.sh", ROOT, ROOT, { status: "content", text: DO_COMMIT });
      expect(v.verdict).toBe("ALLOW");
      expect(v.mode).toBe("positive");
      if (v.mode !== "positive") throw new Error("expected positive mode");
      expect(v.targets.some(t => t.path.includes(".otter/worktrees/wt"))).toBe(true);
    });

    it("命令内造脚本再执行（printf 静态内容）→ 按造出内容判读零写面正面 ALLOW", () => {
      const v = evaluateWriteVerdict("cd /tmp/p && printf '%s\\n' 'echo hi' > s.sh && bash s.sh", ROOT);
      expect(v.verdict).toBe("ALLOW");
      expect(v.mode).toBe("positive");
    });

    it("命令内造脚本再执行（定界 heredoc 体）→ 体判读树外落点正面 ALLOW", () => {
      const v = evaluateWriteVerdict("cat > /tmp/patch.sh <<'EOF'\ncd /repo/.otter/worktrees/wt\ncp game/index.html /tmp/bak.html\nEOF\nbash /tmp/patch.sh", ROOT);
      expect(v.verdict).toBe("ALLOW");
      expect(v.mode).toBe("positive");
    });

    it("git -C \"$VAR\" 赋值溯源（evalGitAdd/evalGitWrite 同步修复）→ 按 -C 实参落点判读，不再恒 fail-closed", () => {
      const r = evaluateWriteTargets("WT=/repo/.otter/worktrees/wt\ngit -C \"$WT\" commit --author \"a <b>\" -m hi", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") {
        expect(r.targets.some(t => t.path.includes(".otter/worktrees/wt"))).toBe(true);
      }
    });
  });

  describe("拦截侧（负门面）", () => {
    it("牙1 $(gen).sh 生成路径 → fail-closed script-path-dynamic（不进词面证豁免）", () => {
      const v = evaluateWriteVerdict("bash $(mktemp -u /tmp/gen).sh", ROOT);
      expect(v.verdict).toBe("BLOCK");
      if (v.verdict === "BLOCK" && v.mode === "fail-closed") expect(v.reason).toBe("script-path-dynamic");
    });

    it("牙1 $VAR 变量路径（词面无写词）→ 同样 fail-closed（能力 4 豁免不得洗白牙口）", () => {
      const v = evaluateWriteVerdict("bash $HOME/gen.sh", ROOT);
      expect(v.verdict).toBe("BLOCK");
      if (v.verdict === "BLOCK" && v.mode === "fail-closed") expect(v.reason).toBe("script-path-dynamic");
    });

    it("牙2 造-执内容含主仓写 → 按造出内容判读正面 BLOCK（载荷重组后真写主仓变体）", () => {
      const v = evaluateWriteVerdict("echo \"touch /repo/data/x\" > /tmp/g.sh && bash /tmp/g.sh", ROOT);
      expect(v.verdict).toBe("BLOCK");
      expect(v.mode).toBe("positive");
    });

    it("牙2 造-执内容不可重建（动态参数写脚本）→ fail-closed script-payload-dynamic", () => {
      const v = evaluateWriteVerdict("echo \"$CMD\" > /tmp/g.sh && bash /tmp/g.sh", ROOT);
      expect(v.verdict).toBe("BLOCK");
      if (v.verdict === "BLOCK" && v.mode === "fail-closed") expect(v.reason).toBe("script-payload-dynamic");
    });

    it("牙3 载荷存在但不可读 → fail-closed script-payload-unreadable（「载荷不可读→拦」）", () => {
      const v = evaluateWriteVerdict("bash /tmp/x.sh", ROOT, ROOT, { status: "unreadable" });
      expect(v.verdict).toBe("BLOCK");
      if (v.verdict === "BLOCK" && v.mode === "fail-closed") expect(v.reason).toBe("script-payload-unreadable");
    });

    it("牙3 content 载荷含主仓写词面 → 按内容判读正面 BLOCK（不因脚本投递形态破防）", () => {
      const v = evaluateWriteVerdict("bash /tmp/do-evil.sh", ROOT, ROOT, { status: "content", text: "touch /repo/data/x" });
      expect(v.verdict).toBe("BLOCK");
      expect(v.mode).toBe("positive");
    });

    it("既有通道不误伤：bash -c 'touch 主仓' 仍拦（窄提取通道原语义不动）", () => {
      const v = evaluateWriteVerdict("bash -c 'touch /repo/x'", ROOT);
      expect(v.verdict).toBe("BLOCK");
    });
  });
});

describe("delta3 修法（严重1 execv 族词表 + 严重 2 cwd 错位假缺席证明，检视獭1360 delta3 复核）", () => {
  describe("严重 1：execv 族词族归一（三表 + 整命令双向钉死）", () => {
    it("execv 族整命令四形态 → 拦（os.execv/execvp/execl/execvpe 词内后缀形态，probe2 矩阵钉死）", () => {
      for (const cmd of [
        `python3 -c "import os; os.execv('/bin/sh', ['sh', '-c', 'touch /repo/data/pwn'])"`,
        `python3 -c "import os; os.execvp('touch', ['touch', '/repo/data/pwn'])"`,
        `python3 -c "import os; os.execl('/bin/sh', 'sh', '-c', 'touch /repo/data/pwn'])"`,
        `python3 -c "import os; os.execvpe('touch', ['touch', '/repo/data/pwn'], {})"`,
      ]) {
        expect(evaluateWriteVerdict(cmd, ROOT).verdict, cmd).toBe("BLOCK");
      }
    });

    it("execv 族词面三表口径：点号形态 dotExecCommandHits/proveNoWrite 收；裸形态 SCRIPT_EXEC_FACE 收（lookbehind 词界既定口径）", () => {
      expect(dotExecCommandHits("import os; os.execv('/bin/sh', [...])")).toBe(true);
      expect(proveNoWrite(`python3 -c "import os; os.execv('/bin/sh', [...])"`)).toBe(false);
      expect(SCRIPT_EXEC_FACE.test("execvp('touch', ['touch'])")).toBe(true);
      // 点号形态不进裸表——db.exec 纯 SQL 豁免面（TS-e00efca3）依赖此词界
      expect(SCRIPT_EXEC_FACE.test("os.execv('/bin/sh', [...])")).toBe(false);
    });

    it("对照：纯 SQL 点号方法不误伤（TS-e00efca3 口径）+ execute/executor 词不收进 exec 族", () => {
      const ok = evaluateWriteVerdict(`node -e "const db=x(); db.exec('SELECT a, b FROM t'); console.log('ok')"`, ROOT);
      expect(ok.verdict).toBe("ALLOW");
      expect(dotExecCommandHits("db.execute('SELECT 1')")).toBe(false);
      expect(SCRIPT_EXEC_FACE.test("executor.submit()")).toBe(false);
    });

    it("对照：execv 只读目标仍拦——规则 2 exec 类一律不可证（同 residual_face execSync 口径）", () => {
      expect(evaluateWriteVerdict(`python3 -c "import os; os.execv('/bin/echo', ['echo', 'hi'])"`, ROOT).verdict).toBe("BLOCK");
    });
  });

  describe("严重 2：cd $VAR 全来源攻击链 + 缺席证明三前提", () => {
    it("cd $VAR 全来源攻击链 → 拦（export/环境变量/多段链/bash -c 载荷层/段首直执/无后缀脚本位）", () => {
      for (const cmd of [
        "export DIR=/tmp/delta3-attack-1360; cd $DIR && bash x.sh",
        "cd $DIR && bash x.sh",
        "cd $DIR && cd sub && bash x.sh",
        `bash -c "cd $DIR && bash x.sh"`,
        "cd $DIR && ./x.sh",
        "cd $DIR && bash x",
        "cd $DIR && bash /tmp/x.sh",
        "cd $DIR && sh -c \"bash x.sh\"",
      ]) {
        expect(evaluateWriteVerdict(cmd, ROOT).verdict, cmd).toBe("BLOCK");
      }
    });

    it("对照：赋值语句可溯源 + 真缺席脚本 → 正面放（缺席证明三前提成立，probe3「缺席正确放」口径）", () => {
      const v = evaluateWriteVerdict("DIR=/tmp; cd $DIR && bash no-such-8f3a91c2.sh", ROOT);
      expect(v.verdict).toBe("ALLOW");
      expect(v.mode).toBe("positive");
    });

    it("对照：可溯源 cd + 存在脚本 → fail-closed unreadable（/dev/null 稳定替身）", () => {
      expect(evaluateWriteVerdict("cd /dev && bash null", ROOT)).toMatchObject({
        verdict: "BLOCK", mode: "fail-closed", reason: "script-payload-unreadable",
      });
    });

    it("resolveCwdAt 一条语义一个接口：赋值溯源出 / export+env 溯源不出 / pushd 不可锚定 / 管道 cd 不外溢", () => {
      expect(resolveCwdAt(parseOnce("DIR=/tmp; cd $DIR && bash x.sh", 0).segments, "/repo")).toEqual(["/repo", "/repo", "/tmp"]);
      expect(resolveCwdAt(parseOnce("export DIR=/tmp; cd $DIR && bash x.sh", 0).segments, "/repo")).toBeNull();
      expect(resolveCwdAt(parseOnce("cd $DIR && bash x.sh", 0).segments, "/repo")).toBeNull();
      expect(resolveCwdAt(parseOnce("pushd /tmp", 0).segments, "/repo")).toBeNull();
      expect(resolveCwdAt(parseOnce("echo hi | cd /tmp", 0).segments, "/repo")).toEqual(["/repo", "/repo"]);
    });

    it("段链从启动 cwd 忠实重放：写在 cd 前落启动 cwd（主仓写不许挪去链尾 sandbox——附带发现）", () => {
      const r = evaluateWriteVerdict("echo x > pwn.txt && cd /tmp", ROOT);
      expect(r.verdict).toBe("BLOCK");
      expect(r.mode).toBe("positive");
      if (r.mode === "positive") {
        expect(r.targets.some(t => t.path === "/repo/pwn.txt")).toBe(true);
      }
    });

    it("载荷子模型缺席证明锚定：外层 cd 链 + bash -c 内层脚本 → 不出缺席证明（fail-closed）", () => {
      expect(evaluateWriteVerdict(`cd /dev && bash -c "bash x.sh"`, ROOT)).toMatchObject({ verdict: "BLOCK", mode: "fail-closed" });
    });

    it("对照：无 cd 链 + bash -c 内层缺席脚本 → 正面放（锚定成立，缺席证明有效）", () => {
      const v = evaluateWriteVerdict(`bash -c "bash no-such-8f3a91c2.sh"`, ROOT);
      expect(v.verdict).toBe("ALLOW");
    });

    it("显式缺席声明豁免不透明执行否决（82d56ad0 回归钉：截断命令 parseOk=false 洗白口）", () => {
      const cmd = `bash /dev/null 2>&1 | tail -3; echo '`;
      const v = evaluateWriteVerdict(cmd, ROOT, ROOT, { status: "absent" });
      expect(v.verdict).toBe("ALLOW");
      expect(v.mode).toBe("positive");
      expect(evaluateWriteVerdict(cmd, ROOT).verdict).toBe("BLOCK");
    });

    it("对照：注释/提及不构成执行面（TS-074e7d85 // 注释行 / TS-0cdf6695 提及字样回归钉）", () => {
      const v = evaluateWriteVerdict(`node -e 'const x=1; // find old big-otter\nconsole.log(x)'`, ROOT);
      expect(v.verdict).toBe("ALLOW");
      const v2 = evaluateWriteVerdict(`node -e 'print("bash toolCall")'`, ROOT);
      expect(v2.verdict).toBe("ALLOW");
    });
  });
});

describe("delta4 修法（严重 1：段首直执行位同构三态，检视獭1360 delta4 复核）", () => {
  it("直执真存在 → fail-closed unreadable（/dev/null 稳定替身）——与 bash 同链一视同仁", () => {
    expect(evaluateWriteVerdict("/dev/null", ROOT)).toMatchObject({
      verdict: "BLOCK", mode: "fail-closed", reason: "script-payload-unreadable",
    });
    expect(evaluateWriteVerdict("bash /dev/null", ROOT)).toMatchObject({
      verdict: "BLOCK", mode: "fail-closed", reason: "script-payload-unreadable",
    });
  });

  it("直执真不存在 → 正面放（缺席证明同构三态缺席臂）", () => {
    const v = evaluateWriteVerdict("/tmp/no-such-smrj-1360.sh", ROOT);
    expect(v.verdict).toBe("ALLOW");
    expect(v.mode).toBe("positive");
  });

  it("造-执对同构：echo 造出内容判读（touch 主仓）+直执/bash 双链 → 拦", () => {
    expect(evaluateWriteVerdict("echo touch /repo/data/pwn > /tmp/x-smrj.sh && /tmp/x-smrj.sh", ROOT).verdict).toBe("BLOCK");
    expect(evaluateWriteVerdict("echo touch /repo/data/pwn > /tmp/x-smrj.sh && bash /tmp/x-smrj.sh", ROOT).verdict).toBe("BLOCK");
  });

  it("对照：造-执对零写面内容 → 正面放（内容判读成立，三态内容臂）", () => {
    const v = evaluateWriteVerdict("echo echo hi > /tmp/x-smrj.sh && /tmp/x-smrj.sh", ROOT);
    expect(v.verdict).toBe("ALLOW");
    expect(v.mode).toBe("positive");
  });

  it("对照：不可求值直执路径（含 ..）→ script-path-dynamic fail-closed；替换型载荷垃圾解析不误收（能力 8 口径不回归）", () => {
    expect(evaluateWriteVerdict("/tmp/d/../x-smrj.sh", ROOT)).toMatchObject({
      verdict: "BLOCK", mode: "fail-closed", reason: "script-path-dynamic",
    });
    const v = evaluateWriteVerdict(`node -e "import('/repo/dist-probe/x.js')"`, ROOT);
    expect(v.verdict).toBe("ALLOW");
    expect(evaluateWriteVerdict(`node -e 'const x=1; // find old\nconsole.log(x)'`, ROOT).verdict).toBe("ALLOW");
    expect(evaluateWriteVerdict("cd /repo/.otter/worktrees/wt && source <(sed -n '4,32p' scripts/otter-buddy.sh)", ROOT).verdict).toBe("ALLOW");
  });

  it("对照：echo 绝对路径字面量（非 argv0）不受直执通道影响", () => {
    const v = evaluateWriteVerdict("echo /repo/data/x", ROOT);
    expect(v.verdict).toBe("ALLOW");
    expect(v.mode).toBe("positive");
  });
});

// ────────── delta5 修法（严重 2：动态直执行位词文本收口，检视獭1360 delta5 复核） ──────────
describe("delta5 修法（严重 2：动态直执行位词文本收口——与 bash $P 同款）", () => {
  it("动态直执四形态（$P / P=…; $P / ./$P / $DIR/x.sh）→ script-path-dynamic fail-closed", () => {
    for (const cmd of ["$P", "P=/tmp/evil/x.sh; $P", "./$P", "DIR=/tmp/evil; $DIR/x.sh"]) {
      expect(evaluateWriteVerdict(cmd, ROOT)).toMatchObject({
        verdict: "BLOCK", mode: "fail-closed", reason: "script-path-dynamic",
      });
    }
  });

  it("对照：bash $P 解释器动态形态同判（同族一视同仁，牙1 注释与行为一致）", () => {
    expect(evaluateWriteVerdict("bash $P", ROOT)).toMatchObject({
      verdict: "BLOCK", mode: "fail-closed", reason: "script-path-dynamic",
    });
  });

  it("静态直执三态不回归（真存在 → unreadable fail-closed，/dev/null 稳定替身）", () => {
    expect(evaluateWriteVerdict("/dev/null", ROOT)).toMatchObject({ verdict: "BLOCK", reason: "script-payload-unreadable" });
  });

  it("运行器族 carve：/usr/bin/python3 与 python3 同族同判（argv0 自身不当脚本）", () => {
    expect(evaluateWriteVerdict(`/usr/bin/python3 -c "print(1)"`, ROOT).verdict).toBe("ALLOW");
    expect(evaluateWriteVerdict(`python3 -c "print(1)"`, ROOT).verdict).toBe("ALLOW");
  });

  it("能力 8 误收防线零回归：cmdsub/backtick/procsub 内 ./x、/abs/x 字面量不误收", () => {
    expect(evaluateWriteVerdict(`echo $(node -e "console.log('./x')")`, ROOT).verdict).toBe("ALLOW");
    expect(evaluateWriteVerdict("echo `cat /abs/x`", ROOT).verdict).toBe("ALLOW");
    expect(evaluateWriteVerdict(`cat <(node -e "console.log('./x')")`, ROOT).verdict).toBe("ALLOW");
    expect(evaluateWriteVerdict(`node -e "import('/repo/data/x')"`, ROOT).verdict).toBe("ALLOW");
  });

  it("残余面（记档钉死）：非前缀动态命令位（foo$BAR）不收进直执通道", () => {
    // 取舍见特性文档 delta5 节：纯展开词保守收 vs 词文本非空非路径前缀不收——改口径须同步记档
    const v = evaluateWriteVerdict("foo$BAR > /tmp/out", ROOT);
    expect(v.reason).not.toBe("script-path-dynamic");
    expect(v.verdict).toBe("ALLOW");
  });

  it("非运行器族绝对/./ 直执词文本口径不回归：真不存在 → absent 放行", () => {
    expect(evaluateWriteVerdict("/tmp/no-such-delta5-1360.sh", ROOT)).toMatchObject({ verdict: "ALLOW" });
  });
});
