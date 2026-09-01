/**
 * F20260901cxmw：otter 实际模型 contextWindow 查询端口。
 *
 * Why: handoff 触发阈值需要按 otter 真实模型的 contextWindow 计算，
 * 而非一刀切 128k（F20260831hndp 遗留的 Phase 1 占位）。AgentInvoker 在
 * interface-adapters 层，不能直接依赖 frameworks 层的 ModelPool——参照
 * model-pool-like.ts 的窄接口模式，由 bootstrap 组装闭包注入。
 *
 * 同步签名有意为之（与 OtterConfigProvider.getConfig 一致，SQLite 同步驱动）。
 */

export interface OtterContextWindowProvider {
  /**
   * 解析 otter 实际模型的 contextWindow。
   * @returns 窗口大小（tokens）；无法解析时返回 undefined（调用方走 DEFAULT_CTX_MAX 兜底）
   */
  getOtterContextWindow(otterId: string): number | undefined;
}

/** 合理下限：小于此值的 contextWindow 视为配置异常，按 undefined 处理。
 * models-factory.ts 注释实锤「contextWindow 缺省时 SDK 视为 0」——0 是真实会发生的事，
 * 直接当窗口用会让 shouldCompact/阈值恒真（F20260808ctxw 同源教训）。 */
export const MIN_SENSIBLE_CTX_WINDOW = 8_000;
