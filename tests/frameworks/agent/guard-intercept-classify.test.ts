/**
 * F20260930gslog：守卫拦截分类器回归——锁定守卫全量拦截文案指纹。
 *
 * 审视轮 2 教训：手抄文案样本与守卫真实文案漂移 → 测试虚绿（测试样本≠生产文案）。
 * 本文件样本改为「运行时从守卫真实判定函数提取」——用真实命令触发守卫判定，
 * 拿守卫返回的真实 reason 喂分类器，断言 ruleId。守卫文案怎么改，测试跟着真文案走。
 *
 * 提取方式：直接调 checkBashCommandSafety / checkBashCommandSafetyV2OnModel（守卫真实
 * 判定入口），每条 ruleId 至少一个「能触发该规则的真实命令」。杀主进程类命令在测试
 * 里不会真执行——只走静态判定。
 */
import { describe, expect, it } from "vitest";
import { classifyGuardInterceptReason, UNKNOWN_RULE } from "@frameworks/agent/guard-intercept-classify";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";

/** 用真实命令触发守卫，返回守卫真实文案（null = 未拦，测试自身失败——探针失效即红，不会静默漏检） */
function guardReason(command: string, mainPid = 12345, projectRoot = "/repo"): string {
  const reason = checkBashCommandSafety(command, mainPid, undefined, { projectRoot });
  if (reason === null) throw new Error(`守卫未拦截该探针命令（探针失效，需换更精确探针）: ${command}`);
  return reason;
}

/** 用真实文案断言分类 */
function expectClass(command: string, ruleId: string) {
  expect(classifyGuardInterceptReason(guardReason(command))).toMatchObject({ ruleId });
}

describe("classifyGuardInterceptReason · 真实文案回归（探针 = 守卫真实判定）", () => {
  it("self_kill_literal：kill 主 PID", () => {
    expectClass("kill 12345", "self_kill_literal");
  });

  it("self_kill_pidfile：kill 读 PID 文件（跨段语义）", () => {
    expectClass("cat .otter-buddy.pid | xargs kill", "self_kill_pidfile");
  });

  it("self_kill_byname：pkill 按名匹配", () => {
    expectClass("pkill otter-buddy", "self_kill_byname");
  });

  it("self_kill_nonliteral：kill 变量目标", () => {
    expectClass("kill $MAINPID", "self_kill_nonliteral");
  });

  it("self_kill_process_group：kill 0", () => {
    expectClass("kill 0", "self_kill_process_group");
  });

  it("self_kill_pipe_shell：echo kill | sh", () => {
    expectClass("echo 'kill 12345' | sh", "self_kill_pipe_shell");
  });

  it("self_kill_script：python 执行 kill", () => {
    expectClass("python3 -c \"import os; os.kill(12345, 9)\"", "self_kill_script");
  });

  it("self_kill_eval：eval 拼接 kill", () => {
    expectClass("eval \"ki\"\"ll 12345\"", "self_kill_eval");
  });

  it("self_kill_script_stop：otter-buddy.sh stop（直接调用形态，不带 bash 前缀）", () => {
    expectClass("/repo/scripts/otter-buddy.sh stop", "self_kill_script_stop");
  });

  it("self_kill_indirect：otter-buddy.sh 变量形态（直接调用，不带 bash 前缀）", () => {
    expectClass("/repo/scripts/otter-buddy.sh ${MODE}", "self_kill_indirect");
  });

  it("script_file_exec：bash 脚本文件执行（V2 U5 防绕过层）", () => {
    expectClass("bash /repo/scripts/setup.sh", "script_file_exec");
  });

  it("main_write：主仓写（git 写族，未 cd）", () => {
    expectClass("git commit -m test", "main_write");
  });

  it("main_write：重定向写主仓（未 cd）", () => {
    expectClass("echo 'git commit -m x' > notes.md", "main_write");
  });

  it("data_destructive：rm 主仓 data/（文案带括注形态）", () => {
    expectClass("rm -rf /repo/data/logs", "data_destructive");
  });

  it("pr_merge：gh pr merge", () => {
    expectClass("gh pr merge 1234", "pr_merge");
  });

  it("sleep_block：sleep 干净文案（发射点已剥前缀形态）", () => {
    // sleep 拦截走独立判定入口（checkSleepGuard），其 reason 前缀在发射点被剥。
    // 此处直接用其干净文案特征构造（含特征片段的合法形态），锁定指纹有效性。
    const cleanSleepReason = "检测到你使用了 sleep 等待（约 30 秒）。裸 sleep 会让搭档看到长时间静默黑盒。请先 speak 说明你要等什么、为什么要等这么久，然后改用 wait 工具（wait 的 seconds/reason/until 参数支持等待+理由自证+可选的苏醒检查命令）。";
    expect(classifyGuardInterceptReason(cleanSleepReason)).toMatchObject({ ruleId: "sleep_block", layer: "habit" });
  });

  it("诊断块追加不影响分类（首句指纹）", () => {
    const reason = "当前 bash 工作目录在主仓（未 cd 到 worktree）。落点为主仓的写命令被拦截。\n【命中详情】进程名模式：…（共 2 处）\n【自有项目 dev server】检测到端口白名单。";
    expect(classifyGuardInterceptReason(reason)).toMatchObject({ ruleId: "main_write" });
  });

  it("V1/V2 分词差异容忍：pidfile 文案的两种形态都归 self_kill_pidfile", () => {
    const v1Style = "bash 命令中终止进程的命令引用了主进程 PID 文件。该命令不允许。";
    const v2Style = "bash 命令中包含主进程 PID 文件引用和终止进程操作，可能针对主进程。该命令不允许。";
    expect(classifyGuardInterceptReason(v1Style)).toMatchObject({ ruleId: "self_kill_pidfile" });
    expect(classifyGuardInterceptReason(v2Style)).toMatchObject({ ruleId: "self_kill_pidfile" });
  });

  it("未映射文案落 unknown 兜底（守卫新增文案未同步指纹表时聚合可见）", () => {
    expect(classifyGuardInterceptReason("这是一条全新的守卫文案，指纹表还没收录。")).toEqual(UNKNOWN_RULE);
  });

  it("空文案落 unknown 兜底（永不 null）", () => {
    expect(classifyGuardInterceptReason("")).toEqual(UNKNOWN_RULE);
  });
});

