import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { evaluateGitExecution } from "../../../src/frameworks/agent/git-execution-policy";
import { evaluateWriteVerdict } from "../../../src/frameworks/agent/write-verdict";
import { isUntrackedProbeDebris, debrisRmAllowPath } from "../../../src/frameworks/agent/write-target-evaluator";
import { checkBashCommandSafety } from "../../../src/frameworks/agent/bash-safety-guard";
import { createSandboxSpawnHook } from "../../../src/frameworks/agent/bash-sandbox";

/**
 * F20261029clnup 窄受控清理面：
 * A. branch -D 仅内容已进 main（含 squash 等价）时授权（窄受控强删面）——前置校验可注入，
 *    授权接线/形态收口本地可测；真实 git 判定（净 patch-id 算法）另有会话实证与 CI 集成用例。
 * B. 主仓根未跟踪探针残渣文件的 rm 自清面（文本层 + v2 判据层 + profile 层同口径）——fixture 就地取
 *    当前 repo 工作树（git ls-files 只读判定，沙箱内可跑；git init 类 fixture 落 CI）。
 */
const FIXTURE_ROOT = join(process.cwd(), "node_modules", `.tmp-narrow-cleanup-${process.pid}`);

describe("F20261029clnup A：branch -D 窄受控强删面", () => {
  const repo = join(FIXTURE_ROOT, "repo-a");
  const allow = { repoRoot: repo, branchContentMerged: () => true };
  const deny = { repoRoot: repo, branchContentMerged: () => false };

  beforeAll(() => {
    rmSync(FIXTURE_ROOT, { recursive: true, force: true });
    mkdirSync(repo, { recursive: true }); // 真实目录（realpath 需要）；非 git 仓——默认前置走 git 异常 fail-closed
  });

  afterAll(() => { rmSync(FIXTURE_ROOT, { recursive: true, force: true }); });

  it("内容已进 main（注入前置 true）：-D 授权，kind 与写域正确", () => {
    const g = evaluateGitExecution("git branch -D feat-squash", repo, allow);
    expect(g?.kind).toBe("branch-delete");
    expect(g?.domains).toEqual(["refs-heads", "logs-refs", "packed-refs-lock"]);
  });

  it("前置 false：-D 不授权（fail-closed）", () => {
    expect(evaluateGitExecution("git branch -D feat-unmerged", repo, deny)).toBeNull();
  });

  it("缺省前置（非 git 目录 → git 异常）：不授权（fail-closed 错误分支）", () => {
    expect(evaluateGitExecution("git branch -D feat-squash", repo, { repoRoot: repo })).toBeNull();
  });

  it("main / HEAD 永不授权（前置 true 也不放）", () => {
    expect(evaluateGitExecution("git branch -D main", repo, allow)).toBeNull();
    expect(evaluateGitExecution("git branch -D HEAD", repo, allow)).toBeNull();
  });

  it("多目标 / 多余旗标 / 缺目标的 -D 形态不授权", () => {
    expect(evaluateGitExecution("git branch -D feat-squash feat-ff", repo, allow)).toBeNull();
    expect(evaluateGitExecution("git branch -D -f feat-squash", repo, allow)).toBeNull();
    expect(evaluateGitExecution("git branch -D", repo, allow)).toBeNull();
    expect(evaluateGitExecution("git branch -D -D", repo, allow)).toBeNull();
    expect(evaluateGitExecution("git branch --delete feat-squash", repo, allow)).toBeNull();
  });

  it("白名单外字符 / 旗标位的分支名不授权（S1 同口径）", () => {
    expect(evaluateGitExecution("git branch -D fe`at", repo, allow)).toBeNull();
    expect(evaluateGitExecution("git branch -D -x feat-squash", repo, allow)).toBeNull();
  });

  it("-d 原语义不变（无前置校验，git 自身校验兜底）", () => {
    const g = evaluateGitExecution("git branch -d scratch", repo, allow);
    expect(g?.kind).toBe("branch-delete");
    expect(g?.domains).toEqual(["refs-heads", "logs-refs", "packed-refs-lock"]);
  });
});

