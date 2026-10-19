/**
 * F20261019f714（M-f7148deb 第 3 条）：worktree 内 git reset / mv "$OLD" 复合命令误拦修复。
 *
 * 案发现场：healing f3d5ebe5（2026-10-19 03:10，healing age-out 修复交付时）——
 * `cd <worktree> && git reset HEAD >/dev/null 2>&1; OLD=docs/...; NEW=docs/...; mv "$OLD" "$NEW"`
 * 被 main_write_resolve 拦。次发现报告归因为「进程名模式误拦」——实勘纠正：命中详情里的
 * 「进程名模式」只是 locateTriggerContext 诊断回显（不参与判定），真根因是
 * evaluateWriteTargets 对词表命令（mv）落点参数 $VAR 不做同命令赋值溯源 → dynamic-path
 * → fail-closed 拦截（BC-5 溯源能力 cd 有、落点参数没有）。
 *
 * 修法：resolveTargetArgWord（词表命令落点参数 + 重定向目标，纯 $VAR / var+字面拼接
 * 同命令溯源，含 .. 爬升守卫）——溯源成功照常走落点判定，落主仓仍拦（改窄不改宽）。
 *
 * 双向断言：
 * - 修复面：worktree 内赋值+mv/cp/touch/重定向目标（溯源得）→ ALLOW（修复前 fail-closed）
 * - 保护面：溯源到主仓路径仍拦；溯源不出（for 变量/环境变量/.. 拼接）仍 fail-closed；
 *   词面写入主仓树（无变量）不受影响
 */
import { describe, it, expect } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";
import { evaluateWriteTargets } from "@frameworks/agent/write-target-evaluator";

const mainPid = 42877;
const projectRoot = "/Users/orca/ai/otter-buddy";
const sessionCwd = "/Users/orca/ai/otter-buddy/data/workspaces/3241317b-99d6-4d78-9248-ff208a7461bc";
const WT = "/Users/orca/ai/otter-buddy/.otter/worktrees/fix-1545-healing-ageout";

describe("F20261019f714 词表命令落点参数 $VAR 同命令赋值溯源（M-f7148deb 第 3 条）", () => {
  describe("修复面（修复前 fail-closed 误拦 → 现 ALLOW）", () => {
    it("案发现场原命令（mv 段）：cd worktree && git reset; OLD=…; NEW=…; mv \"$OLD\" \"$NEW\" → 放行", () => {
      const cmd = `cd ${WT} && git reset HEAD >/dev/null 2>&1; OLD=docs/features/2026/10/19/a.md; NEW=docs/features/2026/10/19/b.md; mv "$OLD" "$NEW"`;
      expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot, sessionCwd })).toBeNull();
    });

    it("求值器层：mv \"$OLD\" \"$NEW\" 溯源得双落点均在 worktree（evaluated 非 unevaluated）", () => {
      const cmd = `cd ${WT} && OLD=docs/features/a.md; NEW=docs/features/b.md; mv "$OLD" "$NEW"`;
      const r = evaluateWriteTargets(cmd, projectRoot, sessionCwd);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") {
        const mv = r.targets.filter(t => t.via === "cmd-arg");
        expect(mv).toHaveLength(1); // cp/mv 落点=第二参数
        expect(mv[0].path).toBe(`${WT}/docs/features/b.md`);
      }
    });

    it("E1 现场（动态源可用性债偿还）：cd worktree && F=…; cp $F /tmp/bak.tsx → 放行", () => {
      const cmd = `cd ${WT}/invoke-periodic-audit && F=web/src/pages/conversation/index.tsx && cp $F /tmp/bak.tsx`;
      expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot, sessionCwd })).toBeNull();
    });

    it("重定向目标 $VAR（溯源得）：OUT=/tmp/x.log; echo hi > $OUT → 放行", () => {
      const cmd = `cd ${WT} && OUT=/tmp/x.log; echo hi > $OUT`;
      expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot, sessionCwd })).toBeNull();
    });

    it("var+字面拼接落点（$W/sub）：溯源后拼接、无 .. → 放行", () => {
      const cmd = `cd ${WT} && SUB=docs; touch "$SUB/new-file.md"`;
      expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot, sessionCwd })).toBeNull();
    });
  });

  describe("保护面（拦截零削弱——溯源后落主仓仍拦 / 溯源不出仍 fail-closed）", () => {
    it("溯源到主仓路径：cd /tmp && T=src; mv a.ts \"$T/b.ts\" → 拦（主仓 cwd + 落点主仓树）", () => {
      // startCwd=projectRoot（主仓）：T=src 相对路径 → 落点主仓 src/b.ts
      const cmd = `T=src; mv a.ts "$T/b.ts"`;
      const r = checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot, sessionCwd: projectRoot });
      expect(r).not.toBeNull();
    });

    it("溯源到主仓绝对路径：F=/repo/src/x.ts; cp src/a.ts $F → 拦（正面落点判，非 fail-closed）", () => {
      const cmd = `F=/repo/src/x.ts; cp src/a.ts $F`;
      const r = evaluateWriteTargets(cmd, projectRoot, projectRoot);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.targets.some(t => t.path === "/repo/src/x.ts")).toBe(true);
    });

    it("for 循环变量（非赋值）溯源不出：for pid in $(pgrep -f x); do kill $pid 2>/dev/null; done → 求值不假放行（kill 非词表命令，重定向 /dev/null 正常入账）", () => {
      const cmd = `for pid in $(pgrep -f "x"); do kill $pid 2>/dev/null; done`;
      const r = evaluateWriteTargets(cmd, projectRoot, sessionCwd);
      // 修复引入的宽 fallback 回归钉死：$pid（for 变量）不得被卷进重定向目标判定
      expect(r.kind).toBe("evaluated");
    });

    it(".. 拼接守卫（爬升红线）：$W/../.. 落点不可求值 → dynamic-path fail-closed", () => {
      const cmd = `cd /tmp && W=${projectRoot}; touch "$W/../src/pwn.ts"`;
      const r = evaluateWriteTargets(cmd, projectRoot, sessionCwd);
      expect(r).toMatchObject({ kind: "unevaluated", reason: "dynamic-path" });
    });

    it("环境变量来源（BC-5：非同命令赋值不猜）：mv a $UNSET_VAR → fail-closed", () => {
      const cmd = `mv a.ts "$UNSET_VAR"`;
      const r = evaluateWriteTargets(cmd, projectRoot, sessionCwd);
      expect(r).toMatchObject({ kind: "unevaluated", reason: "dynamic-path" });
    });

    it("touchstone 翻红回归锁：TS-2140df2d for…kill 族 /dev/null 正常入账（不因 var 词误判目标）", () => {
      const cmd = `for pid in $(pgrep -f "dist/src/main.js"); do kill $pid 2>/dev/null; done; sleep 1; pgrep -f "dist/src/main.js" | wc -l`;
      const r = evaluateWriteTargets(cmd, projectRoot, sessionCwd);
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") {
        expect(r.targets.some(t => t.path === "/dev/null" && t.via === "redirect")).toBe(true);
      }
    });
  });
});
