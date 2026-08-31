import { describe, it, expect } from "vitest";
import { buildYieldRetryMsg, buildAutoRetryMsg, isRetryableGuardAbort, buildGuardAbortBody } from "@usecases/conversation/agent-turn-orchestrator/retry-policy";

describe("buildYieldRetryMsg", () => {
  it("hasOrphanText=true 时返回旁白流失专项文案", () => {
    const msg = buildYieldRetryMsg(3, true);
    expect(msg).toContain("只有你自己能看到的草稿");
    expect(msg).toContain("speak(body)");
    expect(msg).toContain("yield 交棒");
  });

  it("hasOrphanText=false + toolCallCount=0 时返回思考型文案", () => {
    const msg = buildYieldRetryMsg(0, false);
    expect(msg).toContain("没有调用任何工具");
    expect(msg).toContain("speak");
    expect(msg).not.toContain("草稿");
  });

  it("hasOrphanText=false + toolCallCount>0 时返回遗漏 yield 文案", () => {
    const msg = buildYieldRetryMsg(5, false);
    expect(msg).toContain("yield");
    expect(msg).not.toContain("草稿");
    expect(msg).not.toContain("speak");
  });

  it("hasOrphanText 优先于 toolCallCount 判定", () => {
    // 即使 toolCallCount>0，有旁白流失时也应走专项文案
    const msg = buildYieldRetryMsg(5, true);
    expect(msg).toContain("草稿");
  });

  it("未传 hasOrphanText 时走原有逻辑（兼容旧调用）", () => {
    const msg = buildYieldRetryMsg(0);
    expect(msg).toContain("没有调用任何工具");
    expect(msg).not.toContain("草稿");
  });
});

describe("isRetryableGuardAbort", () => {
  it("bash_safety:* 前缀返回可重试（R2-1 delta 复核裁决）", () => {
    expect(isRetryableGuardAbort('bash_safety:kill main process PID detected')).toBe(true);
  });

  it("degenerate_output 返回不可重试", () => {
    expect(isRetryableGuardAbort('degenerate_output')).toBe(false);
  });

  it("streaming_timeout 返回可重试", () => {
    expect(isRetryableGuardAbort('streaming_timeout')).toBe(true);
  });

  it("未知 reason 返回不可重试", () => {
    expect(isRetryableGuardAbort('unknown_reason')).toBe(false);
  });
});

describe("buildGuardAbortBody", () => {
  it("bash_safety:* 返回不允许命令中断文案（无 restart 出口）", () => {
    const msg = buildGuardAbortBody('bash_safety:kill main process');
    expect(msg).toContain('不允许命令');
    expect(msg).toContain('worktree');
    // F20260831aksp 终审口径：不提供任何 restart 出口（含转手版）
    expect(msg).not.toContain('otter-buddy.sh restart');
    expect(msg).not.toContain('大獭');
  });
});

describe("buildAutoRetryMsg", () => {
  it("streaming_timeout 返回超时重试提醒", () => {
    const msg = buildAutoRetryMsg('streaming_timeout');
    expect(msg).toContain("超时");
    expect(msg).toContain("继续");
    expect(msg).not.toContain("yield");
  });

  it("first_byte_timeout 返回响应超时提醒", () => {
    const msg = buildAutoRetryMsg('first_byte_timeout');
    expect(msg).toContain("响应超时");
    expect(msg).toContain("重新生成");
  });

  it("circuit_break:* 返回工具异常提醒", () => {
    const msg = buildAutoRetryMsg('circuit_break:event_timeout');
    expect(msg).toContain("工具调用异常");
    expect(msg).toContain("检查");
  });

  // F20260831aksp T2：事故 C 回归——bash_safety 拦截后重试提示必须携带拦截原因与替代路径
  it("bash_safety:* 透传拦截原因（不再落到通用兜底文案）", () => {
    const msg = buildAutoRetryMsg('bash_safety:bash 命令包含针对主进程 PID 的终止命令');
    expect(msg).toContain("安全守卫拦截");
    expect(msg).toContain("bash 命令包含针对主进程 PID 的终止命令");
    // 四要素：不允许声明 / 无合法场景说明 / worktree 正道 / 重新分析引导
    expect(msg).toContain("该命令不允许");
    expect(msg).toContain("不存在需要重启或停止主进程的合法场景");
    expect(msg).toContain("worktree");
    expect(msg).toContain("重新分析当前任务");
    // 无 restart 出口（终审口径）
    expect(msg).not.toContain("otter-buddy.sh restart");
  });

  it("未知 reason 返回通用异常提醒", () => {
    const msg = buildAutoRetryMsg('unknown_reason');
    expect(msg).toContain("异常");
    expect(msg).toContain("继续");
    // 通用文案不应泄漏 bash_safety 专项内容
    expect(msg).not.toContain("安全守卫拦截");
  });
});
