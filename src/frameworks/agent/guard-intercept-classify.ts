/**
 * F20260930gslog：bash 守卫拦截事件结构化分类器（外挂，不碰守卫本体）。
 *
 * 背景：guard_intercept 落账 description 自由文本拼接、context 仅 {layer}——
 * #1207（cd worktree 误判主仓写）的关闭验证只能人工翻台账数数，「哪条规则误报最多」
 * 问不出来。本模块从拦截 reason 文案分类出 ruleId，落进 healing_events.context，
 * 让误报治理从「獭吐槽驱动」升级为「数据驱动」。
 *
 * 设计：reason 首句指纹锚定——守卫每条拦截文案首句唯一（grep 实测 2026-09-30），
 * 文案其余部分是面向被拦獭的教学引导（含正道），会随 UX 演化，但首句语义稳定。
 * 守卫文案若改动首句，指纹表同步更新（分类回归测试锁定全部指纹——改文案不过测试
 * 就会红，这是有意耦合：分类锚与文案演进同走 PR 审视）。
 *
 * 指纹表带「宪法分层」字段（第②步守卫宪法文档的预备层——防自杀/R1 闸门/权限边界/
 * 格式习惯），ruleId 聚合时可按层归并。
 */

/** 宪法分层（守卫规则的隐含分层显性化，第②步宪法文档消费） */
export type GuardRuleLayer = "self_kill" | "r1_gate" | "permission" | "habit";

export interface GuardRuleClass {
  ruleId: string;
  layer: GuardRuleLayer;
}

/** 指纹表：首句片段 → 分类。顺序即优先级（SLEEP 前缀最优先，见 classifyGuardInterceptReason） */
const FINGERPRINTS: ReadonlyArray<{ fragment: string; cls: GuardRuleClass }> = [
  { fragment: "bash 命令包含针对主进程 PID 的终止命令", cls: { ruleId: "self_kill_literal", layer: "self_kill" } },
  { fragment: "终止进程的命令引用了主进程 PID 文件", cls: { ruleId: "self_kill_pidfile", layer: "self_kill" } },
  { fragment: "按名匹配的批量终止命令（pkill/killall）", cls: { ruleId: "self_kill_byname", layer: "self_kill" } },
  { fragment: "终止进程的目标为变量或命令替换", cls: { ruleId: "self_kill_nonliteral", layer: "self_kill" } },
  { fragment: "通过管道传入 shell 执行且包含终止进程操作", cls: { ruleId: "self_kill_pipe_shell", layer: "self_kill" } },
  { fragment: "通过脚本语言执行了终止进程操作", cls: { ruleId: "self_kill_script", layer: "self_kill" } },
  { fragment: "使用 eval 包装了含数字参数的操作", cls: { ruleId: "self_kill_eval", layer: "self_kill" } },
  { fragment: "otter-buddy.sh 解析到主仓，其 stop/restart", cls: { ruleId: "self_kill_script_stop", layer: "self_kill" } },
  { fragment: "otter-buddy.sh 引用与间接调用特征", cls: { ruleId: "self_kill_indirect", layer: "self_kill" } },
  { fragment: "当前 bash 工作目录在主仓（未 cd 到 worktree）", cls: { ruleId: "main_write", layer: "r1_gate" } },
  { fragment: "对主仓 data/ 执行了删除/移动操作", cls: { ruleId: "data_destructive", layer: "r1_gate" } },
  { fragment: "PR 合入是搭档专属动作", cls: { ruleId: "pr_merge", layer: "permission" } },
];

/** sleep 拦截（独立模块，前缀标记——发射点分流 bash_sleep:） */
export const SLEEP_RULE: GuardRuleClass = { ruleId: "sleep_block", layer: "habit" };
/** 未映射兜底（守卫新增文案未同步指纹表时落此——聚合报表可见 unknown 占比，倒逼补表） */
export const UNKNOWN_RULE: GuardRuleClass = { ruleId: "unknown", layer: "self_kill" };

/**
 * 从拦截 reason 分类出 ruleId。
 *
 * @param rawReason - 守卫返回的拦截文案（可能带 withDiagnostics 追加的【命中详情】块，
 *                    sleep 拦截带 SLEEP_REASON_PREFIX 前缀）
 * @returns 分类结果（永不返回 null——unknown 兜底）
 */
export function classifyGuardInterceptReason(rawReason: string): GuardRuleClass {
  const reason = rawReason.trim();
  // sleep 前缀最优先（其文案可能含 kill 字样，防误分类进 kill 族）
  if (reason.includes("__bash_sleep_block__:")) return SLEEP_RULE;
  const head = reason.split("\n")[0] ?? reason;
  for (const { fragment, cls } of FINGERPRINTS) {
    if (head.includes(fragment)) return cls;
  }
  return UNKNOWN_RULE;
}