describe("F20261029clnup B：主仓根探针残渣 rm 自清面（fixture=当前工作树）", () => {
  const root = process.cwd();
  const debris = join(root, "f3-probe-clnup-test.txt");
  const debris2 = join(root, "f3-probe-clnup-test2.txt");
  const trackedLike = join(root, "notes-clnup-test.txt");
  const subDebris = join(root, "sub-clnup-test", "probe-x.txt");
  const dirDebris = join(root, "probe-dir-clnup-test");
  const linkDebris = join(root, "probe-link-clnup-test.txt");

  beforeAll(() => {
    writeFileSync(debris, "debris\n"); // 未跟踪探针残渣（豁免对象）
    writeFileSync(debris2, "debris2\n"); // 第二件残渣（多目标/链式用例）
    writeFileSync(trackedLike, "notes\n"); // 未跟踪但模式不匹配
    mkdirSync(join(root, "sub-clnup-test"), { recursive: true });
    writeFileSync(subDebris, "sub debris\n"); // 子目录残渣
    mkdirSync(dirDebris, { recursive: true }); // 目录不豁免
    symlinkSync(join(root, "package.json"), linkDebris); // 符号链接不豁免
  });

  afterAll(() => {
    for (const p of [debris, debris2, trackedLike, linkDebris, join(root, "sub-clnup-test", "probe-x.txt")]) rmSync(p, { force: true });
    rmSync(join(root, "sub-clnup-test"), { recursive: true, force: true });
    rmSync(dirDebris, { recursive: true, force: true });
  });

  it("谓词：主仓根未跟踪残渣文件 → true；其余形态 → false（fail-closed）", () => {
    expect(isUntrackedProbeDebris(debris, root)).toBe(true);
    expect(isUntrackedProbeDebris(trackedLike, root)).toBe(false); // 模式不匹配
    expect(isUntrackedProbeDebris(subDebris, root)).toBe(false); // 子目录
    expect(isUntrackedProbeDebris(dirDebris, root)).toBe(false); // 目录
    expect(isUntrackedProbeDebris(linkDebris, root)).toBe(false); // 符号链接
    expect(isUntrackedProbeDebris(join(root, "nonexistent-probe-clnup.tmp"), root)).toBe(false); // 不存在
  });

  it("v2 判据：rm 残渣文件 → ALLOW；rm 模式不匹配 → BLOCK；重定向写残渣 → BLOCK", () => {
    expect(evaluateWriteVerdict("rm f3-probe-clnup-test.txt", root, root).verdict).toBe("ALLOW");
    expect(evaluateWriteVerdict("rm notes-clnup-test.txt", root, root).verdict).toBe("BLOCK");
    expect(evaluateWriteVerdict("echo x > f3-probe-clnup-test.txt", root, root).verdict).toBe("BLOCK");
  });

  it("文本层：单目标 rm 残渣 → 放行；模式不匹配 / 多目标 rm → 拦截", () => {
    expect(checkBashCommandSafety(`rm ${debris}`, null, undefined, { projectRoot: root })).toBeNull();
    // 拦截文案随规则链首命中可能不同（主仓内容区/主仓工作目录族），断言收敛到「非空=拦截」
    expect(checkBashCommandSafety(`rm ${trackedLike}`, null, undefined, { projectRoot: root })).not.toBeNull();
    expect(checkBashCommandSafety(`rm ${debris} ${trackedLike}`, null, undefined, { projectRoot: root })).not.toBeNull();
  });

  it("文本层：mv 残渣文件不享豁免（动词窄化只收 rm）", () => {
    expect(checkBashCommandSafety(`mv ${debris} /tmp/x`, null, undefined, { projectRoot: root })).not.toBeNull();
  });

  it("三层同源（检视一轮严重 4）：多目标 rm 两残渣——文本层/v2 判据/沙箱 profile 全拒绝", () => {
    expect(isUntrackedProbeDebris(debris, root)).toBe(true); // 前置：两件都是真残渣
    expect(isUntrackedProbeDebris(debris2, root)).toBe(true);
    expect(evaluateWriteVerdict(`rm ${debris} ${debris2}`, root, root).verdict).toBe("BLOCK");
    expect(checkBashCommandSafety(`rm ${debris} ${debris2}`, null, undefined, { projectRoot: root })).not.toBeNull();
    const hook = createSandboxSpawnHook(root, join(root, "data"));
    expect(hook({ command: `rm ${debris} ${debris2}`, cwd: root, env: {} }).command).not.toContain("(allow file-write* (literal");
  });

  it("三层同源：链式 rm 残渣（rm A && rm B）——形态锚定整命令，全拒绝", () => {
    // 检视一轮附带发现：此前文本层逐段判形态，链式各段独立豁免（与 profile 层分叉）
    expect(evaluateWriteVerdict(`rm ${debris} && rm ${debris2}`, root, root).verdict).toBe("BLOCK");
    expect(checkBashCommandSafety(`rm ${debris} && rm ${debris2}`, null, undefined, { projectRoot: root })).not.toBeNull();
    const hook = createSandboxSpawnHook(root, join(root, "data"));
    expect(hook({ command: `rm ${debris} && rm ${debris2}`, cwd: root, env: {} }).command).not.toContain("(allow file-write* (literal");
  });

  it("形态收口（debrisRmAllowPath）：仅单目标 rm 命中；链式/多目标/其他动词 → null", () => {
    expect(debrisRmAllowPath(`rm ${debris}`, root, root)).toBe(debris);
    expect(debrisRmAllowPath(`rm -f ${debris}`, root, root)).toBe(debris);
    expect(debrisRmAllowPath(`rm "${debris}"`, root, root)).toBe(debris);
    expect(debrisRmAllowPath(`rm ${debris} ${trackedLike}`, root, root)).toBeNull(); // 多目标
    expect(debrisRmAllowPath(`rm ${debris} && echo x`, root, root)).toBeNull(); // 链式
    expect(debrisRmAllowPath(`echo rm ${debris}`, root, root)).toBeNull(); // 非 rm 动词
    expect(debrisRmAllowPath(`rmdir ${dirDebris}`, root, root)).toBeNull(); // rmdir 不收
    expect(debrisRmAllowPath(`mv ${debris} /tmp/x`, root, root)).toBeNull(); // mv 不收
  });

  it("沙箱 profile 层（spawnHook）：rm 残渣 → 追加精确字面量写域；rm 非残渣 → 不加", () => {
    const hook = createSandboxSpawnHook(root, join(root, "data"));
    const wrapped = hook({ command: `rm ${debris}`, cwd: root, env: {} });
    // profile 经 escapeForOuterBash 入命令串（引号转义为 \"），断言对引号形态不敏感
    expect(wrapped.command).toContain("(allow file-write* (literal");
    expect(wrapped.command).toContain(debris);
    const noAllow = hook({ command: `rm ${trackedLike}`, cwd: root, env: {} });
    expect(noAllow.command).not.toContain("(allow file-write* (literal");
  });
});
