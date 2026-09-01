/**
 * 信号注册表（Issue #399 单一真相源）
 *
 * 10 类信号定义与特性文档 F20260824rhib 信号注册表一一对应（snapshot_shift 为
 * Issue #645 新增——环比骤变检测；post_merge_fix_density 为 Issue #647 新增——
 * 合并后修复密度，实现在 post-merge-fix-density.ts）。
 * 检测器实现度分级：
 * - MVP 已实现：bug_recurrence / chain_stall / hotspot / behavior_defect / hotspot_imbalance
 * - Phase 1.5 待实现（数据源依赖）：eval_regression / intent_drop（intent 字段冷启动 0%）
 *   / review_debt（需 PR comment 数据判定是否走过对抗审视）
 */

export type SignalType =
  | "bug_recurrence"
  | "chain_stall"
  | "hotspot"
  | "behavior_defect"
  | "eval_regression"
  | "intent_drop"
  | "hotspot_imbalance"
  | "review_debt"
  | "snapshot_shift"
  | "post_merge_fix_density";

export type SignalSeverity = "critical" | "warning";

export interface SignalDefinition {
  type: SignalType;
  name: string;
  /** 触发规则（人类可读，与特性文档注册表一致） */
  triggerRule: string;
  severity: SignalSeverity;
  /** 建议动作 */
  suggestedAction: string;
  /** 实现状态 */
  implemented: boolean;
  /** 未实现原因（implemented=false 时） */
  pendingReason?: string;
}

/** 信号注册表：新增/修改信号只改这里 */
export const SIGNAL_REGISTRY: Readonly<Record<SignalType, SignalDefinition>> = {
  bug_recurrence: {
    type: "bug_recurrence",
    name: "bug 反复出现",
    triggerRule: "同模块同文件 bugfix ≥3 次/30天",
    severity: "critical",
    suggestedAction: "强制根因分析",
    implemented: true,
  },
  chain_stall: {
    type: "chain_stall",
    name: "特性链滞留",
    triggerRule: "F-doc status∈{draft,proposed,design,development} 且 14 天无 commit",
    severity: "critical",
    suggestedAction: "链复盘",
    implemented: true,
  },
  hotspot: {
    type: "hotspot",
    name: "热点文件",
    triggerRule: "文件修改次数 > P95 或固定阈值",
    severity: "warning",
    suggestedAction: "架构审视",
    implemented: true,
  },
  behavior_defect: {
    type: "behavior_defect",
    name: "行为缺陷",
    // Issue #645 窗口化升级：原「同一 errorType healing event 复发」为全量聚合无窗口——
    // degenerate 57 次/12 天（healing 库最高频）会永久占用警报位，失去「最近在恶化」的语义。
    triggerRule: "同一 errorType healing event 7 天窗口内 ≥3 次",
    severity: "warning",
    suggestedAction: "prompt/skill 修订",
    implemented: true,
  },
  snapshot_shift: {
    type: "snapshot_shift",
    name: "健康分环比骤变",
    triggerRule: "五维/综合健康分单日 |Δ|≥10（相邻两日 health_snapshots 快照 diff，null 维度跳过）",
    severity: "warning",
    suggestedAction: "深挖当日快照 diff：逐维度核对上升/下降因子",
    implemented: true,
  },
  post_merge_fix_density: {
    type: "post_merge_fix_density",
    name: "合并后修复密度",
    // Issue #647：分档与排除清单口径见 post-merge-fix-density.ts 头注释（分档按链文件数实测校准）
    triggerRule: "特性合入后窗口期（小修 14 天/大特性 30 天，按链触碰文件数分档）内，触碰链文件的 bugfix ≥3 次或占比 ≥30%（高扇入文件 ≥10 特性触碰进排除清单）",
    severity: "warning",
    suggestedAction: "链复盘：核对合入范围是否消化完毕（「特性不对劲」是待查证不是定罪）",
    implemented: true,
  },
  eval_regression: {
    type: "eval_regression",
    name: "效果回退",
    triggerRule: "verify_by 达标后又恶化",
    severity: "warning",
    suggestedAction: "触发回验",
    implemented: false,
    pendingReason: "intent.verify_by 字段冷启动（存量覆盖率 0%），待增量积累后启用",
  },
  intent_drop: {
    type: "intent_drop",
    name: "意图兑现率下降",
    triggerRule: "近 7 天 ❌+⚠️ 占比 > 阈值",
    severity: "warning",
    suggestedAction: "触发回验",
    implemented: false,
    pendingReason: "intent 字段冷启动（存量覆盖率 0%），待增量积累后启用",
  },
  hotspot_imbalance: {
    type: "hotspot_imbalance",
    name: "热区失衡",
    triggerRule: "bugfix:feature >2 持续 2 周",
    severity: "warning",
    suggestedAction: "重构立项",
    implemented: true,
  },
  review_debt: {
    type: "review_debt",
    name: "审视债务",
    triggerRule: "未走对抗审视 PR 占比上升",
    severity: "warning",
    suggestedAction: "提醒流程",
    implemented: false,
    pendingReason: "需 PR comment 数据判定对抗审视留痕，MVP 阶段 git log 无此信息",
  },
};
