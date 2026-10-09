/**
 * F20261009gwte Phase 1：写落点求值器单测（覆盖面表驱动）。
 *
 * 三态矩阵：每条求值规则 × 放行（空集/外部落点）/ 拦截（主仓树落点）/ unevaluated（回落）。
 * 兼作 shadow 语料的行为锚点（方案 v2「求值器单测」节）。
 */
/* eslint-disable max-lines-per-function -- 三态矩阵表驱动（每族放行/拦截/回落各一 + Phase 2 负门），拆函数会割裂「一族一表」可读性 */
import { describe, it, expect } from "vitest";
import { evaluateWriteTargets, pathWithinMain } from "@frameworks/agent/write-target-evaluator";

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

    it("未闭合引号（parse-failed）→ unevaluated parse-failed", () => {
      const r = evaluateWriteTargets(`echo "unclosed`, ROOT);
      expect(r).toEqual({ kind: "unevaluated", reason: "parse-failed" });
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

    it("拦截侧负门：node -e import(主仓路径)（只读词面但主仓字面量）→ 回落（c062 口径，字面量防线不破）", () => {
      const r = evaluateWriteTargets(`node -e "import('${ROOT}/dist-probe/x.js')"`, ROOT);
      expect(r.kind).toBe("unevaluated");
    });

    it("拦截侧负门：argv 动态路径（process.argv[1]）→ 回落（不做值传播之外的猜）", () => {
      const r = evaluateWriteTargets(`node -e "fs.writeFileSync(process.argv[1], 'x')" ${ROOT}/data/x`, ROOT);
      expect(r.kind).toBe("unevaluated");
    });

    it("拦截侧负门：字符串拼接路径（'/repo/da'+'ta/x'）→ 回落（不做常量折叠之外的跨语句传播）", () => {
      const r = evaluateWriteTargets(`node -e "const p='/repo/da' + 'ta/x'; fs.writeFileSync(p, 'x')"`, ROOT);
      expect(r.kind).toBe("unevaluated");
    });

    it("放行侧：python3 -c 只读 open('/tmp/x') → evaluated 外部落点", () => {
      const r = evaluateWriteTargets(`python3 -c "print(open('/tmp/a.txt').read())"`, ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(false);
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

    it("data/workspaces 豁免：写 /repo/data/workspaces/... → evaluated 落点在主仓树（调用方豁免政策不在求值器内——落点如实报）", () => {
      const r = evaluateWriteTargets("touch /repo/data/workspaces/conv1/f", ROOT);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") {
        // 求值器如实报落点（在主仓树内）；豁免判定属调用方（政策与事实分层）
        expect(r.targets.some(t => pathWithinMain(t.path, ROOT))).toBe(true);
      }
    });
  });
});
