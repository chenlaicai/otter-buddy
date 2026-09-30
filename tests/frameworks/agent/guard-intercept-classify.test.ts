/**
 * F20260930gslog：守卫拦截分类器回归——锁定守卫全量拦截文案指纹。
 *
 * 分类锚与守卫文案演进有意耦合：守卫改首句文案 → 本测试红 → 指纹表同步更新同走 PR。
 * 文案样本取自 bash-safety-guard.ts / sleep-command-guard.ts 的 return 字面量（2026-09-30 HEAD）。
 */
import { describe, expect, it } from "vitest";
import { classifyGuardInterceptReason, SLEEP_RULE, UNKNOWN_RULE } from "@frameworks/agent/guard-intercept-classify";

describe("classifyGuardInterceptReason", () => {
  it("防自杀族：字面量主 PID", () => {
    const reason = "bash 命令包含针对主进程 PID 的终止命令。主进程是海獭运行环境，任何情况下不得终止——你不存在需要重启或停止主进程的合法场景。";
    expect(classifyGuardInterceptReason(reason)).toEqual({ ruleId: "self_kill_literal", layer: "self_kill" });
  });

  it("防自杀族：PID 文件引用", () => {
    const reason = "bash 命令中终止进程的命令引用了主进程 PID 文件。主进程是海獭运行环境，任何情况下不得终止。";
    expect(classifyGuardInterceptReason(reason)).toEqual({ ruleId: "self_kill_pidfile", layer: "self_kill" });
  });

  it("防自杀族：pkill/killall 按名匹配", () => {
    const reason = "bash 命令包含按名匹配的批量终止命令（pkill/killall），可能影响主进程。该命令不允许。";
    expect(classifyGuardInterceptReason(reason)).toEqual({ ruleId: "self_kill_byname", layer: "self_kill" });
  });

  it("防自杀族：非字面量目标", () => {
    const reason = "bash 命令中终止进程的目标为变量或命令替换（非字面量 PID），无法判断是否针对主进程。该命令不允许。";
    expect(classifyGuardInterceptReason(reason)).toEqual({ ruleId: "self_kill_nonliteral", layer: "self_kill" });
  });

  it("防自杀族：管道到 shell", () => {
    const reason = "bash 命令通过管道传入 shell 执行且包含终止进程操作，可能针对主进程。该命令不允许。";
    expect(classifyGuardInterceptReason(reason)).toEqual({ ruleId: "self_kill_pipe_shell", layer: "self_kill" });
  });

  it("防自杀族：脚本语言执行 kill", () => {
    const reason = "bash 命令通过脚本语言执行了终止进程操作，无法判断目标。该命令不允许。";
    expect(classifyGuardInterceptReason(reason)).toEqual({ ruleId: "self_kill_script", layer: "self_kill" });
  });

  it("防自杀族：eval 包装", () => {
    const reason = "bash 命令使用 eval 包装了含数字参数的操作，可能隐藏终止进程的命令。该命令不允许。";
    expect(classifyGuardInterceptReason(reason)).toEqual({ ruleId: "self_kill_eval", layer: "self_kill" });
  });

  it("防自杀族：脚本 stop/restart 解析到主仓", () => {
    const reason = "bash 命令调用的 otter-buddy.sh 解析到主仓，其 stop/restart 会终止主进程。该命令不允许。";
    expect(classifyGuardInterceptReason(reason)).toEqual({ ruleId: "self_kill_script_stop", layer: "self_kill" });
  });

  it("防自杀族：脚本间接调用特征", () => {
    const reason = "bash 命令包含 otter-buddy.sh 引用与间接调用特征（变量/命令替换），无法静态确认是否终止主进程。该命令不允许。";
    expect(classifyGuardInterceptReason(reason)).toEqual({ ruleId: "self_kill_indirect", layer: "self_kill" });
  });

  it("R1 闸门：主仓写", () => {
    const reason = "当前 bash 工作目录在主仓（未 cd 到 worktree）。落点为主仓的写命令被拦截——若目标在 worktree，请先 cd <worktree 路径> 再执行；若确实要写主仓，用绝对路径（写主仓受 R1 红线约束，请确认意图）。";
    expect(classifyGuardInterceptReason(reason)).toEqual({ ruleId: "main_write", layer: "r1_gate" });
  });

  it("R1 闸门：data 破坏", () => {
    const reason = "bash 命令对主仓 data/ 执行了删除/移动操作。data/ 是主服务运行时数据，海獭不得直接改删。";
    expect(classifyGuardInterceptReason(reason)).toEqual({ ruleId: "data_destructive", layer: "r1_gate" });
  });

  it("权限边界：gh pr merge", () => {
    const reason = "bash 命令包含 gh pr merge——PR 合入是搭档专属动作（PR 后硬规则：LLM 执行 PR 创建和呈终审，合入按钮属于搭档）。请改用 merge_pr 工具。";
    expect(classifyGuardInterceptReason(reason)).toEqual({ ruleId: "pr_merge", layer: "permission" });
  });

  it("习惯层：sleep 前缀最优先（文案含 kill 字样也不误分类）", () => {
    const reason = "__bash_sleep_block__:裸 sleep 30 会造成长时间静默黑盒（kill 之类的字样出现在文案里也不该影响分类）。";
    expect(classifyGuardInterceptReason(reason)).toEqual(SLEEP_RULE);
  });

  it("诊断块追加不影响分类（首句指纹）", () => {
    const reason = "当前 bash 工作目录在主仓（未 cd 到 worktree）。落点为主仓的写命令被拦截。\n【命中详情】进程名模式：…s/orca/ai/otter-buddy/.otter/wo… @18（共 2 处）";
    expect(classifyGuardInterceptReason(reason)).toEqual({ ruleId: "main_write", layer: "r1_gate" });
  });

  it("未映射文案落 unknown 兜底", () => {
    expect(classifyGuardInterceptReason("这是一条全新的守卫文案，指纹表还没收录。")).toEqual(UNKNOWN_RULE);
  });

  it("空文案落 unknown 兜底（永不 null）", () => {
    expect(classifyGuardInterceptReason("")).toEqual(UNKNOWN_RULE);
  });

  it("V1 兜底链 PID 缺失文案（checkWhenMainPidMissing 复用同族文案）也分类进 self_kill", () => {
    // PID 缺失路径复用 kill 族文案（bash-safety-guard.ts:730/734 withDiagnostics 包裹），
    // 分类按文案指纹走——落到对应 kill 族 ruleId，符合「按文案分类」语义。
    const reason = "bash 命令包含按名匹配的批量终止命令（pkill/killall），可能影响主进程。该命令不允许。";
    expect(classifyGuardInterceptReason(reason).layer).toBe("self_kill");
  });
});
