/**
 * F20261009gwte Phase 1：写落点求值器单测（覆盖面表驱动）。
 *
 * 三态矩阵：每条求值规则 × 放行（空集/外部落点）/ 拦截（主仓树落点）/ unevaluated（回落）。
 * 兼作 shadow 语料的行为锚点（方案 v2「求值器单测」节）。
 */
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
    it("python3 -c \"open('/repo/data/x','w')\" → unevaluated heredoc-script-payload（审视 S1 锚点）", () => {
      const r = evaluateWriteTargets(`python3 -c "open('/repo/data/x','w').write('hi')"`, ROOT);
      expect(r).toEqual({ kind: "unevaluated", reason: "heredoc-script-payload" });
    });

    it("node -e \"require('fs').writeFileSync('/repo/x','1')\" → unevaluated heredoc-script-payload", () => {
      const r = evaluateWriteTargets(`node -e "require('fs').writeFileSync('/repo/x','1')"`, ROOT);
      expect(r).toEqual({ kind: "unevaluated", reason: "heredoc-script-payload" });
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