describe("buildGuardInterceptContext · 落账字段组装（B3 处置：hook 链路单测）", () => {
  it("基础字段：ruleId/ruleLayer/commandHead/hasWorktreePath 齐全", async () => {
    const { buildGuardInterceptContext } = await import("@frameworks/agent/pi-session-factory");
    const ctx = buildGuardInterceptContext("git commit -m x", "当前 bash 工作目录在主仓（未 cd 到 worktree）。落点为主仓的写命令被拦截", false, 0);
    expect(ctx).toMatchObject({ layer: "framework", ruleId: "main_write", ruleLayer: "r1_gate", hasWorktreePath: false });
    expect(ctx.commandHead).toBe("git commit -m x");
  });

  it("hasWorktreePath：命令含 worktree 路径时为 true（#1207 误报特征）", async () => {
    const { buildGuardInterceptContext } = await import("@frameworks/agent/pi-session-factory");
    const ctx = buildGuardInterceptContext("cd /Users/orca/ai/otter-buddy/.otter/worktrees/foo && git add x", "当前 bash 工作目录在主仓（未 cd 到 worktree）。", false, 0);
    expect(ctx).toMatchObject({ ruleId: "main_write", hasWorktreePath: true });
  });

  it("commandHead：截短 120 字符（对齐 description 前缀口径），脱敏作用于敏感词元", async () => {
    const { buildGuardInterceptContext } = await import("@frameworks/agent/pi-session-factory");
    // sanitizeQuotedText 语义：替换敏感词元（如 kill 族）而非剥引号内容（#858 口径）
    const longCmd = "echo 'payload' " + "x".repeat(200);
    const ctx = buildGuardInterceptContext(longCmd, "当前 bash 工作目录在主仓（未 cd 到 worktree）。", false, 0);
    expect((ctx.commandHead as string).length).toBeLessThanOrEqual(120);
    // 敏感词元脱敏验证：kill 探针词元被替换后不再以原样出现
    const killCtx = buildGuardInterceptContext("echo 'pkill something' rest", "bash 命令使用 eval 包装了含数字参数的操作。", false, 0);
    expect(String(killCtx.commandHead)).not.toContain("pkill");
  });

  it("repeated 时带 repeatedIntercept 计数", async () => {
    const { buildGuardInterceptContext } = await import("@frameworks/agent/pi-session-factory");
    const ctx = buildGuardInterceptContext("pkill otter-buddy", "bash 命令包含按名匹配的批量终止命令（pkill/killall）。", true, 2);
    expect(ctx.repeatedIntercept).toBe(3);
    expect(ctx).toMatchObject({ ruleId: "self_kill_byname" });
  });
});
