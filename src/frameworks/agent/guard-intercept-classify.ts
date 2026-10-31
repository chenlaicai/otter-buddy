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
 * - sleep 拦截随 guard-v4 退役（F20261030gcfbx 删除其死指纹）：历史方案的发射点
 *   前缀剥离链（stripSleepMarkerIfPresent）仅剩兼容层，文案已零发射点；分类是
 *   拦截时点行为，无台账重分类路径，历史事件已按当时 ruleId 落库。
 * - v3 兼容链（V1/V2 文案分词差异/兜底链复用 kill 文案）随 #1702 清场消亡，v4 单一
 *   文案源无此问题——历史设计注记见 git 历史。
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
 * F20261030gcfbx（v4 对齐）：#1702 守卫重建清场 + #1711 guard-v4 重写后，v3 全部守卫文案
 * 发射点消亡——死指纹整体退役（main 表 22 条 → 9 条），只保留活通道（文件工具结构化
 * 前缀 + guard-v4 七条文案）。活文案清单（bash-safety-guard.ts，改动需同步）：
 * - MAIN_KILL_BLOCK_MSG / INDIRECT_KILL_BLOCK_MSG / PKILL_OTTER_BLOCK_MSG /
 *   BROADCAST_KILL_BLOCK_MSG（第一站杀进程判定，三查/PID 文件/stop 脚本共用 MAIN_KILL）
 * - 凭证目录 / 向非协作域名上传数据 / 「下载即执行」（第二站黑名单三类，内联文案）
 * ruleId 连续性：self_kill_nonliteral / self_kill_byname / self_kill_process_group /
 * network_exfil 复用旧 id（语义未变，healing 历史聚合连续）；self_kill_main /
 * cred_dir_access / download_exec 为 v4 新机制新 id。
 * 层挂靠（检视 S2 处置）：cred_dir_access / network_exfil 挂 bypass_guard——凭证与
 * 数据不进獭上下文本身是守卫边界完整性（绕过面）；不挂 permission（该层语义是对外
 * 制度动作 pr_merge，v4 后无守卫拦截规则）——挂 bypass_guard 使 retry-policy 高危
 * 集合（self_kill/bypass_guard）覆盖两规则，3 连拦走中性化文案，不预判「大概率误拦」
 * 诱导放行凭证访问（#1360 §3.5 中性化理由）。
 * sleep_block 指纹已删（检视 S3 处置）：拦截本体随 v4 退役，兼容层只剩前缀剥离，
 * 文案零发射点；classify 无台账重分类路径（仅拦截时点分类），历史事件已按当时
 * ruleId 落库——保留无消费者。
 * 特征片段选取原则：足够长以唯一定位规则，足够短以容忍文案小改。
 * 【维护契约】守卫改拦截文案时，若特征片段仍完整保留则无需动表；若特征片段被改，
 * 分类回归测试红——同步更新指纹与测试同走 PR（宪法挂靠总表同步：
 * docs/designs/bash-guard-constitution.md 分层表右列）。
 */
const FINGERPRINTS: ReadonlyArray<{ fragment: string; cls: GuardRuleClass }> = [
  // 结构化前缀优先（file-tool-guard，非文案指纹通道，v4 未变）
  { fragment: "[file-tool-guard]", cls: { ruleId: "file-tool-guard", layer: "r1_gate" } },
  // ── 第一站：杀进程判定（4 条文案，bash-safety-guard.ts:185-210） ──
  // 三查命中（PID 相等/args 指纹/父进程）与 PID 文件引用、stop/restart 脚本直执共用 MAIN_KILL 文案
  { fragment: "目标命中主进程", cls: { ruleId: "self_kill_main", layer: "self_kill" } },
  // 非字面量 PID（变量/命令替换）：与旧 self_kill_nonliteral 同语义，复用 id 保持 healing 聚合连续
  { fragment: "无法静态确认是否主进程", cls: { ruleId: "self_kill_nonliteral", layer: "self_kill" } },
  // pkill/killall 按名匹配：与旧 self_kill_byname 同语义
  { fragment: "按名匹配会命中主进程", cls: { ruleId: "self_kill_byname", layer: "self_kill" } },
  // kill -1 / -- -PGID 广播/进程组：与旧 self_kill_process_group 同语义
  { fragment: "广播/进程组", cls: { ruleId: "self_kill_process_group", layer: "self_kill" } },
  // ── 第二站：黑名单三类（checkBlacklistStation 内联文案，bash-safety-guard.ts:386-392） ──
  // A 类凭证路径（ssh/gnupg/aws 三目录，读写都算）：新机制新 id，bypass_guard 层（检视 S2：
  // 凭证不进獭上下文是守卫边界完整性；不挂 permission——该层语义是对外制度动作，v4 后空）
  { fragment: "凭证目录", cls: { ruleId: "cred_dir_access", layer: "bypass_guard" } },
  // B 类外发：上传动词（POST/PUT 族）+ 域名非协作白名单；「目的不可静态校验」fail-closed 分支同文案；
  // 复用旧 network_exfil id（S5 密钥外发面语义未变）；层挂 bypass_guard 同 A 类理由
  { fragment: "向非协作域名上传数据", cls: { ruleId: "network_exfil", layer: "bypass_guard" } },
  // C 类下载即执行：管道进解释器 + 进程替换（bash <(curl …)）共一条文案，新 id，bypass_guard 层
  { fragment: "「下载即执行」", cls: { ruleId: "download_exec", layer: "bypass_guard" } },
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
  const structuredRule = rawReason.match(/ruleId=(file-tool-guard\/[a-z0-9-]+)/i)?.[1];
  if (structuredRule) return { ruleId: structuredRule, layer: "r1_gate" };
  const head = (rawReason.trim().split("\n")[0] ?? rawReason).trim();
  for (const { fragment, cls } of FINGERPRINTS) {
    if (head.includes(fragment)) return cls;
  }
  return UNKNOWN_RULE;
}
