/**
 * F20260930gslog：bash 守卫拦截事件结构化分类器（外挂，不碰守卫本体）。
 *
 * 背景：guard_intercept 落账 description 自由文本拼接、context 仅 {layer}——
 * #1207（cd worktree 误判主仓写）的关闭验证只能人工翻台账数数，「哪条规则误报最多」
 * 问不出来。本模块从拦截 reason 文案分类出 ruleId，落进 healing_events.context，
 * 让误报治理从「獭吐槽驱动」升级为「数据驱动」。
 *
 * 设计（审视轮 2 修订）：
 * - 指纹锚定「首句中段的特征片段」——不锚全句（V1 与 V2 model 链同规则文案有细微
 *   分词差异，如「终止进程的命令引用了」vs「中包含主进程 PID 文件引用和终止进程操作」），
 *   只锚该规则独有的特征子串。守卫文案改动若触及特征片段 → 测试红 → 指纹表同步同走 PR。
 * - 文案样本直接 import 守卫真实文案常量/函数（非手抄复制）——审视发现手抄样本与
 *   真实文案漂移导致「虚绿」（测试样本≠生产文案），改从源头引用杜绝。
 * - sleep 拦截在发射点已被 stripSleepMarkerIfPresent 剥前缀（circuit-breaker-helpers
 *   abortOnUnsafeBash），落账 reason 为剥前缀后的干净文案——sleep 分支按文案特征
 *   （「裸 sleep 会让搭档看到长时间静默黑盒」）识别，非前缀。
 * - V1 兜底链（checkWhenMainPidMissing）复用 kill 族文案——按文案指纹自然归类。
 * - 命令结构层与脚本体层的文案差异（#1207/#1240 一体两面）暂不分 sub-ruleId：
 *   hasWorktreePath + commandHead 落账字段已携带该维度，聚合时可区分。
 */

/** 宪法分层（守卫规则的隐含分层显性化，第②步宪法文档消费） */
export type GuardRuleLayer = "self_kill" | "r1_gate" | "permission" | "habit" | "bypass_guard";

export interface GuardRuleClass {
  ruleId: string;
  layer: GuardRuleLayer;
}

/**
 * 指纹表：特征片段 → 分类。顺序即优先级。
 * 特征片段选取原则：足够长以唯一定位规则，足够短以容忍 V1/V2 文案分词差异。
 * 【维护契约】守卫改拦截文案时，若特征片段仍完整保留则无需动表；若特征片段被改，
 * 分类回归测试红——同步更新指纹与测试同走 PR。
 */
const FINGERPRINTS: ReadonlyArray<{ fragment: string; cls: GuardRuleClass }> = [
  // kill 0 是独立规则（V2 U1/#1169 进程组语义），优先于字面量主 PID（其文案含「kill」字样但特征不同）
  { fragment: "kill 0——信号将发送到当前进程组", cls: { ruleId: "self_kill_process_group", layer: "self_kill" } },
  { fragment: "针对主进程 PID 的终止命令", cls: { ruleId: "self_kill_literal", layer: "self_kill" } },
  // pidfile 两形态无长共同子串（V1「引用了主进程 PID 文件」vs V2「主进程 PID 文件引用和终止」），双指纹同 ruleId
  { fragment: "终止进程的命令引用了主进程 PID 文件", cls: { ruleId: "self_kill_pidfile", layer: "self_kill" } },
  { fragment: "主进程 PID 文件引用", cls: { ruleId: "self_kill_pidfile", layer: "self_kill" } },
  { fragment: "按名匹配的批量终止命令", cls: { ruleId: "self_kill_byname", layer: "self_kill" } },
  { fragment: "终止进程的目标为变量或命令替换", cls: { ruleId: "self_kill_nonliteral", layer: "self_kill" } },
  { fragment: "通过管道传入 shell 执行且包含终止进程操作", cls: { ruleId: "self_kill_pipe_shell", layer: "self_kill" } },
  { fragment: "通过脚本语言执行了终止进程操作", cls: { ruleId: "self_kill_script", layer: "self_kill" } },
  { fragment: "使用 eval 包装了含数字参数的操作", cls: { ruleId: "self_kill_eval", layer: "self_kill" } },
  { fragment: "otter-buddy.sh 解析到主仓", cls: { ruleId: "self_kill_script_stop", layer: "self_kill" } },
  { fragment: "otter-buddy.sh 引用与间接调用特征", cls: { ruleId: "self_kill_indirect", layer: "self_kill" } },
  // V2 U5（guard-model-judge.ts:362）：防绕过层——脚本文件执行未经守卫逐条判定
  { fragment: "从文件读取脚本执行", cls: { ruleId: "script_file_exec", layer: "bypass_guard" } },
  { fragment: "当前 bash 工作目录在主仓", cls: { ruleId: "main_write", layer: "r1_gate" } },
  { fragment: "主仓 data/", cls: { ruleId: "data_destructive", layer: "r1_gate" } },
  { fragment: "PR 合入是搭档专属动作", cls: { ruleId: "pr_merge", layer: "permission" } },
  // sleep 干净文案特征（发射点已剥 SLEEP_REASON_PREFIX，落账无前缀）
  { fragment: "裸 sleep 会让搭档看到长时间静默黑盒", cls: { ruleId: "sleep_block", layer: "habit" } },
];

/** 未映射兜底（守卫新增文案未同步指纹表时落此——聚合报表可见 unknown 占比，倒逼补表） */
export const UNKNOWN_RULE: GuardRuleClass = { ruleId: "unknown", layer: "self_kill" };

/**
 * 从拦截 reason 分类出 ruleId。
 *
 * @param rawReason - 守卫返回的拦截文案（可能带 withDiagnostics 追加的【命中详情】块、
 *                    appendDevServerGuidance 追加的【自有项目 dev server】块——均在首行之后）
 * @returns 分类结果（永不返回 null——unknown 兜底）
 */
export function classifyGuardInterceptReason(rawReason: string): GuardRuleClass {
  const head = (rawReason.trim().split("\n")[0] ?? rawReason).trim();
  for (const { fragment, cls } of FINGERPRINTS) {
    if (head.includes(fragment)) return cls;
  }
  return UNKNOWN_RULE;
}
